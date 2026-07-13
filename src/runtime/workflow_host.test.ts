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
  type SecretAccessor,
  type SleepController,
  type PhaseController,
} from "./workflow_host.js";
import { seamFingerprint, type JournalSeam, type SuspendSignal } from "./suspension.js";
import { RunAbortedError } from "./run_abort.js";

/** A complete ChildDispatcher fake — fills start/poll (the durable callWorkflow seam) so each test
 *  only overrides the method it exercises. */
function childStub(over: Partial<ChildDispatcher> = {}): ChildDispatcher {
  return {
    call: () => Promise.resolve({ ok: true }),
    start: () =>
      Promise.resolve({ childRunId: "child_1", status: "completed", output: { ok: true } }),
    poll: () => Promise.resolve(null),
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
    journal: JournalSeam;
    onSuspend: (signal: SuspendSignal) => void;
    replayFrontier: number;
    browserSessions: BrowserSessionManager;
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
    ...(over.journal ? { journal: over.journal } : {}),
    ...(over.onSuspend ? { onSuspend: over.onSuspend } : {}),
    ...(over.replayFrontier !== undefined ? { replayFrontier: over.replayFrontier } : {}),
    ...(over.browserSessions ? { browserSessions: over.browserSessions } : {}),
  });
  return { host, held };
}

/** An in-memory journal seam backed by a Map, seeded with pre-existing entries (replay fixtures). */
function fakeJournal(
  seed: Record<number, Parameters<JournalSeam["put"]>[0] & { state?: string }> = {},
): {
  journal: JournalSeam;
  puts: Parameters<JournalSeam["put"]>[0][];
  store: Map<number, { kind: string; fingerprint: string; state: string; result: unknown }>;
} {
  const store = new Map<
    number,
    { kind: string; fingerprint: string; state: string; result: unknown }
  >();
  for (const [seq, e] of Object.entries(seed)) {
    store.set(Number(seq), {
      kind: e.kind,
      fingerprint: e.fingerprint,
      state: e.state ?? "resolved",
      result: e.result ?? null,
    });
  }
  const puts: Parameters<JournalSeam["put"]>[0][] = [];
  const journal: JournalSeam = {
    get: (seq) => {
      const e = store.get(seq);
      if (e === undefined) return Promise.resolve(null);
      return Promise.resolve({
        seq,
        kind: e.kind as never,
        fingerprint: e.fingerprint,
        state: e.state as never,
        result: e.result,
      });
    },
    put: (entry) => {
      puts.push(entry);
      store.set(entry.seq, {
        kind: entry.kind,
        fingerprint: entry.fingerprint,
        state: "resolved",
        result: entry.result,
      });
      return Promise.resolve();
    },
  };
  return { journal, puts, store };
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
          return Promise.resolve("child-out");
        },
      }),
    });
    const out = await host.callWorkflow("child", { a: 1 }, { idempotencyKey: "k" });
    expect(out).toBe("child-out");
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
          return Promise.resolve("out");
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
            return Promise.resolve(null);
          },
          start: () => {
            record("call");
            return Promise.resolve({ childRunId: "c", status: "running", output: null });
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

describe("WorkerWorkflowHost — durable suspension", () => {
  const FP = (parts: readonly unknown[]): string => seamFingerprint(parts);

  it("agent(): a resolved journal hit returns the memoized result without running the leaf", async () => {
    const leaf = vi.fn(() => Promise.resolve("fresh"));
    const fp = FP(["agent", null, "test-model", "do it", null]);
    const { journal } = fakeJournal({
      1: { seq: 1, kind: "agent", fingerprint: fp, label: "", result: "memoized" },
    });
    const { host } = makeHost({ leaf: { run: leaf }, journal });
    expect(await host.agent("do it", { model: "test-model" })).toBe("memoized");
    expect(leaf).not.toHaveBeenCalled();
  });

  it("agent(): a miss runs the leaf and journals the resolved result", async () => {
    const { journal, puts } = fakeJournal();
    const { host } = makeHost({ leaf: { run: () => Promise.resolve("answer") }, journal });
    expect(await host.agent("prompt", { model: "m" })).toBe("answer");
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ seq: 1, kind: "agent", result: "answer" });
  });

  it("agent(): a fingerprint mismatch on replay is a determinism error", async () => {
    const { journal } = fakeJournal({
      1: { seq: 1, kind: "agent", fingerprint: "STALE", label: "", result: "x" },
    });
    const { host } = makeHost({ leaf: { run: () => Promise.resolve("y") }, journal });
    await expect(host.agent("changed prompt", { model: "m" })).rejects.toThrow(
      /Nondeterministic replay/,
    );
  });

  it("agent(): a suspended journal entry resumes the leaf from its checkpoint + answers", async () => {
    const fp = FP(["agent", null, "m", "ask", null]);
    let resumeArg: unknown;
    const checkpoint = { messages: [], iteration: 2, totals: { inputTokens: 1, outputTokens: 1 } };
    const { journal } = fakeJournal({
      1: {
        seq: 1,
        kind: "agent",
        fingerprint: fp,
        label: "",
        state: "suspended",
        result: { checkpoint, answers: { tc_1: "yes" } },
      },
    });
    const { host } = makeHost({
      leaf: {
        run: (_p, _o, _s, resume) => {
          resumeArg = resume;
          return Promise.resolve("done");
        },
      },
      journal,
    });
    expect(await host.agent("ask", { model: "m" })).toBe("done");
    expect(resumeArg).toEqual({ checkpoint, answers: { tc_1: "yes" } });
  });

  it("humanInput(): suspends with a gate when there is no answer yet (SuspendError path)", async () => {
    const { journal } = fakeJournal();
    const { host } = makeHost({ journal });
    const err = await host
      .humanInput({
        prompt: "Ship it?",
        input: { kind: "choice", options: ["yes", "no"] },
        key: "approve",
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      name: "SuspendError",
      signal: { reason: "human_input", seq: 1, humanInput: { key: "approve", prompt: "Ship it?" } },
    });
  });

  it("humanInput(): a resolved journal entry returns the validated answer (no re-suspend)", async () => {
    const fp = FP([
      "human_input",
      "approve",
      "Ship it?",
      { kind: "choice", options: ["yes", "no"] },
    ]);
    const { journal } = fakeJournal({
      1: {
        seq: 1,
        kind: "human_input",
        fingerprint: fp,
        label: "",
        result: { value: "yes", isOther: false },
      },
    });
    const { host } = makeHost({ journal });
    const result = await host.humanInput({
      prompt: "Ship it?",
      input: { kind: "choice", options: ["yes", "no"] },
      key: "approve",
    });
    expect(result).toEqual({ value: "yes", isOther: false });
  });

  it("humanInput(): calls onSuspend (never resolving) when wired, with the timeout expiry", async () => {
    const { journal } = fakeJournal();
    let captured: SuspendSignal | undefined;
    const { host } = makeHost({ journal, now: () => 1000, onSuspend: (s) => (captured = s) });
    // The seam never resolves with onSuspend wired; flush microtasks and assert on the captured signal.
    void host.humanInput({ prompt: "Q", input: { kind: "text" }, timeout: "48h" });
    await new Promise((r) => setTimeout(r, 0));
    expect(captured?.reason).toBe("human_input");
    expect(captured?.humanInput?.expiresAt).toBe(1000 + 48 * 3_600_000);
  });

  it("step(): memoizes its result and skips fn on replay", async () => {
    const fn = vi.fn(() => Promise.resolve({ n: 7 }));
    const { journal, puts } = fakeJournal();
    const { host } = makeHost({ journal });
    expect(await host.step("compute", fn)).toEqual({ n: 7 });
    expect(puts[0]).toMatchObject({ seq: 1, kind: "step", label: "compute" });

    // Replay: a resolved hit returns without calling fn.
    const fp = FP(["step", "compute"]);
    const replay = fakeJournal({
      1: { seq: 1, kind: "step", fingerprint: fp, label: "", result: { n: 7 } },
    });
    const fn2 = vi.fn(() => Promise.resolve({ n: 99 }));
    const { host: host2 } = makeHost({ journal: replay.journal });
    expect(await host2.step("compute", fn2)).toEqual({ n: 7 });
    expect(fn2).not.toHaveBeenCalled();
  });

  it("sleep(): suspends above the threshold (release), holds below it", async () => {
    const { journal } = fakeJournal();
    const suspends: SuspendSignal[] = [];
    const { host, held } = makeHost({ journal, onSuspend: (s) => suspends.push(s) });
    await host.sleep(1000); // below 30s → holds
    expect(held).toEqual([1000]);
    void host.sleep(60_000); // above 30s → suspends (never resolves)
    await new Promise((r) => setTimeout(r, 0));
    expect(suspends).toHaveLength(1);
    expect(suspends[0]).toMatchObject({ reason: "sleep", durationMs: 60_000 });
  });

  it("sleep(): a journaled (elapsed) sleep replays past instantly", async () => {
    const fp = FP(["sleep"]);
    const { journal } = fakeJournal({
      1: { seq: 1, kind: "sleep", fingerprint: fp, label: "sleep", result: null },
    });
    const { host, held } = makeHost({ journal });
    await host.sleep(60_000);
    expect(held).toEqual([]); // neither held nor suspended — already elapsed
  });

  it("setPhase + isReplaying: suppressed below the replay frontier, live at/after it", async () => {
    const set = vi.fn();
    const phases: PhaseController = {
      set,
      capture: () => null,
      runInPhase: (_id, fn) => fn(),
    };
    const { journal } = fakeJournal();
    // Frontier 2: seam 1 replays (suppressed), seam 2 crosses the frontier (live).
    const { host } = makeHost({ journal, phases, replayFrontier: 2 });
    expect(host.isReplaying()).toBe(true);
    host.setPhase("early", undefined); // replaying → suppressed
    expect(set).not.toHaveBeenCalled();
    await host.step("seam-1", () => Promise.resolve(1)); // seq 1
    await host.step("seam-2", () => Promise.resolve(2)); // seq 2 → crosses frontier → live
    expect(host.isReplaying()).toBe(false);
    host.setPhase("late", undefined); // live → emitted
    expect(set).toHaveBeenCalledWith("late", undefined);
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

describe("WorkerWorkflowHost — callWorkflow durable seam", () => {
  const FP = (parts: readonly unknown[]): string => seamFingerprint(parts);

  it("returns the memoized child output on a resolved journal hit (never re-starts the child)", async () => {
    const start = vi.fn(() =>
      Promise.resolve({ childRunId: "c", status: "completed", output: "fresh" }),
    );
    const fp = FP(["workflow_call", "child-wf", { a: 1 }, null]);
    const { journal } = fakeJournal({
      1: { seq: 1, kind: "workflow_call", fingerprint: fp, label: "", result: "memoized" },
    });
    const { host } = makeHost({ children: childStub({ start }), journal });
    expect(await host.callWorkflow("child-wf", { a: 1 }, undefined)).toBe("memoized");
    expect(start).not.toHaveBeenCalled();
  });

  it("starts the child and returns its output + journals it when already complete", async () => {
    const { journal, puts } = fakeJournal();
    const { host } = makeHost({
      children: childStub({
        start: () =>
          Promise.resolve({ childRunId: "c1", status: "completed", output: { done: true } }),
      }),
      journal,
    });
    expect(await host.callWorkflow("child-wf", {}, undefined)).toEqual({ done: true });
    expect(puts[0]).toMatchObject({ seq: 1, kind: "workflow_call", result: { done: true } });
  });

  it("suspends waiting_for_child when the started child isn't terminal", async () => {
    const { journal } = fakeJournal();
    const { host } = makeHost({
      children: childStub({
        start: () => Promise.resolve({ childRunId: "c1", status: "running", output: null }),
      }),
      journal,
    });
    const err = await host.callWorkflow("child-wf", {}, undefined).catch((e: unknown) => e);
    expect(err).toMatchObject({
      name: "SuspendError",
      signal: { reason: "workflow_call", seq: 1, childRunId: "c1" },
    });
  });

  it("on resume (pending entry) polls the journaled child and returns its output", async () => {
    const fp = FP(["workflow_call", "child-wf", {}, null]);
    const poll = vi.fn(() =>
      Promise.resolve({ childRunId: "c1", status: "completed", output: "child-done" }),
    );
    const { journal } = fakeJournal({
      1: {
        seq: 1,
        kind: "workflow_call",
        fingerprint: fp,
        label: "",
        state: "pending",
        result: "c1",
      },
    });
    const { host } = makeHost({ children: childStub({ poll }), journal });
    expect(await host.callWorkflow("child-wf", {}, undefined)).toBe("child-done");
    expect(poll).toHaveBeenCalledWith("c1");
  });

  it("throws when the child failed", async () => {
    const { journal } = fakeJournal();
    const { host } = makeHost({
      children: childStub({
        start: () => Promise.resolve({ childRunId: "c1", status: "failed", output: null }),
      }),
      journal,
    });
    await expect(host.callWorkflow("child-wf", {}, undefined)).rejects.toThrow(/failed/);
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
