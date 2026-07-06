import { describe, it, expect } from "vitest";
import {
  buildBrokerToolHost,
  DEFAULT_FETCH_MAX_BYTES,
  htmlToText,
  type ToolHostBroker,
} from "./broker_tool_host.js";
import type {
  ArtifactSignResult,
  ArtifactStore,
  ArtifactSummary,
  ArtifactWriteInput,
  ArtifactWriteResult,
} from "./tools/artifacts.js";
import type { WebSearchInput, WebSearchOutput } from "./tools/web_search.js";

// ---- fakes -------------------------------------------------------------------------------

/** A recording broker: captures every call + replays canned responses. `signed`/`downloads` let a
 *  test assert the read-artifact path (sign → download), and `searches` the web_search forwarding. */
function fakeBroker(over: Partial<ToolHostBroker> = {}): {
  broker: ToolHostBroker;
  searches: WebSearchInput[];
  signed: { id: string; ttl: number }[];
  downloads: string[];
} {
  const searches: WebSearchInput[] = [];
  const signed: { id: string; ttl: number }[] = [];
  const downloads: string[] = [];
  const broker: ToolHostBroker = {
    webSearch: (input) => {
      searches.push(input);
      const out: WebSearchOutput = {
        kind: "web_search",
        humanSummary: "ok",
        data: {
          query: input.query,
          results: [
            { title: "First", url: "https://a.test", snippet: "snip a", score: 0.9 },
            { title: "Second", url: "https://b.test", snippet: "snip b" },
          ],
        },
      };
      return Promise.resolve(out);
    },
    signArtifactUrl: (artifactId, ttlSeconds) => {
      signed.push({ id: artifactId, ttl: ttlSeconds });
      return Promise.resolve({ signedUrl: `https://cdn/signed/${artifactId}`, expiresAt: 1 });
    },
    downloadBytes: (url) => {
      downloads.push(url);
      return Promise.resolve(new TextEncoder().encode("artifact bytes"));
    },
    ...over,
  };
  return { broker, searches, signed, downloads };
}

/** A minimal ArtifactStore that records writes + serves a canned list. */
function fakeArtifacts(over: Partial<ArtifactStore> = {}): {
  artifacts: ArtifactStore;
  writes: ArtifactWriteInput[];
} {
  const writes: ArtifactWriteInput[] = [];
  const artifacts: ArtifactStore = {
    write: (input): Promise<ArtifactWriteResult> => {
      writes.push(input);
      return Promise.resolve({
        id: "art_1",
        name: input.name,
        sizeBytes: 7,
        signedUrl: "https://cdn/art_1",
        expiresAt: 9,
      });
    },
    list: (): Promise<ArtifactSummary[]> =>
      Promise.resolve([
        {
          id: "old",
          name: "report.md",
          contentType: "text/markdown",
          sizeBytes: 1,
          createdAt: 100,
        },
        {
          id: "new",
          name: "report.md",
          contentType: "text/markdown",
          sizeBytes: 2,
          createdAt: 200,
        },
        {
          id: "other",
          name: "data.json",
          contentType: "application/json",
          sizeBytes: 3,
          createdAt: 5,
        },
      ]),
    signedUrl: (_id, _ttl): Promise<ArtifactSignResult> =>
      Promise.resolve({ signedUrl: "https://cdn/x", expiresAt: 1 }),
    ...over,
  };
  return { artifacts, writes };
}

/** A fetch stub that returns a streamed body of `text` with the given status/content-type. */
function fetchReturning(
  text: string,
  init?: { status?: number; contentType?: string },
): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = ((input: Parameters<typeof fetch>[0]): Promise<Response> => {
    calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers();
    if (init?.contentType !== undefined) headers.set("content-type", init.contentType);
    return Promise.resolve(
      new Response(new TextEncoder().encode(text), { status: init?.status ?? 200, headers }),
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}

// ---- web_search --------------------------------------------------------------------------

describe("BrokerToolHost.webSearch", () => {
  it("forwards the query to the broker and maps result rows to title/url/snippet", async () => {
    const { broker, searches } = fakeBroker();
    const { artifacts } = fakeArtifacts();
    const host = buildBrokerToolHost({ broker, artifacts });
    if (host.webSearch === undefined) throw new Error("webSearch not wired");

    const results = await host.webSearch("how do tides work");

    expect(searches).toEqual([{ query: "how do tides work" }]);
    expect(results).toEqual([
      { title: "First", url: "https://a.test", snippet: "snip a" },
      { title: "Second", url: "https://b.test", snippet: "snip b" },
    ]);
  });

  it("maps the engine's `limit` onto the domain tool's `max_results`", async () => {
    const { broker, searches } = fakeBroker();
    const { artifacts } = fakeArtifacts();
    const host = buildBrokerToolHost({ broker, artifacts });
    if (host.webSearch === undefined) throw new Error("webSearch not wired");

    await host.webSearch("q", { limit: 3 });

    expect(searches).toEqual([{ query: "q", max_results: 3 }]);
  });
});

// ---- artifacts ---------------------------------------------------------------------------

describe("BrokerToolHost.writeArtifact", () => {
  it("delegates to the artifact store (utf8) and returns the engine {id, name, url} shape", async () => {
    const { broker } = fakeBroker();
    const { artifacts, writes } = fakeArtifacts();
    const host = buildBrokerToolHost({ broker, artifacts });
    if (host.writeArtifact === undefined) throw new Error("writeArtifact not wired");

    const ref = await host.writeArtifact("notes.txt", "text/plain", "hello", { run: "r1" });

    expect(writes).toEqual([
      {
        name: "notes.txt",
        contentType: "text/plain",
        body: "hello",
        encoding: "utf8",
        metadata: { run: "r1" },
      },
    ]);
    expect(ref).toEqual({ id: "art_1", name: "notes.txt", url: "https://cdn/art_1" });
  });

  it("omits metadata when none is supplied", async () => {
    const { broker } = fakeBroker();
    const { artifacts, writes } = fakeArtifacts();
    const host = buildBrokerToolHost({ broker, artifacts });
    if (host.writeArtifact === undefined) throw new Error("writeArtifact not wired");

    await host.writeArtifact("a.txt", "text/plain", "x");

    expect(writes[0]).toEqual({
      name: "a.txt",
      contentType: "text/plain",
      body: "x",
      encoding: "utf8",
    });
  });
});

describe("BrokerToolHost.readArtifact", () => {
  it("finds the NEWEST artifact by name, signs a short-lived URL, and returns the downloaded text", async () => {
    const { broker, signed, downloads } = fakeBroker();
    const { artifacts } = fakeArtifacts();
    const host = buildBrokerToolHost({ broker, artifacts });
    if (host.readArtifact === undefined) throw new Error("readArtifact not wired");

    const text = await host.readArtifact("report.md");

    // The two "report.md" rows resolve to the newer (createdAt 200 ⇒ id "new").
    expect(signed).toEqual([{ id: "new", ttl: 60 }]);
    expect(downloads).toEqual(["https://cdn/signed/new"]);
    expect(text).toBe("artifact bytes");
  });

  it("throws when the named artifact does not exist in this run", async () => {
    const { broker } = fakeBroker();
    const { artifacts } = fakeArtifacts();
    const host = buildBrokerToolHost({ broker, artifacts });
    if (host.readArtifact === undefined) throw new Error("readArtifact not wired");

    await expect(host.readArtifact("missing.txt")).rejects.toThrow(/not found/);
  });

  it("throws when the bytes can't be downloaded (broker returns null)", async () => {
    const { broker } = fakeBroker({ downloadBytes: () => Promise.resolve(null) });
    const { artifacts } = fakeArtifacts();
    const host = buildBrokerToolHost({ broker, artifacts });
    if (host.readArtifact === undefined) throw new Error("readArtifact not wired");

    await expect(host.readArtifact("report.md")).rejects.toThrow(/could not be downloaded/);
  });
});

// ---- webfetch ----------------------------------------------------------------------------

describe("BrokerToolHost.fetchUrl", () => {
  it("extracts readable text from HTML and returns the engine FetchResult shape", async () => {
    const { broker } = fakeBroker();
    const { artifacts } = fakeArtifacts();
    const { fetchImpl, calls } = fetchReturning(
      "<html><head><style>x{}</style></head><body><script>evil()</script><h1>Title</h1><p>Body &amp; more</p></body></html>",
      { contentType: "text/html; charset=utf-8" },
    );
    const host = buildBrokerToolHost({ broker, artifacts, fetchImpl });
    if (host.fetchUrl === undefined) throw new Error("fetchUrl not wired");

    const res = await host.fetchUrl("https://example.test/page");

    expect(calls).toEqual(["https://example.test/page"]);
    expect(res.status).toBe(200);
    expect(res.contentType).toBe("text/html; charset=utf-8");
    // Script + style dropped, tags stripped, entity decoded — not raw HTML.
    expect(res.body).not.toContain("evil()");
    expect(res.body).not.toContain("x{}");
    expect(res.body).not.toContain("<");
    expect(res.body).toContain("Title");
    expect(res.body).toContain("Body & more");
    expect(res.truncated).toBe(false);
  });

  it("caps extracted content at the content-char cap and flags truncation", async () => {
    const { broker } = fakeBroker();
    const { artifacts } = fakeArtifacts();
    const { fetchImpl } = fetchReturning("a".repeat(200), { contentType: "text/plain" });
    const host = buildBrokerToolHost({ broker, artifacts, fetchImpl, maxFetchContentChars: 50 });
    if (host.fetchUrl === undefined) throw new Error("fetchUrl not wired");

    const res = await host.fetchUrl("https://example.test/long");

    expect(res.body).toBe("a".repeat(50));
    expect(res.truncated).toBe(true);
  });

  it("passes non-HTML content through unextracted (JSON keeps its angle brackets)", async () => {
    const { broker } = fakeBroker();
    const { artifacts } = fakeArtifacts();
    const json = '{"a": "<b>not html</b>"}';
    const { fetchImpl } = fetchReturning(json, { contentType: "application/json" });
    const host = buildBrokerToolHost({ broker, artifacts, fetchImpl });
    if (host.fetchUrl === undefined) throw new Error("fetchUrl not wired");

    const res = await host.fetchUrl("https://example.test/data.json");

    expect(res.body).toBe(json);
    expect(res.truncated).toBe(false);
  });

  it("rejects a non-http(s) scheme (file:, data:, …) before any fetch", async () => {
    const { broker } = fakeBroker();
    const { artifacts } = fakeArtifacts();
    const { fetchImpl, calls } = fetchReturning("secret");
    const host = buildBrokerToolHost({ broker, artifacts, fetchImpl });
    if (host.fetchUrl === undefined) throw new Error("fetchUrl not wired");

    await expect(host.fetchUrl("file:///etc/passwd")).rejects.toThrow(/only http\(s\)/);
    await expect(host.fetchUrl("data:text/plain,hello")).rejects.toThrow(/only http\(s\)/);
    expect(calls).toEqual([]); // never reached fetch
  });

  it("rejects a malformed URL", async () => {
    const { broker } = fakeBroker();
    const { artifacts } = fakeArtifacts();
    const host = buildBrokerToolHost({ broker, artifacts });
    if (host.fetchUrl === undefined) throw new Error("fetchUrl not wired");

    await expect(host.fetchUrl("not a url")).rejects.toThrow(/invalid URL/);
  });

  it("caps the response body at maxBytes and flags it truncated", async () => {
    const { broker } = fakeBroker();
    const { artifacts } = fakeArtifacts();
    const { fetchImpl } = fetchReturning("0123456789", { contentType: "text/plain" });
    const host = buildBrokerToolHost({ broker, artifacts, fetchImpl, maxFetchBytes: 4 });
    if (host.fetchUrl === undefined) throw new Error("fetchUrl not wired");

    const res = await host.fetchUrl("https://example.test/big");

    expect(res.body).toBe("0123");
    expect(res.truncated).toBe(true);
  });

  it("honors a per-call maxBytes over the default cap", async () => {
    const { broker } = fakeBroker();
    const { artifacts } = fakeArtifacts();
    const { fetchImpl } = fetchReturning("abcdefgh");
    const host = buildBrokerToolHost({ broker, artifacts, fetchImpl, maxFetchBytes: 100 });
    if (host.fetchUrl === undefined) throw new Error("fetchUrl not wired");

    const res = await host.fetchUrl("https://example.test/x", { maxBytes: 3 });

    expect(res.body).toBe("abc");
    expect(res.truncated).toBe(true);
  });

  it("returns the whole body (not truncated) when under the cap", async () => {
    const { broker } = fakeBroker();
    const { artifacts } = fakeArtifacts();
    const { fetchImpl } = fetchReturning("short");
    const host = buildBrokerToolHost({
      broker,
      artifacts,
      fetchImpl,
      maxFetchBytes: DEFAULT_FETCH_MAX_BYTES,
    });
    if (host.fetchUrl === undefined) throw new Error("fetchUrl not wired");

    const res = await host.fetchUrl("http://example.test/small");

    expect(res.body).toBe("short");
    expect(res.truncated).toBe(false);
  });
});

// ---- http ---------------------------------------------------------------------------------

/** A fetch stub that records the full RequestInit (method/headers/body), returning `text`. */
function fetchCapturing(
  text: string,
  init?: { status?: number; contentType?: string },
): { fetchImpl: typeof fetch; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = ((
    input: Parameters<typeof fetch>[0],
    reqInit?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: reqInit });
    const headers = new Headers();
    if (init?.contentType !== undefined) headers.set("content-type", init.contentType);
    return Promise.resolve(
      new Response(new TextEncoder().encode(text), { status: init?.status ?? 200, headers }),
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("BrokerToolHost.httpRequest", () => {
  it("forwards method/headers/body and returns the RAW response (no HTML extraction)", async () => {
    const { broker } = fakeBroker();
    const { artifacts } = fakeArtifacts();
    const { fetchImpl, calls } = fetchCapturing("<h1>raw &amp; uncut</h1>", {
      status: 201,
      contentType: "text/html",
    });
    const host = buildBrokerToolHost({ broker, artifacts, fetchImpl });
    if (host.httpRequest === undefined) throw new Error("httpRequest not wired");

    const res = await host.httpRequest({
      url: "https://api.test/things",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"name":"x"}',
    });

    expect(calls[0]?.url).toBe("https://api.test/things");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toEqual({ "content-type": "application/json" });
    expect(calls[0]?.init?.body).toBe('{"name":"x"}');
    expect(res.status).toBe(201);
    expect(res.contentType).toBe("text/html");
    // RAW — HTML is NOT extracted here (unlike webfetch): tags + entities survive verbatim.
    expect(res.body).toBe("<h1>raw &amp; uncut</h1>");
    expect(res.truncated).toBe(false);
  });

  it("defaults to GET when no method is given", async () => {
    const { broker } = fakeBroker();
    const { artifacts } = fakeArtifacts();
    const { fetchImpl, calls } = fetchCapturing("ok");
    const host = buildBrokerToolHost({ broker, artifacts, fetchImpl });
    if (host.httpRequest === undefined) throw new Error("httpRequest not wired");

    await host.httpRequest({ url: "https://api.test/ping" });
    expect(calls[0]?.init?.method).toBe("GET");
  });

  it("caps the response body at maxBytes and flags truncation", async () => {
    const { broker } = fakeBroker();
    const { artifacts } = fakeArtifacts();
    const { fetchImpl } = fetchCapturing("0123456789");
    const host = buildBrokerToolHost({ broker, artifacts, fetchImpl });
    if (host.httpRequest === undefined) throw new Error("httpRequest not wired");

    const res = await host.httpRequest({ url: "https://api.test/big" }, { maxBytes: 4 });
    expect(res.body).toBe("0123");
    expect(res.truncated).toBe(true);
  });

  it("rejects a non-http(s) scheme before any fetch (labelled `http`)", async () => {
    const { broker } = fakeBroker();
    const { artifacts } = fakeArtifacts();
    const { fetchImpl, calls } = fetchCapturing("secret");
    const host = buildBrokerToolHost({ broker, artifacts, fetchImpl });
    if (host.httpRequest === undefined) throw new Error("httpRequest not wired");

    await expect(host.httpRequest({ url: "file:///etc/passwd" })).rejects.toThrow(
      /http: only http\(s\)/,
    );
    expect(calls).toEqual([]); // never reached fetch
  });
});

// ---- htmlToText extraction ----------------------------------------------------------------

describe("htmlToText", () => {
  it("drops script/style/comments, strips tags, and decodes entities", () => {
    const out = htmlToText(
      "<style>a{}</style><script>x()</script><!-- c --><p>Tom &amp; Jerry &lt;3</p>",
    );
    expect(out).toBe("Tom & Jerry <3");
  });

  it("decodes numeric and hex character references", () => {
    expect(htmlToText("<p>&#65;&#x42;&#39;</p>")).toBe("AB'");
  });

  it("turns block boundaries into newlines and collapses whitespace", () => {
    expect(htmlToText("<h1>Title</h1><p>One</p><p>Two</p>")).toBe("Title\nOne\nTwo");
    expect(htmlToText("a<br>b")).toBe("a\nb");
  });

  it("leaves an unknown/invalid entity untouched", () => {
    expect(htmlToText("<p>5 &notareal; 6</p>")).toBe("5 &notareal; 6");
  });
});

// ---- LSP is engine-native, not a ToolHost hook -------------------------------------------

describe("BrokerToolHost — LSP is not a host concern", () => {
  it("exposes only the host-backed tool hooks (LSP is wired via capabilities.lspService, not here)", () => {
    // Engine-native LSP rides `capabilities.lspService` (supplied per run by the leaf wiring), so the
    // ToolHost has no LSP hook by design. Assert the host surface is exactly the four host-backed hooks.
    const { broker } = fakeBroker();
    const { artifacts } = fakeArtifacts();
    const host = buildBrokerToolHost({ broker, artifacts });
    expect(Object.keys(host).sort()).toEqual(
      ["fetchUrl", "httpRequest", "readArtifact", "webSearch", "writeArtifact"].sort(),
    );
  });
});
