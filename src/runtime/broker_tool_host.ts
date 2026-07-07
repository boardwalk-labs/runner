// BrokerToolHost — the engine's `ToolHost` (the infrastructure seam for the host-backed built-in
// coding tools `webfetch` / `http` / `web_search` / `artifacts`) wired over the Runner Credential Broker
// (the Runner Credential Broker model). `@boardwalk-labs/engine` registers those three tools ONLY when the leaf's
// `ToolSetContext.host` provides the backing hook; we supply one here so they light up on hosted
// runs. Each hook delegates the privileged capability to whoever holds the credential/network/storage
// — exactly as the broker model requires (security): the untrusted worker holds no Tavily
// key, no S3 credential, and only reaches the public network through the egress proxy.
//
//   web_search → broker /tools/web_search (the broker holds the Tavily key; the worker just forwards
//                the query + maps the result rows into the engine's WebSearchResult shape).
//   artifacts  → the existing BrokerArtifactStore (presigned write for large bodies; list + signed
//                URL + an in-process S3 GET for read).
//   webfetch   → an in-process fetch FROM the worker. The worker's egress is already gated by the
//                Squid allowlist proxy (NODE_USE_ENV_PROXY / HTTP(S)_PROXY → egress-proxy boundary);
//                we never bypass it. http(s)-only, response size-capped, HTML extracted to text.
//   http       → the same in-process, proxy-gated fetch but with any method/headers/body and the RAW
//                response (no HTML extraction) — for calling APIs. http(s)-only, response size-capped.
//
// LSP is NOT a `ToolHost` hook — it's engine-native (`capabilities.lspService`, supplied per run by
// the worker's leaf wiring in index.ts), so it isn't this module's concern.
//
// Secrets-redaction invariant: every value a host hook returns flows back through the engine loop's
// Redactor before it can reach model context (the leaf seeds it from the run's recorded secrets), so
// nothing here can leak a secret. This module holds no provider key of its own.

import type {
  ArtifactWriteResult as EngineArtifactWriteResult,
  FetchResult,
  HttpRequestInput,
  ToolHost,
  WebSearchResult as EngineWebSearchResult,
} from "@boardwalk-labs/engine/core";
import type { WebSearchInput, WebSearchOutput } from "./tools/web_search.js";
import type { ArtifactStore } from "./tools/artifacts.js";

/** Socket-safety ceiling on the RAW bytes read off a `webfetch` response, so a hostile URL can't
 *  stream an unbounded body into the worker. This bounds MEMORY, not what the model sees (the
 *  model-facing content is extracted + capped separately — see DEFAULT_FETCH_CONTENT_CHARS). The
 *  engine's per-call `maxBytes` overrides this when set. */
export const DEFAULT_FETCH_MAX_BYTES = 5 * 1024 * 1024;

/** Ceiling on the MODEL-FACING content of a `webfetch`, in chars, AFTER HTML→text extraction
 *  (~12K tokens). Raw HTML is mostly `<script>`/`<style>`/markup the model doesn't need and which
 *  then rides in context for the rest of the loop, so we extract the readable text and cap it. A
 *  whole 5 MB page used to land in context verbatim; this is the single biggest webfetch token sink. */
export const DEFAULT_FETCH_CONTENT_CHARS = 50_000;

/** TTL for the short-lived signed URL minted to read an artifact's bytes back (`readArtifact`). The
 *  download happens immediately in-process, so a minute is ample. */
const READ_ARTIFACT_SIGN_TTL_SECONDS = 60;

/** The broker surface the web_search + read-artifact paths need (RunnerControlClient satisfies it).
 *  `webSearch` proxies to Tavily server-side; `signArtifactUrl` + `downloadBytes` back `readArtifact`. */
export interface ToolHostBroker {
  webSearch(input: WebSearchInput): Promise<WebSearchOutput>;
  signArtifactUrl(artifactId: string, ttlSeconds: number): Promise<{ signedUrl: string }>;
  downloadBytes(url: string): Promise<Uint8Array | null>;
}

export interface BrokerToolHostDeps {
  /** Broker client for web_search + read-artifact signing/download. */
  broker: ToolHostBroker;
  /** The artifact store the `artifacts` write/list path already uses (reused verbatim). */
  artifacts: ArtifactStore;
  /** Injected fetch for `webfetch` (defaults to global fetch — the proxy is applied by the runtime,
   *  not here, so a plain global fetch already routes through the egress allowlist). */
  fetchImpl?: typeof fetch;
  /** Override the default `webfetch` RAW read cap, in bytes (tests). */
  maxFetchBytes?: number;
  /** Override the default `webfetch` model-facing content cap, in chars (tests). */
  maxFetchContentChars?: number;
}

/**
 * Build the engine `ToolHost` for one run, backed by the broker. Returned as a plain object literal so
 * each hook closes over the injected deps; the shape matches the engine's optional-method interface
 * (omitting `lsp` leaves that tool unregistered).
 */
export function buildBrokerToolHost(deps: BrokerToolHostDeps): ToolHost {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const maxFetchBytes = deps.maxFetchBytes ?? DEFAULT_FETCH_MAX_BYTES;
  const maxFetchContentChars = deps.maxFetchContentChars ?? DEFAULT_FETCH_CONTENT_CHARS;

  return {
    // web_search → broker /tools/web_search. The engine hands a bare query + optional limit; we map
    // `limit` onto the domain tool's `max_results` (the broker re-clamps to [1, 20] server-side) and
    // project the rich WebSearchOutput rows down to the engine's title/url/snippet shape.
    webSearch: async (
      query: string,
      opts?: { limit?: number },
    ): Promise<EngineWebSearchResult[]> => {
      const input: WebSearchInput = {
        query,
        ...(opts?.limit !== undefined ? { max_results: opts.limit } : {}),
      };
      const out = await deps.broker.webSearch(input);
      return out.data.results.map((r) => ({
        title: r.title,
        url: r.url,
        // `snippet` is optional on the engine shape; the domain row always has one (possibly empty).
        snippet: r.snippet,
      }));
    },

    // artifacts.write → the existing BrokerArtifactStore (small bodies proxy inline; large ones take
    // the presigned-PUT path). The engine's ArtifactWriteResult is { id, name, url }, so surface the
    // store's signed download URL as `url`.
    writeArtifact: async (
      name: string,
      contentType: string,
      body: string,
      metadata?: Record<string, unknown>,
    ): Promise<EngineArtifactWriteResult> => {
      const result = await deps.artifacts.write({
        name,
        contentType,
        // The engine always hands a UTF-8 string for these host-backed writes (it has no binary
        // channel); the store decodes per `encoding`.
        body,
        encoding: "utf8",
        ...(metadata !== undefined ? { metadata } : {}),
      });
      return { id: result.id, name: result.name, url: result.signedUrl };
    },

    // artifacts read-back: the engine asks by NAME, so list this run's artifacts, find the most recent
    // match, mint a short-lived signed URL through the broker, and fetch the bytes in-process. Fails
    // loud when the name isn't found (so a typo surfaces, never a silent empty read).
    readArtifact: async (name: string): Promise<string> => {
      const artifacts = await deps.artifacts.list();
      // Newest-first so a re-written name reads the latest version.
      const match = artifacts
        .filter((a) => a.name === name)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (match === undefined) {
        throw new Error(`artifact "${name}" not found in this run`);
      }
      const { signedUrl } = await deps.broker.signArtifactUrl(
        match.id,
        READ_ARTIFACT_SIGN_TTL_SECONDS,
      );
      const bytes = await deps.broker.downloadBytes(signedUrl);
      if (bytes === null) {
        throw new Error(`artifact "${name}" could not be downloaded`);
      }
      return Buffer.from(bytes).toString("utf8");
    },

    // webfetch → an in-process fetch from the worker. Egress is gated by the Squid allowlist proxy
    // (NODE_USE_ENV_PROXY in the worker), so this does NOT bypass it. http(s)-only; the body is read
    // as a size-capped stream so a hostile URL can't exhaust memory.
    fetchUrl: async (url: string, opts?: { maxBytes?: number }): Promise<FetchResult> => {
      assertHttpUrl(url);
      // maxBytes (when the caller sets it) bounds the RAW read; otherwise the socket-safety cap.
      const rawCap = opts?.maxBytes ?? maxFetchBytes;
      const res = await fetchImpl(url, { method: "GET", redirect: "follow" });
      const contentType = res.headers.get("content-type") ?? undefined;
      const { body: raw, truncated: rawTruncated } = await readCapped(res, rawCap);
      // Extract readable text from HTML so the model isn't fed script/style/markup boilerplate, then
      // cap the model-facing content (extraction already shrinks HTML a lot; this bounds the rest).
      const extracted = isHtmlContentType(contentType) ? htmlToText(raw) : raw;
      const body =
        extracted.length > maxFetchContentChars
          ? extracted.slice(0, maxFetchContentChars)
          : extracted;
      const truncated = rawTruncated || body.length < extracted.length;
      return { status: res.status, contentType, body, truncated };
    },

    // http → an in-process fetch from the worker with the model's method/headers/body, egress-gated
    // by the same Squid allowlist proxy as webfetch (NODE_USE_ENV_PROXY). UNLIKE webfetch it returns
    // the RAW response (no HTML→text extraction) — `http` is for calling APIs — so it skips the
    // content-chars cap and only bounds RAW bytes against worker memory.
    httpRequest: async (
      req: HttpRequestInput,
      opts?: { maxBytes?: number },
    ): Promise<FetchResult> => {
      assertHttpUrl(req.url, "http");
      const rawCap = opts?.maxBytes ?? maxFetchBytes;
      const res = await fetchImpl(req.url, {
        method: req.method ?? "GET",
        redirect: "follow",
        ...(req.headers !== undefined ? { headers: req.headers } : {}),
        ...(req.body !== undefined ? { body: req.body } : {}),
      });
      const contentType = res.headers.get("content-type") ?? undefined;
      const { body, truncated } = await readCapped(res, rawCap);
      return { status: res.status, contentType, body, truncated };
    },
  };
}

/** Reject anything but http/https up front — `webfetch`/`http` must never reach `file:`, `data:`, or
 *  other schemes that could read local state or smuggle the proxy. */
function assertHttpUrl(url: string, tool = "webfetch"): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${tool}: invalid URL "${url}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${tool}: only http(s) URLs are allowed (got "${parsed.protocol}")`);
  }
}

/** Read a response body as UTF-8 text, stopping once `maxBytes` bytes have been consumed. Returns the
 *  decoded text and whether it was truncated, so a huge document can't exhaust worker memory. Falls
 *  back to a buffered read (still capped) when the body isn't a stream. */
async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ body: string; truncated: boolean }> {
  const stream: ReadableStream<Uint8Array> | null = res.body;
  if (stream === null) {
    return { body: "", truncated: false };
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (value.length > remaining) {
        chunks.push(value.subarray(0, remaining));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const body = chunks.map((c) => decoder.decode(c, { stream: true })).join("") + decoder.decode();
  return { body, truncated };
}

/** Whether a content-type names HTML (so we should extract readable text from it). */
function isHtmlContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const ct = contentType.toLowerCase();
  return ct.includes("text/html") || ct.includes("application/xhtml");
}

/**
 * Reduce an HTML document to readable text: drop non-content elements (script/style/head/etc.),
 * turn block boundaries into newlines, strip remaining tags, decode common entities, and collapse
 * whitespace. A pragmatic, dependency-free extractor — NOT a full readability pass (it does not
 * score main-content vs. nav/ads), but it removes the bulk of the markup/script tokens that would
 * otherwise flood the model. A heavier readability library could improve precision later.
 */
export function htmlToText(html: string): string {
  let s = html;
  // Non-content elements, dropped whole (including their contents).
  s = s.replace(/<(script|style|head|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Block-level closers + line breaks become newlines so document structure partly survives.
  s = s.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre)\s*>/gi, "\n");
  s = s.replace(/<(br|hr)\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " "); // strip all remaining tags
  s = decodeHtmlEntities(s);
  // Collapse intra-line whitespace, trim around newlines, cap blank-line runs.
  return s
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode the handful of HTML entities that show up in extracted prose, plus numeric refs. */
function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (full: string, bodyRaw: string) => {
    const body = bodyRaw.toLowerCase();
    if (body.startsWith("#")) {
      const codePoint = body.startsWith("#x")
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : full;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)
      ? (NAMED_ENTITIES[body] ?? full)
      : full;
  });
}
