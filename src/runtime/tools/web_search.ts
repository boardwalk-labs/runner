// web_search — wraps the Tavily API (https://docs.tavily.com/docs/api-reference).
//
// Per the platform spec: Tavily is Boardwalk's default web-search provider. API
// key fetched from Secrets Manager (`boardwalk/<stage>/tavily/api-key`) and
// cached at the module level per container, NEVER appearing in the agent's
// conversation.
//
// 429 from Tavily → `AppError(RATE_LIMIT)` so Strands' retry strategy handles
// backoff. 5xx → `AppError(TOOL_ERROR)`. Network-level fetch failures fall
// back to `TOOL_ERROR`.

import { z } from "zod";
import { AppError, ErrorCode } from "../support/index.js";
import type { BoardwalkTool, ToolContext } from "./types.js";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const MAX_RESULTS_CAP = 20;

/**
 * Logical secret name this tool depends on (the org/stage prefix is applied by
 * the resolver — see the file header). Surfaced via `secretsRequired` so the
 * sandbox can scope secret access declaratively without the value ever entering
 * the tool's input.
 */
export const TAVILY_SECRET_NAME = "tavily/api-key";

export const webSearchInput = z.object({
  query: z.string().min(1).max(2000),
  /** Clamped to [1, 20]. */
  max_results: z.number().int().positive().optional(),
  /** When true, include raw content alongside the snippet. */
  include_content: z.boolean().optional(),
  /**
   * "basic" (default) | "advanced". Advanced is more thorough at higher
   * latency; we surface both so agents can pick when accuracy matters.
   */
  search_depth: z.enum(["basic", "advanced"]).optional(),
});

export type WebSearchInput = z.infer<typeof webSearchInput>;

const webSearchResult = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  /** Present only when include_content=true. */
  content: z.string().optional(),
  /** Tavily's relevance score (0..1). */
  score: z.number().optional(),
});

export type WebSearchResult = z.infer<typeof webSearchResult>;

const webSearchOutput = z.object({
  kind: z.literal("web_search"),
  humanSummary: z.string(),
  data: z.object({
    query: z.string(),
    results: z.array(webSearchResult),
    /** Tavily's optional answer summary. */
    answer: z.string().optional(),
  }),
});

export type WebSearchOutput = z.infer<typeof webSearchOutput>;

/** Tavily wire shape — what the API returns. Narrow on demand. */
interface TavilyResponse {
  results?: {
    title?: string;
    url?: string;
    content?: string;
    raw_content?: string;
    score?: number;
  }[];
  answer?: string;
}

export interface WebSearchDeps {
  /** Returns the Tavily API key. Cached at the caller (one resolve per cold start). */
  resolveApiKey: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

export function makeWebSearchTool(
  deps: WebSearchDeps,
): BoardwalkTool<WebSearchInput, WebSearchOutput> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    name: "web_search",
    description:
      "Search the public web via Tavily. Returns up to 20 result rows with title, URL, snippet, and optional raw content.",
    inputSchema: webSearchInput,
    outputSchema: webSearchOutput,
    secretsRequired: [TAVILY_SECRET_NAME],
    async invoke(input: WebSearchInput, _ctx: ToolContext): Promise<WebSearchOutput> {
      const apiKey = await deps.resolveApiKey();
      const maxResults = clamp(input.max_results ?? 5, 1, MAX_RESULTS_CAP);
      const searchDepth = input.search_depth ?? "basic";
      const payload = {
        api_key: apiKey,
        query: input.query,
        max_results: maxResults,
        include_raw_content: input.include_content === true,
        search_depth: searchDepth,
        // Advanced mode otherwise returns up to 3 ~500-char chunks per source; one keeps results
        // lean. Only valid for advanced depth, so send it only then.
        ...(searchDepth === "advanced" ? { chunks_per_source: 1 } : {}),
      };

      let res: Response;
      try {
        res = await fetchImpl(TAVILY_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new AppError(ErrorCode.TOOL_ERROR, `Tavily request failed: ${message}`);
      }

      if (res.status === 429) {
        throw new AppError(ErrorCode.RATE_LIMIT, "Tavily rate limit exceeded");
      }
      if (!res.ok) {
        throw new AppError(ErrorCode.TOOL_ERROR, `Tavily returned ${res.status.toString()}`);
      }

      const json = (await res.json()) as TavilyResponse;
      const results = dedupeByDomain(
        (json.results ?? []).map((r) => projectResult(r, input.include_content === true)),
      );
      const summary = `Found ${results.length.toString()} result${results.length === 1 ? "" : "s"} for "${input.query}"`;
      const data: WebSearchOutput["data"] = {
        query: input.query,
        results,
      };
      if (typeof json.answer === "string" && json.answer.length > 0) {
        data.answer = json.answer;
      }
      return { kind: "web_search", humanSummary: summary, data };
    },
  };
}

/**
 * Broker-backed web_search for the runner (the Runner Credential Broker model): identical name/schemas/behavior
 * to {@link makeWebSearchTool}, but the Tavily call runs in the broker (which holds the platform key)
 * — the runner just forwards the query, so it needs NO Tavily secret (`secretsRequired: []`). Wired on
 * the worker when the control plane is on; the direct tool above is the pre-broker/local path.
 */
export function makeBrokerWebSearchTool(deps: {
  search: (input: WebSearchInput) => Promise<WebSearchOutput>;
}): BoardwalkTool<WebSearchInput, WebSearchOutput> {
  return {
    name: "web_search",
    description:
      "Search the public web via Tavily. Returns up to 20 result rows with title, URL, snippet, and optional raw content.",
    inputSchema: webSearchInput,
    outputSchema: webSearchOutput,
    secretsRequired: [],
    invoke: (input: WebSearchInput, _ctx: ToolContext): Promise<WebSearchOutput> =>
      deps.search(input),
  };
}

function projectResult(
  r: NonNullable<TavilyResponse["results"]>[number],
  includeContent: boolean,
): WebSearchResult {
  const out: WebSearchResult = {
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
  };
  if (typeof r.score === "number") out.score = r.score;
  if (includeContent && typeof r.raw_content === "string") out.content = r.raw_content;
  return out;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Drop near-duplicate results from the same hostname, keeping the first (highest-ranked, since
 * Tavily returns by relevance). The agent shouldn't pay tokens for three hits off one site. A
 * result whose URL won't parse is kept (we can't classify it, so we don't drop it). Exported for
 * unit testing.
 */
export function dedupeByDomain(results: WebSearchResult[]): WebSearchResult[] {
  const seen = new Set<string>();
  const out: WebSearchResult[] = [];
  for (const result of results) {
    const host = domainOf(result.url);
    if (host !== null) {
      if (seen.has(host)) continue;
      seen.add(host);
    }
    out.push(result);
  }
  return out;
}

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null; // malformed URL — keep it rather than silently dropping
  }
}
