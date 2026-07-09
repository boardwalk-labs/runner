import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  browserTierEnabled,
  connectSessionMcp,
  freePort,
  loadGuestBrowserConfig,
  toContentBlock,
  waitForHttp,
} from "./browser_session_backend.js";

describe("browserTierEnabled", () => {
  it("is true only for the literal '1'", () => {
    expect(browserTierEnabled({ BOARDWALK_BROWSER_TIER: "1" })).toBe(true);
    expect(browserTierEnabled({ BOARDWALK_BROWSER_TIER: "0" })).toBe(false);
    expect(browserTierEnabled({ BOARDWALK_BROWSER_TIER: "true" })).toBe(false);
    expect(browserTierEnabled({})).toBe(false);
  });
});

describe("loadGuestBrowserConfig", () => {
  it("returns null when the tier is disabled", () => {
    expect(loadGuestBrowserConfig({})).toBeNull();
    expect(loadGuestBrowserConfig({ BOARDWALK_BROWSER_CHROME_PATH: "/x/chrome" })).toBeNull();
  });

  it("returns null when enabled but no chrome path is set", () => {
    expect(loadGuestBrowserConfig({ BOARDWALK_BROWSER_TIER: "1" })).toBeNull();
    expect(
      loadGuestBrowserConfig({ BOARDWALK_BROWSER_TIER: "1", BOARDWALK_BROWSER_CHROME_PATH: "  " }),
    ).toBeNull();
  });

  it("applies defaults (npx launcher, DISPLAY :0, 30s timeout)", () => {
    const cfg = loadGuestBrowserConfig({
      BOARDWALK_BROWSER_TIER: "1",
      BOARDWALK_BROWSER_CHROME_PATH: "/opt/chrome",
    });
    expect(cfg).toEqual({
      chromePath: "/opt/chrome",
      display: ":0",
      mcpCommand: "npx",
      mcpBaseArgs: ["--yes", "--no-install", "@playwright/mcp@0.0.77"],
      readyTimeoutMs: 30_000,
    });
  });

  it("honors a custom display, package, and timeout", () => {
    const cfg = loadGuestBrowserConfig({
      BOARDWALK_BROWSER_TIER: "1",
      BOARDWALK_BROWSER_CHROME_PATH: "/opt/chrome",
      DISPLAY: ":9",
      BOARDWALK_BROWSER_MCP_PACKAGE: "@playwright/mcp@0.0.80",
      BOARDWALK_BROWSER_READY_TIMEOUT_MS: "5000",
    });
    expect(cfg?.display).toBe(":9");
    expect(cfg?.mcpBaseArgs).toEqual(["--yes", "--no-install", "@playwright/mcp@0.0.80"]);
    expect(cfg?.readyTimeoutMs).toBe(5000);
  });

  it("a custom command takes its own args and no npx prefix", () => {
    const cfg = loadGuestBrowserConfig({
      BOARDWALK_BROWSER_TIER: "1",
      BOARDWALK_BROWSER_CHROME_PATH: "/opt/chrome",
      BOARDWALK_BROWSER_MCP_COMMAND: "/usr/local/bin/pw-mcp",
      BOARDWALK_BROWSER_MCP_ARGS: "--foo  --bar",
    });
    expect(cfg?.mcpCommand).toBe("/usr/local/bin/pw-mcp");
    expect(cfg?.mcpBaseArgs).toEqual(["--foo", "--bar"]);
  });

  it("falls back to the default timeout when the env value is not a positive number", () => {
    const cfg = loadGuestBrowserConfig({
      BOARDWALK_BROWSER_TIER: "1",
      BOARDWALK_BROWSER_CHROME_PATH: "/opt/chrome",
      BOARDWALK_BROWSER_READY_TIMEOUT_MS: "not-a-number",
    });
    expect(cfg?.readyTimeoutMs).toBe(30_000);
  });
});

describe("freePort", () => {
  it("returns a positive, bindable loopback port", async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65_536);
  });
});

describe("waitForHttp", () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("resolves once the server answers (even with a non-2xx status)", async () => {
    const port = await freePort();
    server = createServer((_req, res) => {
      res.statusCode = 403; // Playwright MCP's localhost guard answers a bare GET with 403 — still "up".
      res.end("nope");
    });
    await new Promise<void>((r) => server!.listen(port, "127.0.0.1", r));
    await expect(
      waitForHttp(`http://127.0.0.1:${String(port)}/mcp`, 2_000),
    ).resolves.toBeUndefined();
  });

  it("rejects with a clear timeout when nothing is listening", async () => {
    const port = await freePort(); // allocated then released — nothing is bound.
    await expect(waitForHttp(`http://127.0.0.1:${String(port)}/mcp`, 300)).rejects.toThrow(
      /never came up/,
    );
  });
});

describe("toContentBlock", () => {
  it("passes through text blocks", () => {
    expect(toContentBlock({ type: "text", text: "hello" })).toEqual({
      type: "text",
      text: "hello",
    });
  });

  it("passes through image blocks (base64 data + mime)", () => {
    expect(toContentBlock({ type: "image", data: "BASE64", mimeType: "image/png" })).toEqual({
      type: "image",
      data: "BASE64",
      mimeType: "image/png",
    });
  });

  it("drops non-string fields and defaults an unknown type", () => {
    expect(toContentBlock({ text: 42, data: null })).toEqual({ type: "unknown" });
    expect(toContentBlock(null)).toEqual({ type: "unknown" });
  });
});

describe("connectSessionMcp", () => {
  it("surfaces a clear error when the MCP server is unreachable", async () => {
    const port = await freePort(); // nothing is listening here.
    await expect(connectSessionMcp(`http://localhost:${String(port)}/mcp`)).rejects.toThrow();
  });
});
