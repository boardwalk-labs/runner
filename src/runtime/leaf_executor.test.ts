import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError, ErrorCode } from "./support/index.js";
import type { AgentOptions } from "@boardwalk-labs/workflow/runtime";
import { BudgetMeter } from "./agent/budget.js";
import { SecretRedactor } from "./agent/secret_redactor.js";
import { BUDGET_GUARDRAIL_RATE } from "./agent/model_rates.js";
import { runEventSchema } from "@boardwalk-labs/workflow";
import type { AgentIdentity, RunEvent, RunEventBody, TurnEventSink } from "./agent/events.js";
import type { InferenceFrame, InferenceProxyRequest } from "./wire/inference_proxy.js";
import { LspService, type ChatTurn, type ToolHost } from "@boardwalk-labs/engine/core";
import {
  EngineLeafExecutor,
  assertHostedMcpAllowed,
  toRunEventBody,
  type MeterUsageInput,
} from "./leaf_executor.js";
import type { InferenceProxyTransport } from "./inference_transport.js";
import { RunAbortedError } from "./run_abort.js";

// A guaranteed-empty, isolated workspace root for tests that don't supply their own. Defaulting to
// the real "/workspace" leaked ambient AGENTS.md whenever the suite ran inside a populated workspace
// (e.g. the repo-maintainer bot running this very suite from its own /workspace clone), which flipped
// the prompt-construction assertions. A fresh temp dir keeps the default workspace genuinely empty.
const EMPTY_WORKSPACE = mkdtempSync(join(tmpdir(), "leaf-exec-ws-"));
afterAll(() => {
  rmSync(EMPTY_WORKSPACE, { recursive: true, force: true });
});

// ---- fakes -------------------------------------------------------------------------------

const OPTS: AgentOptions = { model: "anthropic/claude-sonnet-4.5" };

/** A transport that records every request and replays a canned frame script per call. */
function fakeTransport(scripts: InferenceFrame[][]): {
  transport: InferenceProxyTransport;
  requests: InferenceProxyRequest[];
} {
  const requests: InferenceProxyRequest[] = [];
  let call = 0;
  const transport: InferenceProxyTransport = {
    streamInference(req: InferenceProxyRequest): AsyncIterable<InferenceFrame> {
      requests.push(req);
      const frames = scripts[call] ?? scripts[scripts.length - 1] ?? [];
      call += 1;
      return (async function* () {
        for (const f of frames) {
          await Promise.resolve();
          yield f;
        }
      })();
    },
  };
  return { transport, requests };
}

/** A single final-turn script (no tools): one delta then the terminal result with that text.
 *  `costMicros` is the broker's exact upstream cost for the turn (0 ⇒ none / BYO ⇒ estimate). */
function finalTurn(text: string, usage: ChatTurn["usage"] = {}, costMicros = 0): InferenceFrame[] {
  return [
    { kind: "delta", text },
    {
      kind: "result",
      turn: { text, toolCalls: [], usage, wantsTools: false },
      modelRef: "boardwalk/m",
      costMicros,
    },
  ];
}

/** A recording sink: every emitted body lands in `bodies`; `turns` counts `beginTurn` calls. */
class RecordingSink implements TurnEventSink {
  readonly bodies: RunEventBody[] = [];
  turns = 0;

  emit(body: RunEventBody): RunEvent {
    this.bodies.push(body);
    return { ...body, runId: "run_1", turnId: "t", seq: 1, t: 0 };
  }

  beginTurn(_turnId: string, started: RunEventBody): void {
    this.turns += 1;
    this.bodies.push(started);
  }
}

function makeExecutor(args: {
  scripts: InferenceFrame[][];
  budget?: BudgetMeter;
  redactor?: SecretRedactor;
  sink?: TurnEventSink;
  meterCalls?: MeterUsageInput[];
  skillsDir?: () => string | null;
  programDir?: () => string | null;
  workspaceRoot?: string;
  toolHost?: ToolHost;
  lspService?: LspService;
  budgetGate?: { clear(): Promise<void> };
}): { exec: EngineLeafExecutor; requests: InferenceProxyRequest[] } {
  const { transport, requests } = fakeTransport(args.scripts);
  const sink = args.sink ?? new RecordingSink();
  const exec = new EngineLeafExecutor({
    inference: transport,
    budget: args.budget ?? new BudgetMeter({ rate: BUDGET_GUARDRAIL_RATE, startedAt: 0 }),
    redactor: args.redactor ?? new SecretRedactor(),
    workspaceRoot: args.workspaceRoot ?? EMPTY_WORKSPACE,
    makeEventSink: () => sink,
    ...(args.meterCalls !== undefined
      ? { meterUsage: (input: MeterUsageInput) => args.meterCalls?.push(input) }
      : {}),
    ...(args.skillsDir !== undefined ? { skillsDir: args.skillsDir } : {}),
    ...(args.programDir !== undefined ? { programDir: args.programDir } : {}),
    ...(args.toolHost !== undefined ? { toolHost: args.toolHost } : {}),
    ...(args.lspService !== undefined ? { lspService: args.lspService } : {}),
    ...(args.budgetGate !== undefined ? { budgetGate: args.budgetGate } : {}),
  });
  return { exec, requests };
}

/** A model turn that requests one tool call (the loop then runs the tool + asks again). */
function toolCallTurn(id: string, name: string, input: Record<string, unknown>): InferenceFrame[] {
  return [
    {
      kind: "result",
      turn: {
        text: "",
        toolCalls: [{ id, name, input }],
        usage: {},
        wantsTools: true,
      },
      modelRef: "boardwalk/m",
      costMicros: 0,
    },
  ];
}

/** Create a temp `skills/` dir holding folder-per-skill `<name>/SKILL.md` files and return its path —
 *  the worker resolves the deployed `skills/` subdir as the engine's `skillsDir`. */
function skillsDirWith(files: Record<string, string>): { dir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "bw-leaf-skills-"));
  const dir = join(root, "skills");
  mkdirSync(dir, { recursive: true });
  for (const [name, md] of Object.entries(files)) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), md);
  }
  return { dir, root };
}

// ---- tests -------------------------------------------------------------------------------

describe("EngineLeafExecutor.run — output", () => {
  it("returns the final text when no schema is requested", async () => {
    const { exec } = makeExecutor({ scripts: [finalTurn("the answer")] });
    expect(await exec.run("what is it?", OPTS)).toBe("the answer");
  });

  it("parses JSON when a schema is requested", async () => {
    const { exec } = makeExecutor({ scripts: [finalTurn('{"count": 3, "items": ["a"]}')] });
    const out = await exec.run("group", {
      model: "anthropic/claude-sonnet-4.5",
      schema: { type: "object" },
    });
    expect(out).toEqual({ count: 3, items: ["a"] });
  });

  it("fails loud when a schema is requested but the text is not JSON", async () => {
    const { exec } = makeExecutor({ scripts: [finalTurn("not json at all")] });
    await expect(
      exec.run("group", { model: "anthropic/claude-sonnet-4.5", schema: { type: "object" } }),
    ).rejects.toThrow();
  });

  it("forwards the agent() call's model + provider on the wire request", async () => {
    const { exec, requests } = makeExecutor({ scripts: [finalTurn("ok")] });
    await exec.run("x", { provider: "acme", model: "claude-haiku-4-5" });
    expect(requests[0]).toMatchObject({ provider: "acme", model: "claude-haiku-4-5" });
  });

  it("sends an omitted model/provider as undefined (the broker routes the managed default)", async () => {
    const { exec, requests } = makeExecutor({ scripts: [finalTurn("ok")] });
    await exec.run("x", undefined);
    expect(requests[0]?.model).toBeUndefined();
    expect(requests[0]?.provider).toBeUndefined();
  });
});

describe("EngineLeafExecutor.run — events", () => {
  it("opens a turn (turn_started) and emits text frames mapped to the v1 wire", async () => {
    const sink = new RecordingSink();
    const { exec } = makeExecutor({ scripts: [finalTurn("hello")], sink });
    await exec.run("hi", OPTS);
    const kinds = sink.bodies.map((b) => b.kind);
    expect(sink.turns).toBe(1);
    expect(kinds[0]).toBe("turn_started");
    expect(kinds).toContain("text_start");
    expect(kinds).toContain("text_delta");
    expect(kinds).toContain("turn_ended");
    // turn_started carries the leaf identity.
    const started = sink.bodies[0];
    expect(started?.kind === "turn_started" && started.agentId).toBe("agent-1");
  });

  it("emits turn_reset on a broker restart frame, and takes the turn from the post-restart result", async () => {
    // The broker relayed a delta, then a `reset` (transient drop recovered), then the real answer.
    // The leaf surfaces turn_reset so a viewer discards the stale prefix, and returns the restarted
    // turn's text — never the concatenation.
    const sink = new RecordingSink();
    const script: InferenceFrame[] = [
      { kind: "delta", text: "half-writ" },
      { kind: "reset" },
      { kind: "delta", text: "the real answer" },
      {
        kind: "result",
        turn: { text: "the real answer", toolCalls: [], usage: {}, wantsTools: false },
        modelRef: "boardwalk/m",
        costMicros: 0,
      },
    ];
    const { exec } = makeExecutor({ scripts: [script], sink });
    const out = await exec.run("go", OPTS);
    expect(out).toBe("the real answer");
    const kinds = sink.bodies.map((b) => b.kind);
    expect(kinds).toContain("turn_reset");
    // The reset lands AFTER the stale delta and BEFORE the turn ends, so a viewer can void the prefix.
    const resetAt = kinds.indexOf("turn_reset");
    const firstDeltaAt = kinds.indexOf("text_delta");
    expect(firstDeltaAt).toBeGreaterThanOrEqual(0);
    expect(resetAt).toBeGreaterThan(firstDeltaAt);
    expect(resetAt).toBeLessThan(kinds.lastIndexOf("turn_ended") + 1);
  });
});

describe("toRunEventBody — compaction frames", () => {
  const IDENT: AgentIdentity = { agentId: "agent-1", agentName: "writer" };
  const ENVELOPE = { runId: "run_1", turnId: "t1", seq: 1, t: 1_770_000_000_000 };

  /** The mapper is the ONLY place identity is attached to these frames -- the engine bodies carry it,
   *  but the SDK schema REQUIRES agentId, so a dropped spread fails at the backend, not here. */
  it("maps a started frame and satisfies the published SDK schema", () => {
    const body = toRunEventBody(
      {
        kind: "compaction_started",
        ...IDENT,
        tokens: 940_000,
        budget: 936_000,
        contextTokens: 1_000_000,
      },
      IDENT,
    );
    expect(runEventSchema.parse({ ...ENVELOPE, ...body })).toMatchObject({
      kind: "compaction_started",
      agentId: "agent-1",
      tokens: 940_000,
      budget: 936_000,
      contextTokens: 1_000_000,
    });
  });

  it("omits an unknown window rather than sending a null the schema would reject", () => {
    const body = toRunEventBody(
      { kind: "compaction_started", ...IDENT, tokens: 160_000, budget: 150_000 },
      IDENT,
    );
    expect(body).not.toHaveProperty("contextTokens");
    expect(() => runEventSchema.parse({ ...ENVELOPE, ...body })).not.toThrow();
  });

  it("maps every ended method, including the passes that reclaim nothing", () => {
    for (const method of ["summarized", "deduped", "none"] as const) {
      const body = toRunEventBody(
        { kind: "compaction_ended", ...IDENT, tokens: 536_000, reclaimed: 404_000, method },
        IDENT,
      );
      expect(runEventSchema.parse({ ...ENVELOPE, ...body })).toMatchObject({ method });
    }
  });
});

describe("toRunEventBody — reasoning frames", () => {
  const IDENT: AgentIdentity = { agentId: "agent-1", agentName: "writer" };
  const ENVELOPE = { runId: "run_1", turnId: "t1", seq: 1, t: 1_770_000_000_000 };

  it("maps a reasoning_delta and satisfies the published SDK schema", () => {
    const body = toRunEventBody({ kind: "reasoning_delta", text: "let me think" }, IDENT);
    expect(body).toEqual({ kind: "reasoning_delta", text: "let me think" });
    expect(runEventSchema.parse({ ...ENVELOPE, ...body })).toMatchObject({
      kind: "reasoning_delta",
      text: "let me think",
    });
  });
});

describe("EngineLeafExecutor.run — budget + metering", () => {
  it("feeds the run-level budget and meters per-leaf, per-model through the broker hook", async () => {
    const meterCalls: MeterUsageInput[] = [];
    const budget = new BudgetMeter({ rate: BUDGET_GUARDRAIL_RATE, startedAt: 0 });
    const { exec } = makeExecutor({
      scripts: [finalTurn("done", { inputTokens: 100, outputTokens: 40 })],
      budget,
      meterCalls,
    });
    await exec.run("x", OPTS);
    expect(meterCalls).toEqual([
      { model: "boardwalk/m", inputTokens: 100, outputTokens: 40, leafIndex: 1 },
    ]);
    expect(budget.snapshot().totalTokens).toBe(140);
  });

  it("throws BUDGET_EXCEEDED when a model call pushes usage over the cap", async () => {
    const budget = new BudgetMeter({
      budget: { max_tokens: 10 },
      rate: BUDGET_GUARDRAIL_RATE,
      startedAt: 0,
    });
    const { exec } = makeExecutor({
      scripts: [finalTurn("done", { inputTokens: 100, outputTokens: 40 })],
      budget,
    });
    await expect(exec.run("x", OPTS)).rejects.toThrow(/budget cap/i);
  });

  it("caps on the result frame's real upstream cost, not the representative token estimate", async () => {
    // A cache-heavy managed turn: 1M input tokens would ESTIMATE at $3 (1M × $3/M) and trip the $1 cap,
    // but the broker reports the real, cache-discounted cost as $0.20 (200_000 micro-USD). The cap must
    // honor the real cost — so the run completes and the meter holds $0.20, not $3. (On the pre-fix code
    // the estimate trips BUDGET_EXCEEDED here — this is the regression guard for the cache-overcharge bug.)
    const budget = new BudgetMeter({
      budget: { max_usd: 1 },
      rate: BUDGET_GUARDRAIL_RATE,
      startedAt: 0,
    });
    const { exec } = makeExecutor({
      scripts: [finalTurn("done", { inputTokens: 1_000_000, outputTokens: 0 }, 200_000)],
      budget,
    });
    expect(await exec.run("x", OPTS)).toBe("done");
    expect(budget.snapshot().totalUsd).toBeCloseTo(0.2, 6);
    // Tokens still accumulate (they drive the max_tokens cap + the display aggregate).
    expect(budget.snapshot().inputTokens).toBe(1_000_000);
  });

  it("awaits budget clearance BEFORE each model call, so a breached run parks instead of spending", async () => {
    const order: string[] = [];
    const { exec, requests } = makeExecutor({
      scripts: [finalTurn("done", { inputTokens: 10, outputTokens: 5 })],
      budgetGate: {
        clear: () => {
          // The gate must run before the transport is touched — that ordering IS the feature.
          order.push(`clear:${String(requests.length)}`);
          return Promise.resolve();
        },
      },
    });
    expect(await exec.run("x", OPTS)).toBe("done");
    // Cleared once, with zero requests dispatched at the time (i.e. before the spend).
    expect(order).toEqual(["clear:0"]);
    expect(requests).toHaveLength(1);
  });

  it("propagates a gate rejection (the responder cancelled) instead of dispatching the call", async () => {
    const { exec, requests } = makeExecutor({
      scripts: [finalTurn("never reached", { inputTokens: 1, outputTokens: 1 })],
      budgetGate: { clear: () => Promise.reject(new Error("Run cancelled at the budget gate.")) },
    });
    await expect(exec.run("x", OPTS)).rejects.toThrow(/cancelled at the budget gate/);
    expect(requests).toHaveLength(0); // never spent
  });

  it("falls back to the representative-rate estimate when the frame carries no upstream cost", async () => {
    // costMicros 0 (BYO lane, or the broker read no cost) → estimate from tokens at the flat rate:
    // 1M input × $3/M = $3.
    const budget = new BudgetMeter({ rate: BUDGET_GUARDRAIL_RATE, startedAt: 0 });
    const { exec } = makeExecutor({
      scripts: [finalTurn("done", { inputTokens: 1_000_000, outputTokens: 0 }, 0)],
      budget,
    });
    await exec.run("x", OPTS);
    expect(budget.snapshot().totalUsd).toBeCloseTo(3, 6);
  });
});

describe("EngineLeafExecutor.run — secret redaction", () => {
  it("seeds the engine redactor from recorded secrets so the prompt is scrubbed on the wire", async () => {
    const redactor = new SecretRedactor();
    redactor.record("sk-live-abc123def");
    const { exec, requests } = makeExecutor({ scripts: [finalTurn("done")], redactor });
    await exec.run("use the key sk-live-abc123def please", OPTS);
    const userMessage = requests[0]?.messages[0];
    expect(userMessage?.role).toBe("user");
    if (userMessage?.role === "user") {
      // The invariant is that the secret VALUE never reaches the model — the engine Redactor
      // substitutes its own placeholder, so assert the value is gone (not the placeholder text).
      expect(userMessage.content).not.toContain("sk-live-abc123def");
      expect(userMessage.content).toContain("use the key");
    }
  });

  it("leaves the prompt untouched when no secrets are recorded", async () => {
    const { exec, requests } = makeExecutor({ scripts: [finalTurn("ok")] });
    await exec.run("a perfectly ordinary prompt", OPTS);
    const userMessage = requests[0]?.messages[0];
    // The prompt rides verbatim (no Redactor mangling); the engine also prepends its ambient
    // <env> date block to the same first message, so assert containment rather than equality.
    expect(userMessage?.role === "user" && userMessage.content).toContain(
      "a perfectly ordinary prompt",
    );
  });
});

describe("EngineLeafExecutor.run — bundled skills (agent({ skills }))", () => {
  it("injects the skill catalog (name + description) before the prompt", async () => {
    // Progressive disclosure: the first message carries the catalog (description), not the full body
    // — the model loads the body on demand via the `skill` tool.
    const { dir, root } = skillsDirWith({
      triage: "---\ndescription: Triage incoming issues\n---\n# Triage rules\nbe terse",
    });
    const { exec, requests } = makeExecutor({
      scripts: [finalTurn("ok")],
      skillsDir: () => dir,
    });
    await exec.run("handle this", { model: "anthropic/claude-sonnet-4.5", skills: ["triage"] });
    const userMessage = requests[0]?.messages[0];
    expect(userMessage?.role === "user" && userMessage.content).toContain("Triage incoming issues");
    expect(userMessage?.role === "user" && userMessage.content).toContain("<skills>");
    expect(userMessage?.role === "user" && userMessage.content).toContain("handle this");
    rmSync(root, { recursive: true, force: true });
  });

  it("fails loud when a named skill wasn't deployed", async () => {
    const { dir, root } = skillsDirWith({});
    const { exec } = makeExecutor({ scripts: [finalTurn("ok")], skillsDir: () => dir });
    await expect(
      exec.run("x", { model: "anthropic/claude-sonnet-4.5", skills: ["missing"] }),
    ).rejects.toThrow();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("EngineLeafExecutor.run — bundled AGENTS.md (capabilities.programDir)", () => {
  it("prepends the bundled package-root AGENTS.md to a plain agent() with an empty workspace", async () => {
    // The hosted parity case: programDir (the extracted artifact root) ≠ the empty /workspace, so
    // the bundled tier must reach context on its own — exactly what the wiring exists to prove.
    const root = mkdtempSync(join(tmpdir(), "bw-leaf-pkg-"));
    writeFileSync(join(root, "AGENTS.md"), "BUNDLED-RULE: always run the linter.");
    const { exec, requests } = makeExecutor({
      scripts: [finalTurn("ok")],
      programDir: () => root,
    });
    await exec.run("do the task", { model: "anthropic/claude-sonnet-4.5" });
    const userMessage = requests[0]?.messages[0];
    expect(userMessage?.role === "user" && userMessage.content).toContain(
      '<AGENTS.md source="workflow"',
    );
    expect(userMessage?.role === "user" && userMessage.content).toContain(
      "BUNDLED-RULE: always run the linter.",
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("adds nothing when the program dir has no AGENTS.md", async () => {
    const root = mkdtempSync(join(tmpdir(), "bw-leaf-pkg-"));
    const { exec, requests } = makeExecutor({ scripts: [finalTurn("ok")], programDir: () => root });
    await exec.run("plain prompt", { model: "anthropic/claude-sonnet-4.5" });
    const userMessage = requests[0]?.messages[0];
    expect(userMessage?.role === "user" && userMessage.content).not.toContain("AGENTS.md");
    expect(userMessage?.role === "user" && userMessage.content).toContain("plain prompt");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("assertHostedMcpAllowed — hosted MCP gate", () => {
  /** Assert `fn` throws an AppError carrying VALIDATION_FAILED (vitest's toThrow can't match a code). */
  function expectValidationFailure(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe(ErrorCode.VALIDATION_FAILED);
      return;
    }
    throw new Error("expected assertHostedMcpAllowed to throw");
  }

  it("allows any http server (reachability is the egress proxy's job, not an MCP allowlist)", () => {
    expect(() => {
      assertHostedMcpAllowed([
        { name: "linear", transport: "http", url: "https://mcp.linear.app/sse" },
        { name: "acme", transport: "http", url: "https://mcp.acme.example/mcp" },
      ]);
    }).not.toThrow();
  });

  it("does nothing when no MCP servers are named", () => {
    expect(() => {
      assertHostedMcpAllowed(undefined);
    }).not.toThrow();
    expect(() => {
      assertHostedMcpAllowed([]);
    }).not.toThrow();
  });

  it("rejects a stdio server (no arbitrary processes on the worker)", () => {
    expectValidationFailure(() => {
      assertHostedMcpAllowed([{ name: "fs", transport: "stdio", command: "mcp-fs" }]);
    });
  });

  it("rejects a malformed server URL", () => {
    expectValidationFailure(() => {
      assertHostedMcpAllowed([{ name: "bad", transport: "http", url: "notaurl" }]);
    });
  });
});

describe("EngineLeafExecutor.run — MCP gate", () => {
  it("fails loud at run() when a leaf names a stdio MCP server", async () => {
    const { exec } = makeExecutor({ scripts: [finalTurn("ok")] });
    await expect(
      exec.run("x", {
        model: "anthropic/claude-sonnet-4.5",
        mcp: [{ name: "fs", transport: "stdio", command: "mcp-fs" }],
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it("fails loud at run() when a leaf names a malformed MCP server URL", async () => {
    const { exec } = makeExecutor({ scripts: [finalTurn("ok")] });
    await expect(
      exec.run("x", {
        model: "anthropic/claude-sonnet-4.5",
        mcp: [{ name: "bad", transport: "http", url: "notaurl" }],
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });
});

describe("EngineLeafExecutor.run — cooperative cancellation", () => {
  it("throws before any model call when the signal is already aborted", async () => {
    const c = new AbortController();
    c.abort(new RunAbortedError("credit_exhausted"));
    const { exec, requests } = makeExecutor({ scripts: [finalTurn("ok")] });
    await expect(exec.run("x", OPTS, c.signal)).rejects.toBeInstanceOf(RunAbortedError);
    expect(requests).toHaveLength(0); // never reached the model
  });

  it("runs normally when the signal never fires", async () => {
    const c = new AbortController();
    const { exec } = makeExecutor({ scripts: [finalTurn("done")] });
    expect(await exec.run("x", OPTS, c.signal)).toBe("done");
  });
});

describe("EngineLeafExecutor.run — host-backed tools (capabilities.host)", () => {
  it("plumbs the toolHost so the engine registers web_search and the model can call it", async () => {
    const searches: { query: string; limit: number | undefined }[] = [];
    const toolHost: ToolHost = {
      webSearch: (query, opts) => {
        searches.push({ query, limit: opts?.limit });
        return Promise.resolve([{ title: "T", url: "https://t.test", snippet: "s" }]);
      },
    };
    // First turn: the model calls web_search. Second turn: it answers with the final text.
    const { exec } = makeExecutor({
      scripts: [
        toolCallTurn("call_1", "web_search", { query: "tides", limit: 2 }),
        finalTurn("the tide answer"),
      ],
      toolHost,
    });

    const out = await exec.run("research tides", OPTS);

    expect(out).toBe("the tide answer");
    // The host hook fired with the model-supplied query + limit — proving capabilities.host is wired.
    expect(searches).toEqual([{ query: "tides", limit: 2 }]);
  });

  it("does not register host-backed tools when no toolHost is supplied (tool call fails)", async () => {
    // No toolHost ⇒ web_search isn't advertised; a model that calls it gets an error result, but the
    // loop continues, so the SECOND turn's final text still returns (the tool was simply absent).
    const { exec } = makeExecutor({
      scripts: [
        toolCallTurn("call_1", "web_search", { query: "x" }),
        finalTurn("answered without the tool"),
      ],
    });
    expect(await exec.run("q", OPTS)).toBe("answered without the tool");
  });
});

describe("EngineLeafExecutor.run — engine-native LSP (capabilities.lspService)", () => {
  it("plumbs the lspService so the engine registers the `diagnostics` tool", async () => {
    // A real LspService over a temp workspace. The model calls `diagnostics` on a plain `.txt` file:
    // no language server handles it, so the engine-native tool returns the best-effort "skipped" note
    // (NOT an unknown-tool error) — proving the tool was registered, i.e. capabilities.lspService was
    // threaded. No process spawns for an unsupported extension, so this is cheap + hermetic.
    const root = mkdtempSync(join(tmpdir(), "bw-leaf-lsp-"));
    writeFileSync(join(root, "notes.txt"), "hello");
    const lspService = new LspService({ workspaceDir: root });
    try {
      // First turn: the model calls `diagnostics`. Second turn: it answers with the final text.
      const { exec, requests } = makeExecutor({
        scripts: [
          toolCallTurn("call_1", "diagnostics", { path: "notes.txt" }),
          finalTurn("looks clean"),
        ],
        workspaceRoot: root,
        lspService,
      });
      const out = await exec.run("check my file", OPTS);
      expect(out).toBe("looks clean");
      // The SECOND wire request carries the diagnostics tool RESULT (the loop ran the tool then asked
      // the model again). A registered tool yields the best-effort "no language server" note for the
      // unsupported `.txt` extension — NOT an unknown-tool error — proving capabilities.lspService was
      // threaded and the engine spawned no process for an extension it can't handle.
      const followUp = JSON.stringify(requests[1]?.messages ?? []);
      expect(followUp).toContain("No language server available");
    } finally {
      await lspService.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits lspService cleanly when the dep is not provided (the `diagnostics` tool is absent)", async () => {
    // No lspService ⇒ `diagnostics` isn't advertised; a model that calls it gets an error result, but
    // the loop continues, so the SECOND turn's final text still returns (the tool was simply absent).
    const { exec } = makeExecutor({
      scripts: [
        toolCallTurn("call_1", "diagnostics", { path: "notes.txt" }),
        finalTurn("answered without diagnostics"),
      ],
    });
    expect(await exec.run("q", OPTS)).toBe("answered without diagnostics");
  });
});

describe("EngineLeafExecutor.run — subagent (forkLeaf child leaf)", () => {
  it("runs a subagent as a child leaf: own agentId, shared budget, one level deep", async () => {
    const meterCalls: MeterUsageInput[] = [];
    const budget = new BudgetMeter({ rate: BUDGET_GUARDRAIL_RATE, startedAt: 0 });
    const sink = new RecordingSink();
    const { exec, requests } = makeExecutor({
      scripts: [
        // Parent turn 1: the model calls `subagent`.
        toolCallTurn("s1", "subagent", { prompt: "do the sub-task", name: "helper" }),
        // The child leaf's only model call.
        finalTurn("child result", { inputTokens: 10, outputTokens: 5 }),
        // Parent turn 2: the final answer after the subagent returns.
        finalTurn("parent final", { inputTokens: 3, outputTokens: 2 }),
      ],
      budget,
      meterCalls,
      sink,
    });

    const out = await exec.run("delegate it", OPTS);

    expect(out).toBe("parent final");
    // Three model calls: parent → child → parent (the child leaf actually executed).
    expect(requests).toHaveLength(3);
    // The parent was offered `subagent`; the child (second call) was NOT — delegation is one level.
    expect(requests[0]?.tools.some((t) => t.name === "subagent")).toBe(true);
    expect(requests[1]?.tools.some((t) => t.name === "subagent")).toBe(false);
    // The child leaf opened a turn under its OWN run-unique identity (agent-2).
    expect(sink.bodies.some((b) => b.kind === "turn_started" && b.agentId === "agent-2")).toBe(
      true,
    );
    // The child's usage rolled into the SAME run budget…
    expect(budget.snapshot().totalTokens).toBe(20); // 10+5 (child) + 3+2 (parent t2)
    // …and metered under its own leafIndex (2), distinct from the parent (1).
    expect(meterCalls.some((m) => m.leafIndex === 2 && m.inputTokens === 10)).toBe(true);
    expect(meterCalls.some((m) => m.leafIndex === 1)).toBe(true);
  });
});

describe("EngineLeafExecutor.run — leaf identity", () => {
  it("assigns a fresh 1-based agentId to each call", async () => {
    const ids: string[] = [];
    const sink: TurnEventSink = {
      emit: (body): RunEvent => ({ ...body, runId: "r", turnId: "t", seq: 1, t: 0 }),
      beginTurn: (_t, started) => {
        if (started.kind === "turn_started") ids.push(started.agentId);
      },
    };
    const { transport } = fakeTransport([finalTurn("a")]);
    const exec = new EngineLeafExecutor({
      inference: transport,
      budget: new BudgetMeter({ rate: BUDGET_GUARDRAIL_RATE, startedAt: 0 }),
      redactor: new SecretRedactor(),
      workspaceRoot: EMPTY_WORKSPACE,
      makeEventSink: (_i: number, _identity: AgentIdentity) => sink,
    });
    await exec.run("a", OPTS);
    await exec.run("b", OPTS);
    await exec.run("c", OPTS);
    expect(ids).toEqual(["agent-1", "agent-2", "agent-3"]);
  });
});
