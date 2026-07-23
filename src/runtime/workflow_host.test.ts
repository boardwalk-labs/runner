import { describe, it, expect, vi } from "vitest";
import { AppError, ErrorCode } from "./support/index.js";
import type {
  AgentOptions,
  ArtifactBody,
  ArtifactRef,
  BrowserSession,
  CallOptions,
  McpServerRef,
} from "@boardwalk-labs/workflow/runtime";
import type { BrowserSessionManager } from "./browser_session.js";
import {
  WorkerWorkflowHost,
  TimerSleepController,
  MAX_SLEEP_MS,
  parseTimeoutMs,
  type LeafExecutor,
  type ChildDispatcher,
  type HeldInputPort,
  type SecretAccessor,
  type SleepController,
  type PhaseController,
  type WorkerWorkflowHostDeps,
} from "./workflow_host.js";
import { LeafParked } from "@boardwalk-labs/engine/core";
import { RunAbortedError } from "./run_abort.js";

/** A complete ChildDispatcher fake — fills start/poll (the durable callWorkflow seam) so each test
 *  only overrides the method it exercises. */
function childStub(over: Partial<ChildDispatcher> = {}): ChildDispatcher {
  return {
    call: () => Promise.resolve({ output: { ok: true }, outputSchema: null }),
    poll: () => Promise.resolve(null),
    start: () =>
      Promise.resolve({
        childRunId: "child_1",
        status: "completed",
        output: { ok: true },
        outputSchema: null,
      }),
    run: () => Promise.resolve("run_1"),
    schedule: () => Promise.resolve("sched_1"),
    ...over,
  };
}

function makeHost(
  over: Partial<{
    leaf: LeafExecutor;
    children: ChildDispatcher;
    secrets: SecretAccessor;
    writeArtifact: (
      name: string,
      contentType: string,
      body: ArtifactBody,
      metadata: Record<string, unknown> | undefined,
    ) => Promise<ArtifactRef>;
    sleeper: SleepController;
    now: () => number;
    signal: AbortSignal;
    onBeforeSleep: () => Promise<void>;
    phases: PhaseController;
    heldInput: HeldInputPort;
    heldPollIntervalMs: number;
    browserSessions: BrowserSessionManager;
    shell: NonNullable<WorkerWorkflowHostDeps["shell"]>;
    usage: NonNullable<WorkerWorkflowHostDeps["usage"]>;
    budgetGate: NonNullable<WorkerWorkflowHostDeps["budgetGate"]>;
  }> = {},
): { host: WorkerWorkflowHost; held: number[] } {
  const held: number[] = [];
  const sleeper: SleepController = over.sleeper ?? {
    hold: (ms) => {
      held.push(ms);
      return Promise.resolve();
    },
  };
  const host = new WorkerWorkflowHost({
    leaf: over.leaf ?? { run: () => Promise.resolve("leaf") },
    children: over.children ?? childStub(),
    secrets: over.secrets ?? { get: () => Promise.resolve("sek") },
    runtime: {
      runId: "run_test",
      workflowId: "wf_test",
      orgId: "org_test",
      apiUrl: "https://api.test",
      apiToken: () => Promise.resolve("api-token-test"),
      idToken: () => Promise.resolve("id-token-test"),
    },
    sleeper,
    ...(over.writeArtifact ? { writeArtifact: over.writeArtifact } : {}),
    ...(over.now ? { now: over.now } : {}),
    ...(over.signal ? { signal: over.signal } : {}),
    ...(over.onBeforeSleep ? { onBeforeSleep: over.onBeforeSleep } : {}),
    ...(over.phases ? { phases: over.phases } : {}),
    ...(over.heldInput ? { heldInput: over.heldInput } : {}),
    ...(over.heldPollIntervalMs !== undefined
      ? { heldPollIntervalMs: over.heldPollIntervalMs }
      : {}),
    ...(over.browserSessions ? { browserSessions: over.browserSessions } : {}),
    ...(over.shell ? { shell: over.shell } : {}),
    ...(over.usage ? { usage: over.usage } : {}),
    ...(over.budgetGate ? { budgetGate: over.budgetGate } : {}),
  });
  return { host, held };
}

/** A controller pre-aborted with a credit-exhaustion reason. */
function abortedSignal(): AbortSignal {
  const c = new AbortController();
  c.abort(new RunAbortedError("credit_exhausted"));
  return c.signal;
}

describe("WorkerWorkflowHost — delegation", () => {
  it("agent() delegates to the leaf executor", async () => {
    const calls: { prompt: string; opts: AgentOptions | undefined }[] = [];
    const { host } = makeHost({
      leaf: {
        run: (prompt, opts) => {
          calls.push({ prompt, opts });
          return Promise.resolve({ x: 1 });
        },
      },
    });
    const out = await host.agent("do", { model: "bedrock/x" });
    expect(out).toEqual({ x: 1 });
    expect(calls).toEqual([{ prompt: "do", opts: { model: "bedrock/x" } }]);
  });

  it("callWorkflow() delegates to the child dispatcher", async () => {
    const calls: { slug: string; input: unknown; opts: CallOptions | undefined }[] = [];
    const { host } = makeHost({
      children: childStub({
        call: (slug, input, opts) => {
          calls.push({ slug, input, opts });
          return Promise.resolve({ output: "child-out", outputSchema: null });
        },
      }),
    });
    const out = await host.callWorkflow("child", { a: 1 }, { idempotencyKey: "k" });
    expect(out).toEqual({ output: "child-out", outputSchema: null });
    expect(calls).toEqual([{ slug: "child", input: { a: 1 }, opts: { idempotencyKey: "k" } }]);
  });

  it("runWorkflow() delegates fire-and-forget to the child dispatcher and returns the run id", async () => {
    const calls: { slug: string; input: unknown; opts: CallOptions | undefined }[] = [];
    const { host } = makeHost({
      children: childStub({
        run: (slug, input, opts) => {
          calls.push({ slug, input, opts });
          return Promise.resolve("run_child_42");
        },
      }),
    });
    const runId = await host.runWorkflow("nightly", { full: true }, undefined);
    expect(runId).toBe("run_child_42");
    expect(calls).toEqual([{ slug: "nightly", input: { full: true }, opts: undefined }]);
  });

  it("scheduleWorkflow() delegates to the child dispatcher and returns the schedule id", async () => {
    const calls: { slug: string; input: unknown; opts: unknown }[] = [];
    const { host } = makeHost({
      children: childStub({
        schedule: (slug, input, opts) => {
          calls.push({ slug, input, opts });
          return Promise.resolve("sched_99");
        },
      }),
    });
    const id = await host.scheduleWorkflow(
      "daily-report",
      { team: "growth" },
      {
        cron: "0 9 * * 1",
        timezone: "UTC",
      },
    );
    expect(id).toBe("sched_99");
    expect(calls).toEqual([
      {
        slug: "daily-report",
        input: { team: "growth" },
        opts: { cron: "0 9 * * 1", timezone: "UTC" },
      },
    ]);
  });

  it("writeArtifact() delegates to the injected artifact store", async () => {
    const writes: { name: string; contentType: string; body: ArtifactBody }[] = [];
    const { host } = makeHost({
      writeArtifact: (name, contentType, body) => {
        writes.push({ name, contentType, body });
        return Promise.resolve({ id: "art_9", name, url: `https://cdn/${name}` });
      },
    });
    const ref = await host.writeArtifact("poem.txt", "text/plain", "hi", { run: "r1" });
    expect(ref).toEqual({ id: "art_9", name: "poem.txt", url: "https://cdn/poem.txt" });
    expect(writes).toEqual([{ name: "poem.txt", contentType: "text/plain", body: "hi" }]);
  });

  it("writeArtifact() rejects clearly when no store is wired (artifacts.write unsupported)", async () => {
    const { host } = makeHost(); // no writeArtifact
    await expect(host.writeArtifact("a.txt", "text/plain", "hi", undefined)).rejects.toThrow(
      /artifacts\.write is not available/,
    );
  });

  it("getSecret() delegates to the secret accessor", async () => {
    const names: string[] = [];
    const { host } = makeHost({
      secrets: {
        get: (name) => {
          names.push(name);
          return Promise.resolve("tok_123");
        },
      },
    });
    expect(await host.getSecret("LINEAR_TOKEN")).toBe("tok_123");
    expect(names).toEqual(["LINEAR_TOKEN"]);
  });
});

describe("WorkerWorkflowHost — phase markers", () => {
  it("setPhase() delegates synchronously to the phase controller", () => {
    const phases: { name: string; opts: unknown }[] = [];
    const { host } = makeHost({
      phases: {
        set: (name, opts) => {
          phases.push({ name, opts });
        },
        capture: () => null,
        runInPhase: (_phaseId, fn) => fn(),
      },
    });
    host.setPhase("Install dependencies", { id: "install" });
    expect(phases).toEqual([{ name: "Install dependencies", opts: { id: "install" } }]);
  });

  it("captures phase context at hook entry and runs the delegate inside it", async () => {
    const captured: (string | null)[] = [];
    const phases: PhaseController = {
      set: () => undefined,
      capture: () => "phase-1",
      runInPhase: async (phaseId, fn) => {
        captured.push(phaseId);
        return await fn();
      },
    };
    const { host } = makeHost({ phases });
    await host.agent("go", undefined);
    await host.sleep(0);
    expect(captured).toEqual(["phase-1", "phase-1"]);
  });
});

describe("WorkerWorkflowHost — sleep argument resolution", () => {
  it("holds for a bare millisecond number", async () => {
    const { host, held } = makeHost();
    await host.sleep(5000);
    expect(held).toEqual([5000]);
  });

  it("holds for { durationMs }", async () => {
    const { host, held } = makeHost();
    await host.sleep({ durationMs: 1234 });
    expect(held).toEqual([1234]);
  });

  it("computes the hold from { until } as an ISO string", async () => {
    const now = 1_000_000;
    const { host, held } = makeHost({ now: () => now });
    await host.sleep({ until: new Date(now + 60_000).toISOString() });
    expect(held).toEqual([60_000]);
  });

  it("computes the hold from { until } as a Date", async () => {
    const now = 2_000_000;
    const { host, held } = makeHost({ now: () => now });
    await host.sleep({ until: new Date(now + 7_500) });
    expect(held).toEqual([7_500]);
  });

  it("treats an `until` already in the past as a no-op (skips the hold)", async () => {
    const now = 5_000_000;
    const { host, held } = makeHost({ now: () => now });
    await host.sleep({ until: new Date(now - 60_000) });
    expect(held).toEqual([]);
  });

  it("treats a non-positive number as a no-op (skips the hold)", async () => {
    const { host, held } = makeHost();
    await host.sleep(-100);
    expect(held).toEqual([]);
  });

  it("calls onBeforeSleep (workspace persist) BEFORE a real hold, but not for a no-op hold", async () => {
    const order: string[] = [];
    const { host } = makeHost({
      sleeper: {
        hold: (ms) => {
          order.push(`hold:${String(ms)}`);
          return Promise.resolve();
        },
      },
      onBeforeSleep: () => {
        order.push("persist");
        return Promise.resolve();
      },
    });
    await host.sleep(5000);
    await host.sleep(0); // no-op → neither persist nor hold
    expect(order).toEqual(["persist", "hold:5000"]);
  });
});

describe("WorkerWorkflowHost — sleep guards", () => {
  it("rejects a hold beyond the 7-day cap", async () => {
    const { host } = makeHost();
    await expect(host.sleep(MAX_SLEEP_MS + 1)).rejects.toBeInstanceOf(AppError);
    await host.sleep(MAX_SLEEP_MS + 1).catch((err: unknown) => {
      expect((err as AppError).code).toBe(ErrorCode.VALIDATION_FAILED);
    });
  });

  it("rejects an `until` beyond the cap", async () => {
    const now = 0;
    const { host } = makeHost({ now: () => now });
    await expect(host.sleep({ until: new Date(MAX_SLEEP_MS + 1000) })).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("rejects an unparseable `until`", async () => {
    const { host } = makeHost();
    await expect(host.sleep({ until: "not-a-date" })).rejects.toThrow(/parse sleep/);
  });
});

describe("WorkerWorkflowHost — cooperative cancellation", () => {
  it("agent() throws RunAbortedError when the signal is already aborted (never reaches the leaf)", async () => {
    const leaf = vi.fn(() => Promise.resolve("leaf"));
    const { host } = makeHost({ leaf: { run: leaf }, signal: abortedSignal() });
    await expect(host.agent("do", undefined)).rejects.toBeInstanceOf(RunAbortedError);
    expect(leaf).not.toHaveBeenCalled();
  });

  it("threads the signal into the leaf and the child dispatcher when NOT aborted", async () => {
    const c = new AbortController();
    let leafSignal: AbortSignal | undefined;
    let childSignal: AbortSignal | undefined;
    const { host } = makeHost({
      leaf: {
        run: (_p, _o, signal) => {
          leafSignal = signal;
          return Promise.resolve("ok");
        },
      },
      children: childStub({
        call: (_s, _i, _o, signal) => {
          childSignal = signal;
          return Promise.resolve({ output: "out", outputSchema: null });
        },
      }),
      signal: c.signal,
    });
    await host.agent("p", undefined);
    await host.callWorkflow("child", {}, undefined);
    expect(leafSignal).toBe(c.signal);
    expect(childSignal).toBe(c.signal);
  });

  it.each(["callWorkflow", "runWorkflow", "getSecret", "sleep"] as const)(
    "%s throws RunAbortedError when the signal is already aborted (never delegates)",
    async (hook) => {
      const calls: string[] = [];
      const record = (tag: string): void => {
        calls.push(tag);
      };
      const { host } = makeHost({
        leaf: {
          run: () => {
            record("leaf");
            return Promise.resolve("x");
          },
        },
        children: childStub({
          call: () => {
            record("call");
            return Promise.resolve({ output: null, outputSchema: null });
          },
          start: () => {
            record("call");
            return Promise.resolve({
              childRunId: "c",
              status: "running",
              output: null,
              outputSchema: null,
            });
          },
          run: () => {
            record("run");
            return Promise.resolve("r");
          },
          schedule: () => {
            record("schedule");
            return Promise.resolve("s");
          },
        }),
        secrets: {
          get: () => {
            record("secret");
            return Promise.resolve("s");
          },
        },
        sleeper: {
          hold: () => {
            record("hold");
            return Promise.resolve();
          },
        },
        signal: abortedSignal(),
      });
      const invoke = {
        callWorkflow: () => host.callWorkflow("c", {}, undefined),
        runWorkflow: () => host.runWorkflow("c", {}, undefined),
        getSecret: () => host.getSecret("S"),
        sleep: () => host.sleep(1000),
      }[hook];
      await expect(invoke()).rejects.toBeInstanceOf(RunAbortedError);
      expect(calls).toEqual([]); // the delegate was never reached
    },
  );
});

describe("TimerSleepController", () => {
  it("resolves immediately for a non-positive hold", async () => {
    const ctl = new TimerSleepController();
    await expect(ctl.hold(0)).resolves.toBeUndefined();
  });

  it("resolves after the timer for a positive hold", async () => {
    vi.useFakeTimers();
    try {
      const ctl = new TimerSleepController();
      let done = false;
      const p = ctl.hold(10_000).then(() => {
        done = true;
      });
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      await p;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const ctl = new TimerSleepController();
    await expect(ctl.hold(10_000, abortedSignal())).rejects.toBeInstanceOf(RunAbortedError);
  });

  it("rejects + clears the timer when aborted mid-hold (no lingering timer)", async () => {
    vi.useFakeTimers();
    try {
      const ctl = new TimerSleepController();
      const c = new AbortController();
      const p = ctl.hold(7 * 24 * 60 * 60 * 1000, c.signal); // a 7-day hold
      const rejected = expect(p).rejects.toBeInstanceOf(RunAbortedError);
      c.abort(new RunAbortedError("credit_exhausted"));
      await rejected;
      // The timer was cleared on abort, so no pending timers remain to keep the loop alive.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WorkerWorkflowHost — hold-in-process waits (no freeze substrate)", () => {
  /** A HeldInputPort whose poll returns nothing `misses` times, then the given answers. */
  function fakeHeldInput(
    answers: Record<string, unknown>,
    misses = 0,
  ): { port: HeldInputPort; registered: { seq: number; gate: unknown }[]; polls: () => number } {
    const registered: { seq: number; gate: unknown }[] = [];
    let polls = 0;
    const port: HeldInputPort = {
      register: (seq, gate) => {
        registered.push({ seq, gate });
        return Promise.resolve(undefined);
      },
      poll: () => {
        polls += 1;
        return Promise.resolve(polls > misses ? answers : {});
      },
    };
    return { port, registered, polls: () => polls };
  }

  it("humanInput(): registers the gate, holds polling, and returns the normalized answer", async () => {
    const { port, registered } = fakeHeldInput(
      { approve: { value: "yes", isOther: false } },
      2, // two empty polls first — proves the seam holds across misses
    );
    const { host } = makeHost({ heldInput: port, heldPollIntervalMs: 1 });
    const result = await host.humanInput({
      prompt: "Ship it?",
      input: { kind: "choice", options: ["yes", "no"] },
      key: "approve",
    });
    expect(result).toEqual({ value: "yes", isOther: false });
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ seq: 1, gate: { key: "approve", prompt: "Ship it?" } });
  });

  it("humanInput(): carries the timeout expiry + onTimeout on the registered gate", async () => {
    const { port, registered } = fakeHeldInput({ "seam-1": { value: "ok" } });
    const { host } = makeHost({ heldInput: port, heldPollIntervalMs: 1, now: () => 1000 });
    await host.humanInput({ prompt: "Q", input: { kind: "text" }, timeout: "48h" });
    expect(registered[0]?.gate).toMatchObject({
      expiresAt: 1000 + 48 * 3_600_000,
      onTimeout: "fail",
    });
  });

  it("humanInput(): rejects clearly when neither freeze nor heldInput is wired", async () => {
    const { host } = makeHost();
    await expect(host.humanInput({ prompt: "Q", input: { kind: "text" } })).rejects.toThrow(
      /humanInput is not available/,
    );
  });

  it("humanInput(): the poll loop rejects promptly when the run aborts mid-hold", async () => {
    const registered: { seq: number; gate: unknown }[] = [];
    const controller = new AbortController();
    const port: HeldInputPort = {
      register: (seq, gate) => {
        registered.push({ seq, gate });
        return Promise.resolve(undefined);
      },
      poll: () => {
        // Never answered; abort after the first empty poll.
        controller.abort(new RunAbortedError("cancelled"));
        return Promise.resolve({});
      },
    };
    const { host } = makeHost({
      heldInput: port,
      heldPollIntervalMs: 1,
      signal: controller.signal,
    });
    await expect(host.humanInput({ prompt: "Q", input: { kind: "text" } })).rejects.toThrow(
      RunAbortedError,
    );
  });

  it("agent(): a parked leaf holds for the answer and re-enters with ACCUMULATED answers", async () => {
    const checkpoint = { messages: [], iteration: 1, totals: { inputTokens: 1, outputTokens: 1 } };
    const resumes: unknown[] = [];
    let call = 0;
    const leaf: LeafExecutor = {
      run: (_p, _o, _s, resume) => {
        resumes.push(resume);
        call += 1;
        if (call === 1) {
          const err = new LeafParked({ toolCallId: "tc_1", prompt: "First?", inputSpec: {} });
          err.checkpoint = checkpoint;
          return Promise.reject(err);
        }
        if (call === 2) {
          const err = new LeafParked({ toolCallId: "tc_2", prompt: "Second?", inputSpec: {} });
          err.checkpoint = checkpoint;
          return Promise.reject(err);
        }
        return Promise.resolve("leaf-done");
      },
    };
    const { port, registered } = fakeHeldInput({ tc_1: "yes", tc_2: "no" });
    const { host } = makeHost({ leaf, heldInput: port, heldPollIntervalMs: 1 });
    expect(await host.agent("ask", { model: "m" })).toBe("leaf-done");
    // Both gates registered under the SAME leaf seq; each re-entry saw every earlier answer.
    expect(registered.map((r) => r.seq)).toEqual([1, 1]);
    expect(resumes[1]).toMatchObject({ checkpoint, answers: { tc_1: "yes" } });
    expect(resumes[2]).toMatchObject({ checkpoint, answers: { tc_1: "yes", tc_2: "no" } });
  });

  it("sleep(): a wait of ANY length holds in-process — no suspend without a freeze substrate", async () => {
    const { host, held } = makeHost();
    await host.sleep(60_000); // ≥ the snapshot threshold, still a hold here
    expect(held).toEqual([60_000]);
  });
});

describe("parseTimeoutMs", () => {
  it("parses s/m/h/d units", () => {
    expect(parseTimeoutMs("90s")).toBe(90_000);
    expect(parseTimeoutMs("30m")).toBe(1_800_000);
    expect(parseTimeoutMs("48h")).toBe(172_800_000);
    expect(parseTimeoutMs("7d")).toBe(604_800_000);
  });
  it("returns null for absent/unparseable input", () => {
    expect(parseTimeoutMs(undefined)).toBeNull();
    expect(parseTimeoutMs("soon")).toBeNull();
    expect(parseTimeoutMs("")).toBeNull();
  });
});

describe("WorkerWorkflowHost — callWorkflow (hold path)", () => {
  it("holds in-process via the dispatcher's call() and returns the child's output", async () => {
    const call = vi.fn(() =>
      Promise.resolve({ output: { said: "child-done" }, outputSchema: null }),
    );
    const { host } = makeHost({ children: childStub({ call }) });
    expect(await host.callWorkflow("child-wf", { a: 1 }, undefined)).toEqual({
      output: { said: "child-done" },
      outputSchema: null,
    });
    expect(call).toHaveBeenCalledWith("child-wf", { a: 1 }, undefined, undefined);
  });
});

describe("computer.openBrowser + agent({ session })", () => {
  function fakeManager(over: Partial<BrowserSessionManager> = {}): BrowserSessionManager {
    return {
      open: vi.fn().mockResolvedValue({ id: "sess_1" }),
      mcpRefFor: vi.fn().mockReturnValue(null),
      closeAll: vi.fn().mockResolvedValue(undefined),
      ...over,
    } as unknown as BrowserSessionManager;
  }

  it("openBrowserSession rejects when no browser backend is wired", async () => {
    const { host } = makeHost();
    await expect(host.openBrowserSession(undefined)).rejects.toThrow(/not available/);
  });

  it("openBrowserSession delegates to the manager", async () => {
    const session = { id: "sess_9" } as BrowserSession;
    const open = vi.fn().mockResolvedValue(session);
    const { host } = makeHost({ browserSessions: fakeManager({ open }) });
    await expect(host.openBrowserSession({ startUrl: "https://x" })).resolves.toBe(session);
    expect(open).toHaveBeenCalledWith({ startUrl: "https://x" });
  });

  it("agent({ session }) injects the session's http MCP ref and strips the handle", async () => {
    const session = { id: "sess_1" } as BrowserSession;
    const ref: McpServerRef = {
      name: "browser-sess_1",
      transport: "http",
      url: "http://127.0.0.1:9/mcp",
    };
    let seenOpts: AgentOptions | undefined;
    const { host } = makeHost({
      leaf: {
        run: (_p, opts) => {
          seenOpts = opts;
          return Promise.resolve("ok");
        },
      },
      browserSessions: fakeManager({ mcpRefFor: vi.fn().mockReturnValue(ref) }),
    });
    await host.agent("drive", { session, mcp: [] });
    expect(seenOpts?.session).toBeUndefined();
    expect(seenOpts?.mcp).toEqual([ref]);
  });

  it("agent({ session }) throws for a session not open in this run", async () => {
    const { host } = makeHost({
      browserSessions: fakeManager({ mcpRefFor: vi.fn().mockReturnValue(null) }),
    });
    await expect(
      host.agent("drive", { session: { id: "ghost" } as BrowserSession }),
    ).rejects.toThrow(/not open in this run/);
  });
});

describe("WorkerWorkflowHost — the redesign's protocol capabilities (shell / usage / auth)", () => {
  const ZERO_USAGE = {
    usd: { spent: 0, cap: null, remaining: null },
    tokens: { spent: 0, cap: null, remaining: null },
    compute_seconds: { spent: 0, cap: null, remaining: null },
  };

  it("shell() delegates to the injected runner under the abort guard", async () => {
    const seen: string[] = [];
    const { host } = makeHost({
      shell: (cmd) => {
        seen.push(cmd);
        return Promise.resolve({ exitCode: 0, stdout: "out", stderr: "" });
      },
    });
    await expect(host.shell("echo hi", undefined)).resolves.toEqual({
      exitCode: 0,
      stdout: "out",
      stderr: "",
    });
    expect(seen).toEqual(["echo hi"]);
  });

  it("shell() fails CLOSED when no runner is wired", async () => {
    const { host } = makeHost();
    await expect(host.shell("echo hi", undefined)).rejects.toThrow(/shell is not available/);
  });

  it("shell() rejects promptly on an aborted run", async () => {
    const { host } = makeHost({
      signal: abortedSignal(),
      shell: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
    });
    await expect(host.shell("echo hi", undefined)).rejects.toBeInstanceOf(RunAbortedError);
  });

  it("usage() serves the injected live snapshot; fails CLOSED without one", async () => {
    const { host } = makeHost({ usage: () => ZERO_USAGE });
    await expect(host.usage()).resolves.toEqual(ZERO_USAGE);
    const bare = makeHost();
    await expect(bare.host.usage()).rejects.toThrow(/usage.get is not available/);
  });

  it("idToken()/apiToken() delegate to the runtime context mints", async () => {
    const { host } = makeHost();
    await expect(host.idToken("sts.amazonaws.com")).resolves.toBe("id-token-test");
    await expect(host.apiToken()).resolves.toBe("api-token-test");
  });

  it("the auth mints honor the abort guard too", async () => {
    const { host } = makeHost({ signal: abortedSignal() });
    await expect(host.idToken("aud")).rejects.toBeInstanceOf(RunAbortedError);
    await expect(host.apiToken()).rejects.toBeInstanceOf(RunAbortedError);
  });
});

describe("WorkerWorkflowHost — budget-gate park points (sleep / shell / workflows.call)", () => {
  /** A gate stub that records clearances and can reject like a declined budget gate. */
  function gateStub(fail = false): { clear(): Promise<void>; cleared: number[] } {
    const stub = {
      cleared: [] as number[],
      clear: (): Promise<void> => {
        stub.cleared.push(1);
        return fail
          ? Promise.reject(new Error("Run cancelled at the budget gate."))
          : Promise.resolve();
      },
    };
    return stub;
  }

  it("sleep() awaits budget clearance BEFORE holding", async () => {
    const gate = gateStub();
    const { host, held } = makeHost({ budgetGate: gate });
    await host.sleep(5);
    expect(gate.cleared).toHaveLength(1);
    expect(held).toEqual([5]);
  });

  it("shell() awaits budget clearance BEFORE starting the command", async () => {
    const order: string[] = [];
    const { host } = makeHost({
      budgetGate: {
        clear: () => {
          order.push("clear");
          return Promise.resolve();
        },
      },
      shell: (cmd) => {
        order.push(`shell:${cmd}`);
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
    });
    await host.shell("sleep 10000", undefined);
    expect(order).toEqual(["clear", "shell:sleep 10000"]);
  });

  it("workflows.call awaits budget clearance BEFORE dispatching the child", async () => {
    const gate = gateStub();
    const calls: string[] = [];
    const { host } = makeHost({
      budgetGate: gate,
      children: {
        call: (slug: string) => {
          calls.push(slug);
          return Promise.resolve({ output: "child-out", outputSchema: null });
        },
        poll: () => Promise.reject(new Error("unused")),
        start: () => Promise.reject(new Error("unused")),
        run: () => Promise.reject(new Error("unused")),
        schedule: () => Promise.reject(new Error("unused")),
      },
    });
    await expect(host.callWorkflow("child", {}, undefined)).resolves.toEqual({
      output: "child-out",
      outputSchema: null,
    });
    expect(gate.cleared).toHaveLength(1);
    expect(calls).toEqual(["child"]);
  });

  it("a declined gate (cancel) rejects the seam and never starts the work", async () => {
    const gate = gateStub(true);
    const seen: string[] = [];
    const { host, held } = makeHost({
      budgetGate: gate,
      shell: (cmd) => {
        seen.push(cmd);
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
    });
    await expect(host.sleep(5)).rejects.toThrow(/cancelled at the budget gate/);
    await expect(host.shell("echo hi", undefined)).rejects.toThrow(/cancelled at the budget gate/);
    expect(held).toEqual([]); // never slept
    expect(seen).toEqual([]); // never ran
  });

  it("without a gate wired, the seams behave exactly as before", async () => {
    const { host, held } = makeHost();
    await host.sleep(5);
    expect(held).toEqual([5]);
  });
});
