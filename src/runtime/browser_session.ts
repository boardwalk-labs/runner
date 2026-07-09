// Browser-tier computer use — the runtime backing for `computer.openBrowser()` (the SDK surface)
// and `agent({ session })`. See docs/COMPUTER_USE_SESSION.md.
//
// A session is a program-owned, in-VM Chromium with a CDP endpoint, plus a per-session Playwright
// MCP HTTP server attached to that endpoint. The agent drives the browser through that MCP server
// (the ENGINE connects to it — binding a session is just adding its http MCP ref to the leaf's
// `mcp`, which passes assertHostedMcpAllowed unchanged since it's http + a valid localhost URL).
// The trusted PROGRAM drives/inspects the same browser through this module's own MCP client (the
// `BrowserSession` handle methods).
//
// The process spawn (Chromium + Playwright MCP, on the guest display) and the MCP client are behind
// injected seams (`BrowserBackend`, `SessionMcpCaller`) so the manager + handle logic is unit-tested
// without a guest; the production seams (browser_session_backend.ts) run against the guest image.

import type {
  ArtifactRef,
  BrowserSession,
  BrowserSessionOptions,
  McpServerRef,
} from "@boardwalk-labs/workflow/runtime";
import { AppError, ErrorCode } from "./support/index.js";

/** One MCP tool result content block (the subset we consume). */
export interface McpContentBlock {
  type: string;
  text?: string;
  /** base64 for `type: "image"`. */
  data?: string;
  mimeType?: string;
}

export interface McpToolResult {
  content: readonly McpContentBlock[];
  isError: boolean;
}

/** A live MCP client bound to one session's Playwright MCP server (the PROGRAM's channel). */
export interface SessionMcpCaller {
  callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolResult>;
  close: () => Promise<void>;
}

/** A launched browser process: the CDP endpoint + the Playwright MCP HTTP URL the agent binds to. */
export interface BrowserProcess {
  /** e.g. `http://127.0.0.1:9222` (program-internal, never exposed). */
  readonly cdpUrl: string;
  /** e.g. `http://127.0.0.1:9333/mcp` — the agent's MCP endpoint. */
  readonly mcpUrl: string;
  /** Terminate Chromium + the Playwright MCP server. Idempotent. */
  kill: () => Promise<void>;
}

/** Spawns Chromium (headful on the guest display) + a per-session Playwright MCP attached to it,
 *  with the arbitrary-JS tools (`browser_evaluate`, `browser_run_code_unsafe`) DISABLED for the
 *  agent — page-eval stays program-only. Production impl in browser_session_backend.ts. */
export interface BrowserBackend {
  launch: (opts: BrowserSessionOptions | undefined) => Promise<BrowserProcess>;
}

/** Store a captured screenshot as a run artifact; returns its ref (the same store `artifacts.write` uses). */
export type ScreenshotArtifactWriter = (
  name: string,
  contentType: string,
  base64: string,
  metadata: Record<string, unknown>,
) => Promise<ArtifactRef>;

export interface BrowserSessionManagerDeps {
  backend: BrowserBackend;
  /** Open the PROGRAM's MCP client to a session's Playwright MCP HTTP URL. */
  connect: (mcpUrl: string) => Promise<SessionMcpCaller>;
  writeArtifact: ScreenshotArtifactWriter;
  /** Monotonic session-id source (injected for determinism in tests). */
  nextId: () => string;
}

interface OpenSession {
  readonly handle: BrowserSession;
  readonly mcpRef: McpServerRef;
  readonly proc: BrowserProcess;
  readonly caller: SessionMcpCaller;
}

/**
 * Per-run manager of browser sessions. Opens them (spawn + connect + handle), resolves a session to
 * its agent-facing MCP ref for `agent({ session })` binding, and reaps every open session at run end.
 */
export class BrowserSessionManager {
  private readonly sessions = new Map<string, OpenSession>();

  constructor(private readonly deps: BrowserSessionManagerDeps) {}

  async open(opts?: BrowserSessionOptions): Promise<BrowserSession> {
    const id = this.deps.nextId();
    const proc = await this.deps.backend.launch(opts);
    let caller: SessionMcpCaller;
    try {
      caller = await this.deps.connect(proc.mcpUrl);
    } catch (err) {
      await proc.kill();
      throw err;
    }
    const mcpRef: McpServerRef = { name: `browser-${id}`, transport: "http", url: proc.mcpUrl };
    const handle = makeBrowserSessionHandle(id, caller, this.deps.writeArtifact, () =>
      this.reap(id),
    );
    this.sessions.set(id, { handle, mcpRef, proc, caller });
    return handle;
  }

  /** The agent-facing MCP ref for a session handle, or null if it isn't a live session of this run
   *  (e.g. already closed, or a foreign object). The host appends this to the leaf's `mcp`. */
  mcpRefFor(session: BrowserSession): McpServerRef | null {
    return this.sessions.get(session.id)?.mcpRef ?? null;
  }

  /** Tear down every still-open session. Called once when the run ends (best-effort per session). */
  async closeAll(): Promise<void> {
    const open = [...this.sessions.keys()];
    await Promise.allSettled(open.map((id) => this.reap(id)));
  }

  private async reap(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s === undefined) return;
    this.sessions.delete(id);
    // Close the client first (unblocks the server), then kill the processes. Both best-effort.
    await Promise.allSettled([s.caller.close(), s.proc.kill()]);
  }
}

/** Text of a tool result (all text blocks joined). */
function textOf(result: McpToolResult): string {
  return result.content
    .map((c) => (typeof c.text === "string" ? c.text : ""))
    .filter((t) => t.length > 0)
    .join("\n");
}

function assertOk(result: McpToolResult, tool: string): McpToolResult {
  if (result.isError) {
    throw new AppError(ErrorCode.INTERNAL_ERROR, `browser ${tool} failed: ${textOf(result)}`, {
      kind: "browser_tool_error",
      tool,
    });
  }
  return result;
}

/** Parse a single `Field: value` line out of a Playwright MCP `browser_snapshot` header. */
function fieldFromSnapshot(snapshot: string, field: string): string {
  const re = new RegExp(`^\\s*-?\\s*${field}:\\s*(.+)$`, "m");
  return re.exec(snapshot)?.[1]?.trim() ?? "";
}

function makeBrowserSessionHandle(
  id: string,
  caller: SessionMcpCaller,
  writeArtifact: ScreenshotArtifactWriter,
  onClose: () => Promise<void>,
): BrowserSession {
  const call = (name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> =>
    caller.callTool(name, args);
  let closed = false;
  const live = (): void => {
    if (closed) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, `browser session ${id} is closed`, {
        kind: "browser_session_closed",
      });
    }
  };

  return {
    id,
    async navigate(url: string): Promise<void> {
      live();
      assertOk(await call("browser_navigate", { url }), "navigate");
    },
    async url(): Promise<string> {
      live();
      return fieldFromSnapshot(
        textOf(assertOk(await call("browser_snapshot"), "snapshot")),
        "Page URL",
      );
    },
    async title(): Promise<string> {
      live();
      return fieldFromSnapshot(
        textOf(assertOk(await call("browser_snapshot"), "snapshot")),
        "Page Title",
      );
    },
    async screenshot(opts?: { fullPage?: boolean }): Promise<ArtifactRef> {
      live();
      const res = assertOk(
        await call("browser_take_screenshot", { fullPage: opts?.fullPage ?? false }),
        "screenshot",
      );
      const image = res.content.find((c) => c.type === "image" && typeof c.data === "string");
      if (image?.data === undefined) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, "browser screenshot returned no image", {
          kind: "browser_screenshot_no_image",
        });
      }
      return await writeArtifact(
        `screenshot-${id}-${Date.now().toString(36)}.png`,
        image.mimeType ?? "image/png",
        image.data,
        { kind: "screenshot", session_id: id },
      );
    },
    async console(): Promise<readonly ConsoleEntryOut[]> {
      live();
      return parseConsole(textOf(assertOk(await call("browser_console_messages"), "console")));
    },
    async network(): Promise<readonly NetworkEntryOut[]> {
      live();
      return parseNetwork(textOf(assertOk(await call("browser_network_requests"), "network")));
    },
    async eval<T = unknown>(expression: string): Promise<T> {
      live();
      // Playwright MCP's browser_evaluate takes a `function` (a JS arrow) — wrap the expression.
      const res = assertOk(
        await call("browser_evaluate", { function: `() => (${expression})` }),
        "eval",
      );
      const text = textOf(res).trim();
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await onClose();
    },
  };
}

// The SDK's ConsoleEntry / NetworkEntry, re-declared minimally for the parser output (best-effort;
// the exact Playwright-MCP text format is refined against a live guest — v1 keeps it lenient).
interface ConsoleEntryOut {
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  timestamp: number;
}
interface NetworkEntryOut {
  method: string;
  url: string;
  status?: number;
  timestamp: number;
}

const CONSOLE_LINE = /^\s*\[?(LOG|INFO|WARN(?:ING)?|ERROR|DEBUG)\]?\s*[:-]?\s*(.*)$/i;

function parseConsole(text: string): ConsoleEntryOut[] {
  const out: ConsoleEntryOut[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const m = CONSOLE_LINE.exec(line);
    const level = (m?.[1] ?? "log").toLowerCase();
    out.push({
      level: level.startsWith("warn")
        ? "warn"
        : ((["log", "info", "error", "debug"].includes(level)
            ? level
            : "log") as ConsoleEntryOut["level"]),
      text: m?.[2] ?? line.trim(),
      timestamp: 0,
    });
  }
  return out;
}

const NETWORK_LINE = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b\s+(\S+)(?:.*?\b(\d{3})\b)?/;

function parseNetwork(text: string): NetworkEntryOut[] {
  const out: NetworkEntryOut[] = [];
  for (const line of text.split("\n")) {
    const m = NETWORK_LINE.exec(line);
    if (m === null) continue;
    const entry: NetworkEntryOut = { method: m[1]!, url: m[2]!, timestamp: 0 };
    if (m[3] !== undefined) entry.status = Number(m[3]);
    out.push(entry);
  }
  return out;
}
