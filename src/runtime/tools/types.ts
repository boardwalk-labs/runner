// Boardwalk's internal Tool contract. Concrete tools (`echo`, `http`, `web_search`, `sleep`,
// `workflows.call`, …) implement this interface; the worker registers a `ZodTool`-flavored
// adapter into Strands at agent construction time.
//
// Why a Boardwalk-side interface instead of using `ZodTool` directly?
//   * Tests can drive tool logic without instantiating Strands.
//   * Control-signal tools (`sleep`, `workflows.call`) need to return a
//     specially-shaped value the worker interprets — they don't really "run";
//     they bubble a signal up to the engine. Our adapter (lands with the worker
//     in Phase 10.5) translates between this interface and the Strands surface.
//
// Per the platform spec: tools NEVER see secret values. Secrets resolve to
// short-lived bearer tokens, ARNs, etc. via the injected `SecretResolver`.

import type { z } from "zod";
import type { AuthContext } from "../support/index.js";
import type { SecretRefManifest } from "../wire/manifest.js";

/**
 * Per-invocation context the worker threads through to a tool. Equivalent to
 * Strands' `ToolContext` but typed in Boardwalk's idiom (AuthContext + run id +
 * secret resolver scoped to this run's permissions).
 */
export interface ToolContext {
  readonly auth: AuthContext;
  /** Run id (`runs.id`). Used for tagging artifacts + correlation. */
  readonly runId: string;
  /** Org-scoped resolver. Returns the secret VALUE, not the ARN. */
  readonly secrets: SecretResolver;
}

export interface SecretResolver {
  /**
   * Resolve a manifest secret reference to its plaintext value. Throws
   * `AppError(FORBIDDEN)` when the reference isn't in the agent's
   * `permissions.secrets` allowlist, or `AppError(NOT_FOUND)` when the named
   * secret doesn't exist in the org.
   */
  resolve(ref: SecretRefManifest): Promise<string>;
}

/**
 * Boardwalk-side tool interface. Concrete tools either:
 *   * Return a `ToolReturn` body — synchronous "normal" tools (echo, http,
 *     web_search). The body lands in the conversation as the assistant's
 *     tool-result block.
 *   * Return a `ToolControlSignal` — the legacy Strands-level sleep/workflows.call path. The
 *     current JS-body worker exposes these as program SDK hooks instead; agent() leaves strip
 *     control-flow tools before registering model-callable tools.
 */
export interface BoardwalkTool<TInput = unknown, TOutput = unknown> {
  /** Stable tool name — what an `agent()` call names in `AgentOptions.tools`. */
  readonly name: string;
  /** Description surfaced to the model. */
  readonly description: string;
  /** Zod schema for the tool's input. */
  readonly inputSchema: z.ZodType<TInput>;
  /**
   * Zod schema for the tool's SUCCESS output (the `TOutput` shape — never the
   * control-signal branch). The adapter validates the tool's return value
   * against this before it lands in the LLM conversation, per the code standards
   * §2.1/§8.3 (LLM-facing output is treated like untrusted external input).
   */
  readonly outputSchema: z.ZodType<TOutput>;
  /**
   * Secret names this tool requires (matching entries in the org's secret
   * store / the manifest's `permissions.secrets` allowlist). Used for
   * declarative per-tool secret scoping in the sandbox. Most built-ins are
   * `[]` because they either need no secrets or receive them via `ctx`
   * (resolved env / `ctx.secrets`); `web_search` declares the Tavily key.
   */
  readonly secretsRequired: readonly string[];
  /**
   * Optional: normalize the raw LLM-supplied args BEFORE `inputSchema.parse`. Lets a tool accept a
   * common-but-wrong shape the model tends to emit (e.g. `{command:"clone"}` aliased to the schema's
   * `{op:"clone"}` discriminator) so the first attempt succeeds instead of bouncing off a `ZodError`
   * and costing a retry. Keeps `inputSchema` (the model-facing JSON schema) pristine — the alias is
   * applied at the adapter's parse boundary, never exposed. Must be pure + total (return the input
   * unchanged when nothing applies).
   */
  normalizeInput?(raw: unknown): unknown;
  /**
   * Invoke the tool. `input` (LLM-supplied) comes first, `ctx` (worker-supplied)
   * second — see the `Tool` naming note in SPEC §9. Returns either the typed
   * `TOutput` body or a `ToolControlSignal` (sleep / workflows.call) the worker
   * intercepts before serialization.
   */
  invoke(input: TInput, ctx: ToolContext): Promise<TOutput | ToolControlSignal>;
}

/**
 * Discriminated union of "I'm not really returning a result; tell the engine
 * something." Worker checks `result instanceof ToolControlSignal` (well —
 * structurally on `__signal`) before serializing into the conversation.
 */
export type ToolControlSignal = SleepControlSignal | WaitForChildControlSignal;

export interface SleepControlSignal {
  readonly __signal: "sleep";
  /** Wall-clock time to wake at (ms since epoch). */
  readonly wakeAtMs: number;
}

export interface WaitForChildControlSignal {
  readonly __signal: "wait_for_child";
  /** The child run id the parent is now blocked on. */
  readonly childRunId: string;
}

export function isControlSignal(value: unknown): value is ToolControlSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    "__signal" in value &&
    typeof value.__signal === "string"
  );
}

/**
 * Tool registry — maps a tool name to its concrete `BoardwalkTool`. Built once
 * per worker process; each `agent()` leaf sees a filtered view based on the
 * tools that call named (`AgentOptions.tools`), materialized via
 * `materializeFor(grants)`.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, BoardwalkTool>();

  register(tool: BoardwalkTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool ${tool.name} is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): BoardwalkTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Names of every registered tool. Used by the `list_tools` MCP tool. */
  list(): string[] {
    return Array.from(this.tools.keys()).sort();
  }

  /**
   * Filter the registry down to the tools granted by a manifest. Names absent
   * from the registry are returned in `missing` so the worker can fail-loud
   * before the LLM tries to call something that doesn't exist.
   */
  materializeFor(grants: readonly { name: string }[]): {
    tools: BoardwalkTool[];
    missing: string[];
  } {
    const tools: BoardwalkTool[] = [];
    const missing: string[] = [];
    for (const grant of grants) {
      const tool = this.tools.get(grant.name);
      if (tool === undefined) missing.push(grant.name);
      else tools.push(tool);
    }
    return { tools, missing };
  }
}
