// Inference proxy protocol (the Runner Credential Broker model)").
//
// The runner never invokes a model directly: under the Runner Credential Broker it holds no
// managed-inference creds and no BYO provider key. Instead the `agent()` leaf's model turn (the
// engine's `LeafIo.streamModel` seam) POSTs the conversation to the broker's `/inference`
// endpoint; the broker resolves the REAL model server-side (managed under the broker's creds, or a
// BYO key it reads from Secrets Manager), invokes the matching engine adapter, and streams the
// model's text back so the loop can show it live.
//
// This module is the shared wire contract for that exchange — imported by both the worker client
// (serialize request / parse response frames) and the broker handler (parse request / serialize
// response frames), so the two can never drift.
//
// Transport: the response is **newline-delimited JSON** (one frame per line). A model turn streams
// many text deltas; NDJSON lets the runner consume them incrementally over the raw socket (the
// buffered REST path can't stream). Each frame is one of:
//   { "t": "delta",  "text": <string> }                  — a streamed assistant-text chunk
//   { "t": "result", "turn": <ChatTurn>, "modelRef": <string>, "costMicros": <number>,
//     "contextTokens"?: <number> }                                                       — terminal turn
//   { "t": "error",  "error": { code, message } }         — a terminal model/broker error
//
// A well-formed stream is zero-or-more `delta` frames followed by EXACTLY ONE `result` frame, OR a
// single terminal `error` frame. The neutral conversation shapes (ChatMessage / ChatTurn / ToolSpec)
// are the engine's `@boardwalk-labs/engine/core` types — so the worker's loop and the broker's
// adapters speak the same wire as `boardwalk dev` and the self-hosted server (one agent loop).

import type { ChatMessage, ChatTurn, ToolSpec } from "@boardwalk-labs/engine/core";
import type { NormalizedReasoning } from "@boardwalk-labs/workflow";

/** `POST /runner/v1/runs/{run_id}/inference` (run-token authed; the addressed run must match). */
export const RUNNER_INFERENCE_PATH_RE = /^\/runner\/v1\/runs\/([^/]+)\/inference$/;

/** Build the inference path for a run. */
export function runnerInferencePath(runId: string): string {
  return `/runner/v1/runs/${runId}/inference`;
}

/** Response content type — newline-delimited JSON frames. */
export const INFERENCE_NDJSON_CONTENT_TYPE = "application/x-ndjson";

/**
 * The request body the worker POSTs to `/inference` — one neutral model turn (the engine's
 * `ModelTurnRequest`, minus the seam: no endpoint, no key). `model`/`provider` are the `agent()`
 * call's (both opaque, both optional); the broker resolves them SERVER-SIDE against the run's org
 * (the orgId comes from the verified run token, never the body — so this can't reach another org).
 */
export interface InferenceProxyRequest {
  /** The model id, as the agent() call gave it (opaque, passed verbatim). Undefined ⇒ provider routes. */
  model: string | undefined;
  /** The provider the agent() call named (undefined ⇒ the managed `boardwalk` lane). */
  provider: string | undefined;
  /** The conversation so far. */
  messages: readonly ChatMessage[];
  /** The tools advertised to the model this turn. */
  tools: readonly ToolSpec[];
  /** Normalized reasoning-effort control (the agent() call's `AgentOptions.reasoning`, undefined ⇒
   *  provider default). The broker encodes it into the resolved provider's wire body per protocol. */
  reasoning?: NormalizedReasoning;
}

/** A broker/model error surfaced as the terminal frame so the worker's stream throws. */
export interface ProxyError {
  code: string;
  message: string;
}

/** A parsed response frame. `ping` is a no-payload heartbeat the broker emits during a long model
 *  turn to keep the connection producing bytes (so idle/body timeouts don't sever it); the worker
 *  ignores it. */
export type InferenceFrame =
  | { kind: "delta"; text: string }
  | { kind: "result"; turn: ChatTurn; modelRef: string; costMicros: number; contextTokens?: number }
  | { kind: "error"; error: ProxyError }
  | { kind: "ping" };

// ---- request serialize / parse ----

/** Serialize the request body. Multimodal image content rides transparently: message content parts
 *  (incl. `{ type: "image" }`) are plain JSON here — the broker's engine adapters render them per
 *  provider (@boardwalk-labs/engine ≥ 0.1.32). */
export function serializeInferenceRequest(req: InferenceProxyRequest): string {
  return JSON.stringify(req);
}

/** Parse + minimally validate the request body (the runner is semi-trusted; fail closed on shape).
 *  The conversation is shape-trusted past the array check — it was built by the engine loop on the
 *  runner from the broker's own prior frames, and the broker's adapters re-render every field. */
export function parseInferenceRequest(body: string): InferenceProxyRequest {
  const parsed: unknown = JSON.parse(body);
  const rec = asRecord(parsed);
  if (rec === null) throw new Error("Inference request must be a JSON object");
  if (rec.model !== undefined && typeof rec.model !== "string") {
    throw new Error("Inference request `model` must be a string when present");
  }
  if (rec.provider !== undefined && typeof rec.provider !== "string") {
    throw new Error("Inference request `provider` must be a string when present");
  }
  if (!Array.isArray(rec.messages)) {
    throw new Error("Inference request requires a messages array");
  }
  if (!Array.isArray(rec.tools)) {
    throw new Error("Inference request requires a tools array");
  }
  return {
    model: typeof rec.model === "string" ? rec.model : undefined,
    provider: typeof rec.provider === "string" ? rec.provider : undefined,
    // The engine's ChatMessage/ToolSpec are plain JSON-shaped data (no class instances) — they
    // round-trip through JSON unchanged, so the parsed arrays ARE the wire shapes.
    messages: rec.messages as ChatMessage[],
    tools: rec.tools as ToolSpec[],
    // Reasoning is small JSON the engine built via `normalizeReasoning` on the runner; pass it
    // through when present (an object), and let the broker's adapters render its fields. A
    // non-object is dropped — the provider default then applies (no reasoning steering).
    ...(asRecord(rec.reasoning) !== null
      ? { reasoning: rec.reasoning as NormalizedReasoning }
      : {}),
  };
}

// ---- response frame serialize / parse ----

/** Serialize one streamed text delta as a single NDJSON line (trailing "\n" included). */
export function serializeDeltaFrame(text: string): string {
  return `${JSON.stringify({ t: "delta", text })}\n`;
}

/** Serialize the single terminal turn result as one NDJSON line. `costMicros` is the turn's EXACT
 *  upstream cost (the managed provider's per-request cost × 1e6) on the managed lane — 0 for BYO or when unavailable.
 *  The worker feeds it to the budget guardrail so `max_usd` tracks real spend, not a token estimate. */
export function serializeResultFrame(
  turn: ChatTurn,
  modelRef: string,
  costMicros = 0,
  contextTokens?: number,
): string {
  const frame = {
    t: "result",
    turn,
    modelRef,
    costMicros,
    ...(contextTokens !== undefined ? { contextTokens } : {}),
  };
  return `${JSON.stringify(frame)}\n`;
}

/** Serialize a terminal error as a single NDJSON line. */
export function serializeErrorFrame(error: ProxyError): string {
  return `${JSON.stringify({ t: "error", error })}\n`;
}

/** Serialize a heartbeat (no payload) as a single NDJSON line. The broker emits these on an interval
 *  during a long model turn so the worker↔broker connection keeps producing bytes — neither side's
 *  idle/body timeout fires while the model is generating but not yet streaming text. */
export function serializeHeartbeatFrame(): string {
  return `${JSON.stringify({ t: "ping" })}\n`;
}

/** Parse one NDJSON frame line. Throws on a malformed/unknown frame (the line must be non-empty). */
export function parseInferenceFrame(line: string): InferenceFrame {
  const parsed: unknown = JSON.parse(line);
  const rec = asRecord(parsed);
  if (rec === null) throw new Error("Malformed inference frame");
  switch (rec.t) {
    case "delta":
      return { kind: "delta", text: typeof rec.text === "string" ? rec.text : "" };
    case "result":
      return {
        kind: "result",
        turn: toChatTurn(rec.turn),
        modelRef: toModelRef(rec.modelRef),
        // A pre-cost-forwarding broker (rolling deploy) omits this → 0 → the worker falls back to the
        // representative-rate estimate, exactly as before. Non-number / negative also clamps to 0.
        costMicros: typeof rec.costMicros === "number" && rec.costMicros > 0 ? rec.costMicros : 0,
        // The served model's context window; absent from a pre-window broker (rolling deploy) or
        // when its catalog can't say ⇒ the agent loop keeps its conservative default budget.
        ...(typeof rec.contextTokens === "number" && rec.contextTokens > 0
          ? { contextTokens: rec.contextTokens }
          : {}),
      };
    case "error":
      return { kind: "error", error: toProxyError(rec.error) };
    case "ping":
      return { kind: "ping" };
    default:
      throw new Error(`Unknown inference frame kind: ${String(rec.t)}`);
  }
}

/** Narrow a parsed `result` frame's turn back to the engine's `ChatTurn`, failing closed on shape —
 *  the worker's loop relies on `toolCalls`/`usage`/`wantsTools` being present and well-typed. */
function toChatTurn(value: unknown): ChatTurn {
  const rec = asRecord(value);
  if (rec === null) throw new Error("Inference result frame has no turn");
  if (typeof rec.text !== "string") throw new Error("Inference result turn missing text");
  if (!Array.isArray(rec.toolCalls)) throw new Error("Inference result turn missing toolCalls");
  const usage = asRecord(rec.usage) ?? {};
  return {
    text: rec.text,
    toolCalls: rec.toolCalls as ChatTurn["toolCalls"],
    usage: {
      ...(typeof usage.inputTokens === "number" ? { inputTokens: usage.inputTokens } : {}),
      ...(typeof usage.outputTokens === "number" ? { outputTokens: usage.outputTokens } : {}),
    },
    wantsTools: rec.wantsTools === true,
  };
}

function toModelRef(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Inference result frame missing modelRef");
  }
  return value;
}

function toProxyError(value: unknown): ProxyError {
  const rec = asRecord(value);
  const code = rec !== null && typeof rec.code === "string" ? rec.code : "INTERNAL_ERROR";
  const message =
    rec !== null && typeof rec.message === "string" ? rec.message : "Inference failed";
  return { code, message };
}

/** A plain object with string keys, or null. Avoids unsafe casts on parsed JSON. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
