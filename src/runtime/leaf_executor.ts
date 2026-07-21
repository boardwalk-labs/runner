// EngineLeafExecutor — the `agent()` leaf, run by the OPEN-SOURCE engine's agent loop.
//
// In the JS-body model the run is the workflow PROGRAM; the agent loop is no longer "the run" — it
// is an ephemeral leaf the program invokes via `agent(prompt, opts)`. This is the LeafExecutor the
// worker's WorkflowHost delegates `agent()` to. It runs ONE leaf to completion via the engine's
// `runAgentLeaf` (`@boardwalk-labs/engine/core`) — the SAME loop `boardwalk dev` and the self-hosted
// server run — supplying a broker-backed `LeafIo`: the model call routes through the Runner Control
// API (the worker holds no model creds), events flow onto the run's v1 event stream, usage meters
// per-leaf + per-model through the broker, and secrets are redacted out of all model-bound content.
//
// What it deliberately does NOT do:
//   - no checkpoint / resume (hold-and-pay; a crash restarts the run from the top).
//   - no control-flow tools — `sleep` / `workflows.call` are PROGRAM hooks (they pause the run),
//     not LLM tools; the engine's tool set is per-call inline ToolDefs / skills / memory only.
//   - no run-level billing/credit/outcome — those live one level up, in the worker.
//
// MCP servers ARE supported on hosted runs, but constrained: only the `http` transport, and only to
// hosts in the egress allowlist (the worker can reach nothing else through the forward proxy). A leaf
// naming a `stdio` server or a non-allowlisted host fails up-front with a clear error. Static bearer
// auth (a token in the server's `headers`, typically from `secrets.get`) needs no further wiring — the
// engine tries those first. OAuth servers broker a short-lived token via `brokerMcpToken` (the
// control-plane vault); the token state never lives on the worker.

import { join } from "node:path";
import {
  runAgentLeaf,
  Redactor,
  EngineError,
  type LeafIo,
  type LeafEventBody,
  type LeafResume,
  type ModelTurnRequest,
  type ModelTurnResult,
  type ProviderIo,
  type ToolHost,
  type LspService,
  type McpTokenResult,
} from "@boardwalk-labs/engine/core";
import { AppError, ErrorCode } from "./support/index.js";
import type { AgentOptions } from "@boardwalk-labs/workflow/runtime";
import type { BudgetMeter, UsageDelta } from "./agent/budget.js";
import type { SecretRedactor } from "./agent/secret_redactor.js";
import type { AgentIdentity, RunEventBody, TokenUsage, TurnEventSink } from "./agent/events.js";
import type { InferenceProxyTransport } from "./inference_transport.js";
import {
  directProviderFor,
  streamDirectTurn,
  type DirectInferenceDeps,
} from "./direct_inference.js";
import type { LeafExecutor } from "./workflow_host.js";
import { throwIfAborted } from "./run_abort.js";

/** Builds the per-leaf event sink (`TurnEventSink`) for the leaf's `leafIndex`-numbered turn. */
export type EventSinkFactory = (leafIndex: number, identity: AgentIdentity) => TurnEventSink;

/** Per-leaf, per-model token metering input (fire-and-forget → the broker). */
export interface MeterUsageInput {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Cache-served input tokens for this leaf (display-only annotation; omitted when absent). */
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  leafIndex: number;
}

export interface EngineLeafExecutorDeps {
  /** Streams one model turn through the broker (RunnerControlClient satisfies it). */
  inference: InferenceProxyTransport;
  /** Runner-direct BYO inference (the self-hosted runner design): when a per-`agent()` provider
   *  matches this registry (key-based HTTP sources only), the turn goes STRAIGHT to the org's
   *  endpoint with the engine adapters — the managed lane and bedrock stay brokered. Omitted ⇒
   *  everything brokered (legacy dispatch without a registry). */
  byo?: DirectInferenceDeps;
  /** RUN-level meter, shared across every leaf so caps + token totals span the whole run. The engine
   *  reports usage after EVERY model call via `reportUsage`; we feed it here and throw on a cap
   *  breach so the loop terminates mid-flight (the budget authority). */
  budget: BudgetMeter;
  /**
   * Budget clearance, awaited before EVERY model call (docs/SUSPEND_POLICY.md Decision 3). When the
   * run's `max_usd` cap is breached this PARKS the run at a gate — the engine just sees a model call
   * that took a long time, because the VM froze and resumed underneath it — and resolves once a
   * responder raises the cap. Rejects with `BudgetGateCancelled` if they decline.
   *
   * Why here and not at the `reportUsage` breach check below: that callback is synchronous and fires
   * mid-turn, and per SUSPEND_POLICY Decision 1 a partial turn is never discarded. The model-call
   * boundary is the first safe place to park, which bounds overrun at one in-flight turn per leaf.
   *
   * Absent ⇒ the legacy behavior: a breach fails the run at `reportUsage`.
   */
  budgetGate?: { clear(): Promise<void> };
  /** RUN-level redactor (shared with the secret resolver): every resolved secret value is recorded
   *  here. We seed a fresh engine `Redactor` from it per leaf so the loop scrubs known values out of
   *  the prompt, tool args/results, and transcript before they reach the model. */
  redactor: SecretRedactor;
  /** Builds this leaf's event sink; `leafIndex` (1-based) is only a metering identifier — the sink
   *  owns the run-global cursor. `identity` names the leaf on its turn frames. */
  makeEventSink: EventSinkFactory;
  /** The run's persistent `/workspace` root — memory dirs (`agent({ memory })`) are relative to it. */
  workspaceRoot: string;
  /** Register a memory dir the run actually used, so the workspace store persists it (§3 of
   *  docs/WORKSPACE_PERSISTENCE.md). Memory is undeclared by design, so this callback is the ONLY
   *  signal that the dir must compound — without it a `agent({ memory })`-only workflow silently
   *  persists nothing, which is exactly what shipped. Optional: absent ⇒ validation only. */
  onMemoryUsed?: (dir: string) => void;
  /** Resolves the directory holding this run's bundled files (the extracted program tree, where a
   *  skill lives at `skills/<name>.md`). Known only once the artifact is extracted (mid-run), so it's
   *  a thunk. Null / omitted ⇒ a leaf that names `skills` fails loud. */
  skillsDir?: () => string | null;
  /** Resolves the run's workflow PACKAGE root — the extracted program tree, whose ROOT holds the
   *  author's standing instructions (`<programDir>/AGENTS.md`) and `skills/` beside them. The engine
   *  reads `capabilities.programDir` for the BUNDLED `AGENTS.md` tier, read by every agent() before
   *  any AGENTS.md the run cloned into its workspace. A thunk for the same reason `skillsDir` is (the
   *  dir is known only once the artifact extracts); it is in fact the parent of `skillsDir`. Null /
   *  omitted ⇒ no bundled tier (only the workspace AGENTS.md applies). */
  programDir?: () => string | null;
  /** Per-leaf token metering seam (fire-and-forget). Reports THIS leaf's tokens + its model to the
   *  broker, which decides `billed_by_boardwalk` per model + meters usage to the platform. Omitted in tests. */
  meterUsage?: (input: MeterUsageInput) => void;
  /** Backend for the engine's host-backed built-in tools (`webfetch` / `web_search` / `artifacts`):
   *  set as the leaf's `capabilities.host` so the engine registers them. Broker-backed on hosted runs
   *  (BrokerToolHost). Omitted ⇒ those three tools are simply absent (the engine never registers a
   *  host-backed tool whose hook the host doesn't provide). */
  toolHost?: ToolHost;
  /** Engine-native LSP for the `diagnostics` tool + diagnostics-after-edit. Set as the leaf's
   *  `capabilities.lspService`. Constructed ONCE per RUN (not per leaf) so the language server stays
   *  warm across the run's edits/leaves, and closed on the run's teardown. Omitted ⇒ the `diagnostics`
   *  tool and after-edit diagnostics are best-effort-skipped (the correct degradation). */
  lspService?: LspService;
  /** Brokers a short-lived OAuth bearer for a hosted MCP server. The engine calls this REACTIVELY —
   *  only after a server answers 401 to the static `headers` — so static-bearer servers never reach
   *  it. Routes to the Runner Control API's `mcp/token` vend endpoint (the OAuth token state lives in
   *  the control-plane vault, never on the worker). Omitted ⇒ no OAuth brokering: a server that needs
   *  a token gets `{ accessToken: null }` and the leaf fails loud with a clear hint (the correct
   *  degradation — static-bearer and no-auth servers still work). */
  brokerMcpToken?: (serverUrl: string, invalidateToken?: string) => Promise<McpTokenResult>;
}

/**
 * Per-run leaf executor. The worker constructs one bound to the run + run-level budget, and wires it
 * as the `LeafExecutor` on the run's WorkflowHost, so every `agent()` the program calls runs here
 * through the engine's loop.
 */
export class EngineLeafExecutor implements LeafExecutor {
  private leafCount = 0;

  constructor(private readonly deps: EngineLeafExecutorDeps) {}

  async run(
    prompt: string,
    opts: AgentOptions | undefined,
    signal?: AbortSignal,
    resume?: LeafResume,
  ): Promise<unknown> {
    // Cooperative cancellation: don't even start the leaf if the run is already aborted.
    throwIfAborted(signal);
    // Validate any named MCP servers up-front (before the engine tries to connect) so a leaf naming
    // an unsupported transport or a non-allowlisted host fails clearly and deterministically at the
    // leaf boundary, rather than deep in the engine loop. The broker re-checks the host authoritatively
    // when it vends a token (the worker can't widen egress).
    assertHostedMcpAllowed(opts?.mcp);
    const leafIndex = ++this.leafCount;
    const agentName = opts?.name;
    const identity: AgentIdentity = {
      agentId: `agent-${String(leafIndex)}`,
      ...(agentName !== undefined ? { agentName } : {}),
    };
    const sink = this.deps.makeEventSink(leafIndex, identity);

    // Seed a fresh engine Redactor from the run's recorded secret values — the loop scrubs them out
    // of every model-bound string (prompt, tool args/results) before the model sees them. Labels are
    // immaterial (the placeholder never reveals which secret matched); index them for distinctness.
    const redactor = new Redactor();
    this.deps.redactor.values.forEach((value, i) => {
      redactor.add(`secret-${String(i)}`, value);
    });

    const io = this.buildLeafIo({ identity, sink, redactor, leafIndex, signal });
    try {
      // `resume` (a tool-level human-input resume) re-enters a parked leaf from its checkpoint + the
      // answers. A leaf that PARKS throws LeafParked, which propagates to the host (the executor never
      // catches it — the host turns it into a suspend).
      return await runAgentLeaf(prompt, opts, io, resume);
    } finally {
      // The run's AbortSignal is authoritative: if it fired during the leaf (credit exhaustion / a
      // user cancel), unwind the program even if the loop returned (e.g. an aborted stream that
      // resolved). The streamModel seam below rejects in-flight calls when the signal is aborted.
      throwIfAborted(signal);
    }
  }

  /** Assemble the broker-backed `LeafIo` the engine loop drives for one leaf call. */
  private buildLeafIo(ctx: {
    identity: AgentIdentity;
    sink: TurnEventSink;
    redactor: Redactor;
    leafIndex: number;
    signal: AbortSignal | undefined;
  }): LeafIo {
    const { identity, sink, redactor, leafIndex, signal } = ctx;
    const skillsDir = this.deps.skillsDir?.() ?? null;
    const programDir = this.deps.programDir?.() ?? null;
    // The broker stamps each turn's exact upstream cost on the result frame, but the engine hands
    // `reportUsage` only `ChatTurn.usage` (input/output tokens, no cost). So `streamModel` stashes the
    // result frame's `costMicros` here for the matching `reportUsage` to consume — one slot per leaf
    // io (children get their own via `forChild`), and the loop is strictly streamModel→reportUsage per
    // turn, so a single slot never races. Null ⇒ no upstream cost for the next turn (BYO / unavailable).
    let pendingCostMicros: number | null = null;
    // The turn currently streaming, tracked so `streamModel` can attribute a `turn_reset` to it when
    // the broker restarts a dropped model call mid-stream. Set on `startTurn` and every `emit` (the
    // engine stamps both with the turn's id); within a leaf, turns are strictly sequential, so this is
    // never stale for the turn actually streaming.
    let currentTurnId: string | undefined = undefined;
    return {
      identity,
      redactor,
      // `host` lights up the host-backed built-ins (webfetch/web_search/artifacts); `lspService` lights
      // up the engine-native `diagnostics` tool + diagnostics-after-edit. Each is omitted when its
      // backend isn't wired (then that surface stays absent — the correct degradation). `workspaceDir`
      // drives the WORKSPACE `AGENTS.md` tier (a codebase the run cloned, root + nested) and `programDir`
      // the BUNDLED tier (the package-root AGENTS.md, the author's standing instructions) — both
      // default-on, read by every agent(). `exactOptionalPropertyTypes` ⇒ conditional-spread, never an
      // explicit `undefined`.
      capabilities: {
        workspaceDir: this.deps.workspaceRoot,
        skillsDir,
        ...(programDir !== null ? { programDir } : {}),
        ...(this.deps.toolHost !== undefined ? { host: this.deps.toolHost } : {}),
        ...(this.deps.lspService !== undefined ? { lspService: this.deps.lspService } : {}),
      },

      // One model turn → the broker (the runner holds no model creds). The broker resolves the real
      // model server-side, invokes the matching adapter, and streams text back; we surface each delta
      // through providerIo.onDelta and return the terminal turn. An aborted run rejects in-flight.
      streamModel: async (
        req: ModelTurnRequest,
        providerIo: ProviderIo,
      ): Promise<ModelTurnResult> => {
        throwIfAborted(signal);
        // Budget clearance BEFORE the spend, not after: if the cap is already breached this parks
        // the run (freeing the host on the snapshot fleet) until someone approves more. No-op on the
        // overwhelming majority of calls. Re-check abort afterwards — a park can span a long wait,
        // and the run may have been cancelled while frozen.
        await this.deps.budgetGate?.clear();
        throwIfAborted(signal);
        return this.streamModel(
          req,
          providerIo,
          signal,
          redactor,
          (costMicros) => {
            pendingCostMicros = (pendingCostMicros ?? 0) + costMicros;
          },
          // The broker restarted a dropped model call after content had already streamed: void the
          // turn's emitted text/reasoning so a viewer re-renders from the restart, not the concatenation.
          () => {
            if (currentTurnId !== undefined) sink.emit({ kind: "turn_reset" }, currentTurnId);
          },
        );
      },

      // turn_started rides a NEW stride block (the supervisor opens it); subsequent leaf events ride
      // the same block. The shared emitter owns the run-global cursor.
      startTurn: (turnId: string): void => {
        currentTurnId = turnId;
        sink.beginTurn(turnId, { kind: "turn_started", ...identity });
      },

      // Engine LeafEventBody → the platform's v1 RunEventBody. The platform already adopted the SDK
      // v1 wire format, and the engine emits the same kinds, so this is a near-identity mapping.
      emit: (turnId: string, body: LeafEventBody): void => {
        currentTurnId = turnId;
        sink.emit(toRunEventBody(body, identity), turnId);
      },

      // Usage flows to the budget authority after EVERY model call. Feed the run-level meter and, if
      // a cap is now breached, THROW — the engine loop propagates it and the run fails BUDGET_EXCEEDED
      // before another model call is dispatched. Also fire per-leaf, per-model metering to the broker.
      reportUsage: (modelRefForUsage: string, usage: TokenUsage): void => {
        const delta = toUsageDelta(usage);
        // Cap on the turn's REAL upstream cost when the broker reported one (the result frame's
        // costMicros, stashed by streamModel just above) so max_usd tracks actual spend rather than a
        // representative-rate token estimate that's blind to prompt-cache discounts. Null ⇒ BYO / no
        // upstream price ⇒ addUsage falls back to the estimate. Consume-once so the next turn is clean.
        const realCostUsd = pendingCostMicros === null ? undefined : pendingCostMicros / 1_000_000;
        pendingCostMicros = null;
        this.deps.budget.addUsage(delta, realCostUsd);
        const breach = this.deps.budget.capBreachReason();
        if (breach !== null) {
          throw new EngineError(
            "BUDGET_EXCEEDED",
            `agent() leaf exceeded the run budget cap (${breach})`,
          );
        }
        this.deps.meterUsage?.({
          model: modelRefForUsage,
          inputTokens: delta.inputTokens ?? 0,
          outputTokens: delta.outputTokens ?? 0,
          ...(delta.cacheReadTokens === undefined
            ? {}
            : { cachedReadTokens: delta.cacheReadTokens }),
          ...(delta.cacheWriteTokens === undefined
            ? {}
            : { cachedWriteTokens: delta.cacheWriteTokens }),
          leafIndex,
        });
      },

      // A memory dir (`agent({ memory })`) is workspace-relative and is persisted BECAUSE this hook
      // registers it — memory carries no manifest declaration (`sdk/src/types.ts`), so this is the
      // only signal the workspace store gets. It used to only validate, on the assumption that the
      // whole workspace was persisted "when the manifest opts in": true for `persist: true`, and
      // false for every other case, so memory silently evaporated on hosted runs. Validate first
      // (defense-in-depth; the engine's buildToolSet already shape-validates), then register.
      memoryUsed: (dir: string): void => {
        const abs = join(this.deps.workspaceRoot, dir);
        if (abs !== this.deps.workspaceRoot && !abs.startsWith(this.deps.workspaceRoot + "/")) {
          throw new EngineError("VALIDATION", `agent() memory dir "${dir}" escapes the workspace.`);
        }
        this.deps.onMemoryUsed?.(dir);
      },

      // OAuth bearer brokering for a hosted MCP server. Called REACTIVELY by the engine — only after a
      // server 401s the static `headers` — so static-bearer / no-auth servers never reach here. When
      // the broker hook is wired, the token comes from the control-plane vault (never stored on the
      // worker); `invalidateToken` names a just-rejected token so the broker forces a refresh. Absent
      // hook ⇒ no token, and the engine surfaces a clean failure with the hint (correct degradation).
      mcpToken: (serverUrl: string, invalidateToken?: string): Promise<McpTokenResult> =>
        this.deps.brokerMcpToken?.(serverUrl, invalidateToken) ??
        Promise.resolve({
          accessToken: null,
          hint:
            `No OAuth connection is configured for MCP server "${serverUrl}". Connect it in the ` +
            `Boardwalk console, or provide a bearer token via the server's headers.`,
        }),

      // Derive a child leaf io for a `subagent` tool call (engine ≥0.1.11): a fresh run-unique
      // identity over the SAME sinks. `makeEventSink` returns the one run-global emitter, so every
      // leaf's events ride a single monotonic cursor; the child's usage feeds the SAME run budget
      // and meters under its own `leafIndex`. Reuses the parent leaf's redactor (same run secrets)
      // and AbortSignal. A child gets no `subagent` tool, so its own forkLeaf is never invoked.
      forkLeaf: (childOpts: { name?: string }): LeafIo => {
        const childIndex = ++this.leafCount;
        const childIdentity: AgentIdentity = {
          agentId: `agent-${String(childIndex)}`,
          ...(childOpts.name !== undefined ? { agentName: childOpts.name } : {}),
        };
        return this.buildLeafIo({
          identity: childIdentity,
          sink: this.deps.makeEventSink(childIndex, childIdentity),
          redactor,
          leafIndex: childIndex,
          signal,
        });
      },
    };
  }

  /** POST one model turn to the broker's `/inference` and adapt its NDJSON stream into the engine's
   *  ModelTurnResult: each `delta` frame drives providerIo.onDelta; the terminal `result` frame is
   *  the turn. An `error` frame throws (the broker already classified it). An abort mid-stream throws. */
  private async streamModel(
    req: ModelTurnRequest,
    providerIo: ProviderIo,
    signal: AbortSignal | undefined,
    redactor: Redactor,
    onCost?: (costMicros: number) => void,
    onReset?: () => void,
  ): Promise<ModelTurnResult> {
    // Runner-direct BYO (D7): the org's own endpoint + key, called with the same engine adapters
    // the broker uses. No platform cost (BYO is never metered) — onCost stays untouched.
    // A direct turn needs an explicit model (an omitted model means the managed auto lane,
    // which is always brokered).
    const directModel = req.model;
    const direct =
      this.deps.byo === undefined || directModel === undefined
        ? null
        : directProviderFor(this.deps.byo.registry, req.provider);
    if (direct !== null && this.deps.byo !== undefined && directModel !== undefined) {
      throwIfAborted(signal);
      const out = await streamDirectTurn(
        this.deps.byo,
        direct,
        {
          model: directModel,
          messages: req.messages,
          tools: req.tools,
          ...(req.reasoning !== undefined ? { reasoning: req.reasoning } : {}),
        },
        providerIo.onDelta,
        providerIo.onReasoningDelta,
        // Register the org's key with THIS leaf's redactor before the model call, so an error
        // body echoing it is scrubbed from the leaf's run events (not just the terminal error).
        (value) => redactor.add("byo-key", value),
      );
      throwIfAborted(signal);
      return { turn: out.turn, modelRef: out.modelRef };
    }
    let result: ModelTurnResult | null = null;
    for await (const frame of this.deps.inference.streamInference({
      model: req.model,
      provider: req.provider,
      messages: req.messages,
      tools: req.tools,
      ...(req.reasoning !== undefined ? { reasoning: req.reasoning } : {}),
    })) {
      throwIfAborted(signal);
      if (frame.kind === "delta") {
        providerIo.onDelta?.(frame.text);
      } else if (frame.kind === "reasoning") {
        providerIo.onReasoningDelta?.(frame.text);
      } else if (frame.kind === "reset") {
        // The broker recovered a transient mid-stream drop and is restarting the turn: everything
        // relayed above is void. Signal the viewer to discard the turn's streamed text/reasoning; the
        // authoritative turn still comes from the single terminal `result` frame below.
        onReset?.();
      } else if (frame.kind === "result") {
        // contextTokens (when the broker knows the served model's window) lets the engine's loop
        // size compaction against the real window instead of a conservative default.
        result = {
          turn: frame.turn,
          modelRef: frame.modelRef,
          ...(frame.contextTokens !== undefined ? { contextTokens: frame.contextTokens } : {}),
        };
        // The broker stamps the turn's exact upstream cost on the result frame (0 ⇒ none / BYO); hand
        // it to the budget guardrail via the caller's stash so max_usd caps on real spend.
        if (frame.costMicros > 0) onCost?.(frame.costMicros);
      } else if (frame.kind === "error") {
        // The broker already classified this into a clean, customer-facing message — surface it
        // verbatim (the loop records it as the run's error).
        throw new Error(frame.error.message);
      }
      // else: a `ping` heartbeat keeping the connection alive during a long turn — nothing to do.
    }
    if (result === null) {
      throw new Error("Inference stream ended without a result frame");
    }
    return result;
  }
}

/** The MCP server refs an `agent({ mcp })` call may name, derived from the SDK's `AgentOptions`. */
type HostedMcpServerRef = NonNullable<AgentOptions["mcp"]>[number];

/**
 * Gate the MCP servers a hosted leaf may use: only the `http` transport (no arbitrary `stdio`
 * processes on the worker) and a parseable URL. Throws a clear VALIDATION_FAILED for the first
 * offending ref so the leaf fails at its boundary, before the engine connects out.
 *
 * Reachability of the host is NOT gated here: a hosted run's egress is OPEN by default (the forward
 * proxy allows all public destinations; a workflow restricts it via manifest.egress), and the proxy
 * is the single enforcement point — a server blocked by a restrictive egress fails at the proxy when
 * the engine connects, not via an MCP-specific allowlist that would be stricter than the platform.
 */
export function assertHostedMcpAllowed(refs: readonly HostedMcpServerRef[] | undefined): void {
  for (const ref of refs ?? []) {
    if (ref.transport !== "http") {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `MCP server "${ref.name}" uses the "${ref.transport}" transport, which hosted runs do not ` +
          `support — use transport: "http".`,
      );
    }
    if (!isParsableUrl(ref.url)) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `MCP server "${ref.name}" has an invalid URL: ${ref.url}`,
      );
    }
  }
}

/** True when `url` parses (a malformed server URL should fail the leaf early). */
function isParsableUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/** Map the engine loop's `TokenUsage` to the worker's `UsageDelta` (only numeric fields kept). */
function toUsageDelta(usage: TokenUsage): UsageDelta {
  const delta: UsageDelta = {};
  if (typeof usage.inputTokens === "number") delta.inputTokens = usage.inputTokens;
  if (typeof usage.outputTokens === "number") delta.outputTokens = usage.outputTokens;
  if (typeof usage.cacheReadTokens === "number") delta.cacheReadTokens = usage.cacheReadTokens;
  if (typeof usage.cacheCreationTokens === "number")
    delta.cacheWriteTokens = usage.cacheCreationTokens;
  return delta;
}

/**
 * Project an engine `LeafEventBody` onto the platform's v1 `RunEventBody`. Both are the SDK's v1
 * event kinds (the platform consumes `@boardwalk-labs/workflow`; the engine emits the same shapes),
 * so this is a near-identity copy — `turn_ended` re-stamps the leaf identity the platform tracks,
 * and the body is otherwise passed through verbatim. A discriminated switch keeps it exhaustive
 * (any new engine kind surfaces as a compile error here, not a silent drop).
 */
/** Engine LeafEventBody → the platform's v1 RunEventBody. Exported for testing. */
export function toRunEventBody(body: LeafEventBody, identity: AgentIdentity): RunEventBody {
  switch (body.kind) {
    case "turn_ended":
      return {
        kind: "turn_ended",
        ...identity,
        reason: body.reason,
        ...(body.usage === undefined ? {} : { usage: body.usage }),
        ...(body.error === undefined ? {} : { error: body.error }),
      };
    case "text_start":
      return { kind: "text_start", blockId: body.blockId };
    case "text_delta":
      return { kind: "text_delta", blockId: body.blockId, text: body.text };
    case "text_end":
      return { kind: "text_end", blockId: body.blockId };
    case "reasoning_delta":
      return { kind: "reasoning_delta", text: body.text };
    case "tool_call_start":
      return { kind: "tool_call_start", toolCallId: body.toolCallId, toolName: body.toolName };
    case "tool_call_input_complete":
      return { kind: "tool_call_input_complete", toolCallId: body.toolCallId, input: body.input };
    case "tool_call_executing":
      return { kind: "tool_call_executing", toolCallId: body.toolCallId };
    case "tool_output_delta":
      return {
        kind: "tool_output_delta",
        toolCallId: body.toolCallId,
        stream: body.stream,
        text: body.text,
      };
    case "tool_call_result":
      return { kind: "tool_call_result", toolCallId: body.toolCallId, result: body.result };
    case "tool_call_error":
      return { kind: "tool_call_error", toolCallId: body.toolCallId, error: body.error };
    case "compaction_started":
      return {
        kind: "compaction_started",
        ...identity,
        tokens: body.tokens,
        budget: body.budget,
        ...(body.contextTokens === undefined ? {} : { contextTokens: body.contextTokens }),
      };
    case "compaction_ended":
      return {
        kind: "compaction_ended",
        ...identity,
        tokens: body.tokens,
        reclaimed: body.reclaimed,
        method: body.method,
      };
  }
}
