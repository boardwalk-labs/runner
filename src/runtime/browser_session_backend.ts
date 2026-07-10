// Production seams for the browser tier — the guest-coupled halves of browser_session.ts's injected
// contracts: the `BrowserBackend` (spawn a program-owned CDP Chromium on the guest display + a
// per-session Playwright MCP HTTP server attached to it) and the program's MCP client factory
// (`connectSessionMcp`). See docs/COMPUTER_USE_SESSION.md.
//
// These only run where the runner IMAGE ships the browser stack (Chromium + a pre-installed
// Playwright MCP + an X display). The composition root gates on `browserTierEnabled(env)` and only
// constructs a BrowserSessionManager with this backend when the image opts in — elsewhere
// `computer.openBrowser()` fails with a clear "not available on this runner image".
//
// Config proven against Playwright MCP 0.0.77 (spike, 2026-07-09):
//   - HTTP mode (`--port`) + `--cdp-endpoint` attach + a StreamableHTTP client all work.
//   - The agent's + the program's MCP URL MUST use `localhost` (not 127.0.0.1): the `/mcp` endpoint
//     enforces a literal `localhost` Host as DNS-rebinding protection, and `--allowed-hosts '*'`
//     does NOT lift it. So `mcpUrl` is built with `localhost`; the engine binds the same ref.
//   - Agent-facing refs exclude arbitrary-JS tools, while the trusted program retains its direct
//     MCP channel for `session.eval()`.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { BrowserSessionOptions } from "@boardwalk-labs/workflow/runtime";
import type {
  BrowserBackend,
  BrowserProcess,
  McpContentBlock,
  McpToolResult,
  SessionMcpCaller,
} from "./browser_session.js";
import { AppError, ErrorCode, createLogger } from "./support/index.js";

const log = createLogger("browser_backend");

/**
 * The guest-image contract for the browser tier — the values the runner image sets so this
 * backend can launch Chromium + Playwright MCP without any network fetch (the run's egress is proxied,
 * so a runtime `npx` download would fail). All but `chromePath` have safe defaults.
 */
export interface GuestBrowserConfig {
  /** Absolute path to the Chromium/Chrome binary the image ships (BOARDWALK_BROWSER_CHROME_PATH). */
  chromePath: string;
  /** X display Chromium renders on (headful, so the desktop tier can mirror it). DISPLAY, default ":0". */
  display: string;
  /** How to launch the PRE-INSTALLED Playwright MCP. The per-session flags (--port/--cdp-endpoint/
   *  --config) are appended. Default runs the pinned package via npx with fetching disabled. */
  mcpCommand: string;
  mcpBaseArgs: readonly string[];
  /** Milliseconds to wait for Chromium's CDP endpoint / the MCP server to answer before failing. */
  readyTimeoutMs: number;
}

const DEFAULT_MCP_PACKAGE = "@playwright/mcp@0.0.77";

/** True when the runner image declares the browser stack present (BOARDWALK_BROWSER_TIER=1). */
export function browserTierEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.BOARDWALK_BROWSER_TIER === "1";
}

/** Read the guest browser config from env, or null when the tier is disabled / no Chrome path is set. */
export function loadGuestBrowserConfig(env: NodeJS.ProcessEnv): GuestBrowserConfig | null {
  if (!browserTierEnabled(env)) return null;
  const chromePath = env.BOARDWALK_BROWSER_CHROME_PATH?.trim();
  if (chromePath === undefined || chromePath.length === 0) {
    log.warn("browser_tier_missing_chrome_path");
    return null;
  }
  // A custom command (a direct bin) takes no npx prefix; the default is `npx --no-install <pkg>`.
  const command = env.BOARDWALK_BROWSER_MCP_COMMAND?.trim();
  const baseArgs =
    command === undefined || command.length === 0
      ? ["--yes", "--no-install", env.BOARDWALK_BROWSER_MCP_PACKAGE?.trim() || DEFAULT_MCP_PACKAGE]
      : (env.BOARDWALK_BROWSER_MCP_ARGS ?? "").split(/\s+/).filter((a) => a.length > 0);
  const timeout = Number(env.BOARDWALK_BROWSER_READY_TIMEOUT_MS);
  return {
    chromePath,
    display: env.DISPLAY?.trim() || ":0",
    mcpCommand: command !== undefined && command.length > 0 ? command : "npx",
    mcpBaseArgs: baseArgs,
    readyTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 30_000,
  };
}

/** Bind an ephemeral port, read it, release it — then hand it to the child. A tiny TOCTOU window, but
 *  each run owns its VM/container so nothing else competes for the loopback port. */
export async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close(() => reject(new Error("could not allocate a port")));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

/** Poll an HTTP URL until it answers (any status < 500 counts as "up" — Playwright MCP's localhost
 *  guard returns 403 to a bare GET, which still proves the server is listening). */
export async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
      lastErr = `status ${String(res.status)}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await delay(200);
  }
  throw new AppError(
    ErrorCode.INTERNAL_ERROR,
    `browser backend: ${url} never came up (${lastErr})`,
    {
      kind: "browser_backend_timeout",
    },
  );
}

function killProc(proc: ChildProcess): void {
  try {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  } catch {
    // best-effort: a dead child must not throw out of teardown.
  }
}

/**
 * Build the production BrowserBackend. Each `launch` allocates two loopback ports, spawns a
 * program-owned Chromium (CDP endpoint, headful on the guest display, isolated profile) and a
 * per-session Playwright MCP HTTP server attached to it, waits for both to answer, and returns the
 * handle the manager wraps. On any failure it tears down everything it started (no leaked processes /
 * temp profiles).
 */
export function makeGuestBrowserBackend(cfg: GuestBrowserConfig): BrowserBackend {
  return {
    async launch(opts: BrowserSessionOptions | undefined): Promise<BrowserProcess> {
      const cdpPort = await freePort();
      const mcpPort = await freePort();
      const profileDir = await mkdtemp(join(tmpdir(), "bw-browser-"));
      const cdpUrl = `http://127.0.0.1:${String(cdpPort)}`;
      // localhost (NOT 127.0.0.1) — the Playwright MCP /mcp endpoint rejects any other Host (spike).
      const mcpUrl = `http://localhost:${String(mcpPort)}/mcp`;
      const started: ChildProcess[] = [];
      const cleanup = async (): Promise<void> => {
        for (const p of started) killProc(p);
        await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
      };
      try {
        // 1) Program-owned Chromium with a CDP endpoint, headful on the guest display so the desktop
        //    tier + recording can mirror it. The isolated profile dir is this session's alone.
        const chrome = spawn(
          cfg.chromePath,
          [
            `--remote-debugging-port=${String(cdpPort)}`,
            `--user-data-dir=${profileDir}`,
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-features=Translate",
            ...(opts?.startUrl !== undefined ? [opts.startUrl] : ["about:blank"]),
          ],
          { stdio: "ignore", env: { ...process.env, DISPLAY: cfg.display } },
        );
        started.push(chrome);
        chrome.once("error", (err) => {
          log.error("browser_chrome_spawn_error", { error: err.message });
        });
        await waitForHttp(`${cdpUrl}/json/version`, cfg.readyTimeoutMs);

        // 2) Per-session Playwright MCP in HTTP mode, attached to the CDP browser. `sharedBrowserContext`
        //    so the program's client and the agent's engine connection drive the SAME browser context.
        const configPath = join(profileDir, "pw-mcp.json");
        await writeFile(
          configPath,
          JSON.stringify({ capabilities: ["core"], sharedBrowserContext: true }),
        );
        const mcp = spawn(
          cfg.mcpCommand,
          [
            ...cfg.mcpBaseArgs,
            "--port",
            String(mcpPort),
            "--host",
            "127.0.0.1",
            // Only loopback clients exist inside the VM; disable the DNS-rebinding host list (the
            // literal-localhost guard on /mcp still applies, which is why mcpUrl uses `localhost`).
            "--allowed-hosts",
            "*",
            "--cdp-endpoint",
            cdpUrl,
            "--config",
            configPath,
          ],
          { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, DISPLAY: cfg.display } },
        );
        started.push(mcp);
        mcp.once("error", (err) => {
          log.error("browser_mcp_spawn_error", { error: err.message });
        });
        await waitForHttp(`http://127.0.0.1:${String(mcpPort)}/mcp`, cfg.readyTimeoutMs);

        let killed = false;
        return {
          cdpUrl,
          mcpUrl,
          kill: async (): Promise<void> => {
            if (killed) return;
            killed = true;
            await cleanup();
          },
        };
      } catch (err) {
        await cleanup();
        throw err;
      }
    },
  };
}

/** Adapt one MCP tool-result content block (the SDK's loose shape) to the subset browser_session.ts reads. */
export function toContentBlock(block: unknown): McpContentBlock {
  if (block === null || typeof block !== "object") return { type: "unknown" };
  const b = block as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
  const out: McpContentBlock = { type: typeof b.type === "string" ? b.type : "unknown" };
  if (typeof b.text === "string") out.text = b.text;
  if (typeof b.data === "string") out.data = b.data;
  if (typeof b.mimeType === "string") out.mimeType = b.mimeType;
  return out;
}

/**
 * The program's MCP client factory: open a StreamableHTTP client to a session's Playwright MCP server
 * (the trusted PROGRAM's channel, distinct from the engine's separate connection the AGENT uses). Wraps
 * the SDK Client behind the manager's `SessionMcpCaller` seam. `mcpUrl` must be the `localhost` form.
 */
export async function connectSessionMcp(mcpUrl: string): Promise<SessionMcpCaller> {
  const client = new Client({ name: "boardwalk-runner", version: "1" });
  // The SDK's concrete transport types `sessionId` as `string | undefined`, which trips our
  // exactOptionalPropertyTypes against the `Transport` interface's optional `sessionId?`. Cast at
  // this one seam — a pure type-strictness artifact, not a runtime mismatch.
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl)) as Transport;
  await client.connect(transport);
  return {
    callTool: async (name: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const result = await client.callTool({ name, arguments: args });
      const content = Array.isArray(result.content) ? result.content.map(toContentBlock) : [];
      return { content, isError: result.isError === true };
    },
    close: async (): Promise<void> => {
      await client.close();
    },
  };
}
