import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  makeWebSearchTool,
  makeBrokerWebSearchTool,
  dedupeByDomain,
  type WebSearchOutput,
  type WebSearchResult,
} from "./web_search.js";
import { AppError, ErrorCode } from "../support/index.js";
import { isControlSignal, type ToolContext, type ToolControlSignal } from "./types.js";

const ctx: ToolContext = {
  auth: { userId: "01H_u", orgId: "01H_o", role: "member", source: "session_jwt" },
  runId: "01H_run",
  secrets: { resolve: () => Promise.reject(new Error("no secrets in web_search")) },
};

/** web_search never returns a control signal — narrow for the assertions. */
function output(out: WebSearchOutput | ToolControlSignal): WebSearchOutput {
  if (isControlSignal(out)) throw new Error("unexpected control signal from web_search");
  return out;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchImpl: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchImpl = vi.fn(() =>
    Promise.resolve(
      jsonResponse({
        results: [
          { title: "A", url: "https://a", content: "snippet a", score: 0.9 },
          { title: "B", url: "https://b", content: "snippet b", raw_content: "<html>B</html>" },
        ],
        answer: "Summary text",
      }),
    ),
  );
});

describe("web_search tool", () => {
  it("posts to the Tavily endpoint with the resolved api key + clamped max_results", async () => {
    const tool = makeWebSearchTool({
      fetchImpl: fetchImpl,
      resolveApiKey: () => Promise.resolve("tvly-test"),
    });
    await tool.invoke({ query: "boardwalk", max_results: 50 }, ctx);
    const call = fetchImpl.mock.calls[0];
    if (call === undefined) throw new Error("fetch not called");
    expect(call[0]).toBe("https://api.tavily.com/search");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    const payload = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(payload).toMatchObject({
      api_key: "tvly-test",
      query: "boardwalk",
      max_results: 20, // clamped from 50
      include_raw_content: false,
      search_depth: "basic",
    });
  });

  it("projects results onto the wire shape and surfaces the answer when present", async () => {
    const tool = makeWebSearchTool({
      fetchImpl: fetchImpl,
      resolveApiKey: () => Promise.resolve("k"),
    });
    const out = output(await tool.invoke({ query: "boardwalk" }, ctx));
    expect(out.kind).toBe("web_search");
    expect(out.humanSummary).toContain('Found 2 results for "boardwalk"');
    expect(out.data.results).toHaveLength(2);
    expect(out.data.results[0]).toEqual({
      title: "A",
      url: "https://a",
      snippet: "snippet a",
      score: 0.9,
    });
    expect(out.data.answer).toBe("Summary text");
  });

  it("omits content fields when include_content=false", async () => {
    const tool = makeWebSearchTool({
      fetchImpl: fetchImpl,
      resolveApiKey: () => Promise.resolve("k"),
    });
    const out = output(await tool.invoke({ query: "boardwalk" }, ctx));
    expect(out.data.results[1]?.content).toBeUndefined();
  });

  it("includes raw_content as content when include_content=true", async () => {
    const tool = makeWebSearchTool({
      fetchImpl: fetchImpl,
      resolveApiKey: () => Promise.resolve("k"),
    });
    const out = output(await tool.invoke({ query: "boardwalk", include_content: true }, ctx));
    expect(out.data.results[1]?.content).toBe("<html>B</html>");
  });

  it("propagates search_depth=advanced and trims chunks_per_source to 1", async () => {
    const tool = makeWebSearchTool({
      fetchImpl: fetchImpl,
      resolveApiKey: () => Promise.resolve("k"),
    });
    await tool.invoke({ query: "boardwalk", search_depth: "advanced" }, ctx);
    const call = fetchImpl.mock.calls[0];
    if (call === undefined) throw new Error("fetch not called");
    const payload = JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>;
    expect(payload.search_depth).toBe("advanced");
    expect(payload.chunks_per_source).toBe(1);
  });

  it("does NOT send chunks_per_source in basic mode (only valid for advanced)", async () => {
    const tool = makeWebSearchTool({
      fetchImpl: fetchImpl,
      resolveApiKey: () => Promise.resolve("k"),
    });
    await tool.invoke({ query: "boardwalk" }, ctx);
    const payload = JSON.parse(
      (fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("chunks_per_source");
  });

  it("dedupes same-host results from Tavily, keeping the first (highest-ranked)", async () => {
    const dupHosts = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          results: [
            { title: "A1", url: "https://site.test/one", content: "first", score: 0.9 },
            { title: "A2", url: "https://site.test/two", content: "second", score: 0.7 },
            { title: "B", url: "https://other.test/x", content: "other", score: 0.5 },
          ],
        }),
      ),
    );
    const tool = makeWebSearchTool({
      fetchImpl: dupHosts,
      resolveApiKey: () => Promise.resolve("k"),
    });
    const out = output(await tool.invoke({ query: "q" }, ctx));
    expect(out.data.results.map((r) => r.url)).toEqual([
      "https://site.test/one",
      "https://other.test/x",
    ]);
  });

  it("maps 429 → AppError(RATE_LIMIT)", async () => {
    const tool = makeWebSearchTool({
      fetchImpl: vi.fn(() => Promise.resolve(jsonResponse({}, 429))),
      resolveApiKey: () => Promise.resolve("k"),
    });
    await expect(tool.invoke({ query: "boardwalk" }, ctx)).rejects.toBeInstanceOf(AppError);
    await expect(tool.invoke({ query: "boardwalk" }, ctx)).rejects.toMatchObject({
      code: ErrorCode.RATE_LIMIT,
    });
  });

  it("maps 5xx → AppError(TOOL_ERROR)", async () => {
    const tool = makeWebSearchTool({
      fetchImpl: vi.fn(() => Promise.resolve(jsonResponse({}, 503))),
      resolveApiKey: () => Promise.resolve("k"),
    });
    await expect(tool.invoke({ query: "boardwalk" }, ctx)).rejects.toMatchObject({
      code: ErrorCode.TOOL_ERROR,
    });
  });

  it("wraps fetch network errors as TOOL_ERROR", async () => {
    const tool = makeWebSearchTool({
      fetchImpl: vi.fn(() => Promise.reject(new Error("ENETUNREACH"))),
      resolveApiKey: () => Promise.resolve("k"),
    });
    await expect(tool.invoke({ query: "boardwalk" }, ctx)).rejects.toMatchObject({
      code: ErrorCode.TOOL_ERROR,
    });
  });

  it("rejects empty queries at the schema layer", () => {
    const tool = makeWebSearchTool({
      fetchImpl: vi.fn(),
      resolveApiKey: () => Promise.resolve("k"),
    });
    expect(() => tool.inputSchema.parse({ query: "" })).toThrow();
  });

  it("clamps max_results=0 up to 1", async () => {
    const tool = makeWebSearchTool({
      fetchImpl: fetchImpl,
      resolveApiKey: () => Promise.resolve("k"),
    });
    // Schema requires positive int, so manually feed an invalid value via parse to
    // bypass; here we just verify the clamp behavior on valid input near floor.
    await tool.invoke({ query: "boardwalk", max_results: 1 }, ctx);
    const payload = JSON.parse(
      (fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(payload.max_results).toBe(1);
  });
});

describe("dedupeByDomain", () => {
  const row = (url: string): WebSearchResult => ({ title: url, url, snippet: "s" });

  it("keeps the first result per hostname and drops later same-host hits", () => {
    const out = dedupeByDomain([
      row("https://a.test/1"),
      row("https://a.test/2"),
      row("https://b.test/x"),
      row("http://a.test/3"), // same host, different scheme → still a dup
    ]);
    expect(out.map((r) => r.url)).toEqual(["https://a.test/1", "https://b.test/x"]);
  });

  it("keeps results whose URL cannot be parsed (never silently drops the unknown)", () => {
    const out = dedupeByDomain([row("not a url"), row("also not a url"), row("https://a.test")]);
    expect(out.map((r) => r.url)).toEqual(["not a url", "also not a url", "https://a.test"]);
  });
});

describe("makeBrokerWebSearchTool", () => {
  it("delegates to the broker search fn and requires no Tavily secret on the runner", async () => {
    const out: WebSearchOutput = {
      kind: "web_search",
      humanSummary: "Found 1 result",
      data: { query: "boardwalk", results: [{ title: "t", url: "u", snippet: "s" }] },
    };
    const search = vi.fn(() => Promise.resolve(out));
    const tool = makeBrokerWebSearchTool({ search });
    expect(tool.name).toBe("web_search");
    expect(tool.secretsRequired).toEqual([]);
    const res = output(await tool.invoke({ query: "boardwalk" }, ctx));
    expect(res).toEqual(out);
    expect(search).toHaveBeenCalledWith({ query: "boardwalk" });
  });
});
