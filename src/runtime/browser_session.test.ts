import { describe, expect, it, vi } from "vitest";
import {
  BrowserSessionManager,
  type BrowserBackend,
  type BrowserProcess,
  type McpToolResult,
  type SessionMcpCaller,
} from "./browser_session.js";

function proc(overrides: Partial<BrowserProcess> = {}): BrowserProcess {
  return {
    cdpUrl: "http://127.0.0.1:9222",
    mcpUrl: "http://localhost:9333/mcp",
    kill: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function text(t: string): McpToolResult {
  return { content: [{ type: "text", text: t }], isError: false };
}

/** A caller whose callTool routes by tool name to a canned result. */
function caller(routes: Record<string, McpToolResult>): SessionMcpCaller & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    callTool: vi.fn((name: string, args: Record<string, unknown>) => {
      calls.push([name, JSON.stringify(args)]);
      return Promise.resolve(routes[name] ?? text(""));
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeManager(
  opts: {
    backend?: Partial<BrowserBackend>;
    connect?: (url: string) => Promise<SessionMcpCaller>;
    writeArtifact?: ReturnType<typeof vi.fn>;
  } = {},
) {
  let n = 0;
  const backendProc = proc();
  const c = caller({});
  const connect = opts.connect ?? vi.fn().mockResolvedValue(c);
  const writeArtifact =
    opts.writeArtifact ??
    vi.fn().mockResolvedValue({ id: "art_1", name: "shot.png", url: "https://cdn/shot.png" });
  const manager = new BrowserSessionManager({
    backend: { launch: vi.fn().mockResolvedValue(backendProc), ...opts.backend },
    connect,
    writeArtifact,
    nextId: () => `s${String(++n)}`,
  });
  return { manager, backendProc, connect, writeArtifact };
}

describe("BrowserSessionManager.open", () => {
  it("launches, connects, and exposes the agent-facing http MCP ref", async () => {
    const { manager } = makeManager();
    const session = await manager.open({ startUrl: "https://example.com" });
    expect(session.id).toBe("s1");
    expect(manager.mcpRefFor(session)).toEqual({
      name: "browser-s1",
      transport: "http",
      url: "http://localhost:9333/mcp",
      // The arbitrary-JS tools are hidden from the agent (the program keeps them via its own client).
      excludeTools: ["browser_evaluate", "browser_run_code_unsafe"],
    });
  });

  it("kills the browser if the MCP client fails to connect", async () => {
    const backendProc = proc();
    const manager = new BrowserSessionManager({
      backend: { launch: vi.fn().mockResolvedValue(backendProc) },
      connect: vi.fn().mockRejectedValue(new Error("connect failed")),
      writeArtifact: vi.fn(),
      nextId: () => "s1",
    });
    await expect(manager.open()).rejects.toThrow(/connect failed/);
    expect(backendProc.kill).toHaveBeenCalled();
  });
});

describe("BrowserSession handle", () => {
  it("navigate calls browser_navigate", async () => {
    const c = caller({});
    const { manager } = makeManager({ connect: vi.fn().mockResolvedValue(c) });
    const s = await manager.open();
    await s.navigate("https://foo.test/");
    expect(c.calls).toContainEqual([
      "browser_navigate",
      JSON.stringify({ url: "https://foo.test/" }),
    ]);
  });

  it("url() parses the Page URL out of the a11y snapshot", async () => {
    const c = caller({
      browser_snapshot: text("### Page\n- Page URL: https://foo.test/x\n- Page Title: Foo"),
    });
    const { manager } = makeManager({ connect: vi.fn().mockResolvedValue(c) });
    const s = await manager.open();
    expect(await s.url()).toBe("https://foo.test/x");
    expect(await s.title()).toBe("Foo");
  });

  it("screenshot() stores the image block as an artifact and returns its ref", async () => {
    const c = caller({
      browser_take_screenshot: {
        content: [{ type: "image", data: "BASE64PNG", mimeType: "image/png" }],
        isError: false,
      },
    });
    const writeArtifact = vi
      .fn()
      .mockResolvedValue({ id: "art_9", name: "shot.png", url: "https://cdn/shot.png" });
    const { manager } = makeManager({ connect: vi.fn().mockResolvedValue(c), writeArtifact });
    const s = await manager.open();
    const ref = await s.screenshot();
    expect(ref.id).toBe("art_9");
    expect(writeArtifact).toHaveBeenCalledWith(
      expect.stringMatching(/^screenshot-s1-/),
      "image/png",
      "BASE64PNG",
      expect.objectContaining({ kind: "screenshot", session_id: "s1" }),
    );
  });

  it("eval() wraps the expression and JSON-parses the result", async () => {
    const c = caller({ browser_evaluate: text("42") });
    const { manager } = makeManager({ connect: vi.fn().mockResolvedValue(c) });
    const s = await manager.open();
    await expect(s.eval<number>("1 + 41")).resolves.toBe(42);
    expect(c.calls).toContainEqual([
      "browser_evaluate",
      JSON.stringify({ function: "() => (1 + 41)" }),
    ]);
  });

  it("surfaces a tool error", async () => {
    const c = caller({
      browser_navigate: { content: [{ type: "text", text: "boom" }], isError: true },
    });
    const { manager } = makeManager({ connect: vi.fn().mockResolvedValue(c) });
    const s = await manager.open();
    await expect(s.navigate("https://x")).rejects.toThrow(/browser navigate failed: boom/);
  });

  it("close() reaps the session (kills proc + closes caller); mcpRefFor is null after", async () => {
    const c = caller({});
    const { manager, backendProc } = makeManager({ connect: vi.fn().mockResolvedValue(c) });
    const s = await manager.open();
    await s.close();
    expect(backendProc.kill).toHaveBeenCalled();
    expect(c.close).toHaveBeenCalled();
    expect(manager.mcpRefFor(s)).toBeNull();
    // closing/using again is safe / rejects clearly.
    await s.close();
    await expect(s.navigate("https://x")).rejects.toThrow(/closed/);
  });
});

describe("BrowserSessionManager.closeAll", () => {
  it("reaps every open session", async () => {
    const p1 = proc();
    const p2 = proc();
    let i = 0;
    const procs = [p1, p2];
    const manager = new BrowserSessionManager({
      backend: { launch: vi.fn(() => Promise.resolve(procs[i++]!)) },
      connect: vi.fn(() => Promise.resolve(caller({}))),
      writeArtifact: vi.fn(),
      nextId: () => `s${String(i)}`,
    });
    await manager.open();
    await manager.open();
    await manager.closeAll();
    expect(p1.kill).toHaveBeenCalled();
    expect(p2.kill).toHaveBeenCalled();
  });
});
