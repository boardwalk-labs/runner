import { describe, it, expect, vi } from "vitest";
import {
  FreezeCoordinator,
  type FreezeOutcome,
  type WakeEntry,
  type WakePayload,
} from "./freeze_coordinator.js";
import type { SuspendSignal } from "./suspension.js";

/** A scripted relay channel: records sends, lets the test play init's half. */
function fakeChannel(): {
  channel: { sendSuspendRequest: (p: unknown) => void; sendWakeAccepted: () => void };
  requests: unknown[];
  accepted: () => number;
} {
  const requests: unknown[] = [];
  let acceptedCount = 0;
  return {
    channel: {
      sendSuspendRequest: (p: unknown) => requests.push(p),
      sendWakeAccepted: () => {
        acceptedCount += 1;
      },
    },
    requests,
    accepted: () => acceptedCount,
  };
}

function sleepSignal(durationMs = 60_000): SuspendSignal {
  return { reason: "sleep", seq: 1, durationMs };
}

function gateSignal(key = "approve"): SuspendSignal {
  return {
    reason: "human_input",
    seq: 2,
    humanInput: { key, prompt: "ok?", inputSpec: {} },
  };
}

function childSignal(childRunId: string, seq: number): SuspendSignal {
  return { reason: "workflow_call", seq, childRunId };
}

/** A compound wake entry for a completed child. */
function childEntry(seq: number, runId: string, output: unknown): WakeEntry & { seq: number } {
  return { seq, kind: "workflow_call", child: { run_id: runId, status: "completed", output } };
}

function wakePayload(overrides: Partial<WakePayload> = {}): unknown {
  return {
    run_token: "fresh-token",
    wall_clock_ms: 1_000_000,
    wake: { kind: "sleep" },
    ...overrides,
  };
}

/** Two macrotask hops: one for the coordinator's drain (it lets queued continuations start work
 *  before committing to a freeze), one for the work that follows. */
const tick = async (): Promise<void> => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

describe("FreezeCoordinator", () => {
  it("freezes at quiescence and resolves the seam on wake", async () => {
    const { channel, requests, accepted } = fakeChannel();
    const c = new FreezeCoordinator({ channel, now: () => 500 });

    const wait = c.suspendingWait(sleepSignal(60_000));
    await tick();
    // The request carries the wire shape: reason + host-readable wake summary + opaque signal.
    expect(requests).toHaveLength(1);
    const req = requests[0] as {
      reason: string;
      wake: { kind: string; wake_at_ms: number };
      broker_signal: SuspendSignal;
    };
    expect(req.reason).toBe("sleep");
    expect(req.wake).toEqual({ kind: "sleep", wake_at_ms: 60_500 });
    expect(req.broker_signal.seq).toBe(1);

    c.onWake(wakePayload());
    const outcome = await wait;
    expect(outcome.kind).toBe("wake");
    expect(accepted()).toBe(1);
  });

  it("holds the freeze until in-flight work drains (the quiescence gate)", async () => {
    const { channel, requests } = fakeChannel();
    const c = new FreezeCoordinator({ channel });

    let releaseLeaf: () => void = () => undefined;
    const leaf = c.trackWork(
      () =>
        new Promise<void>((resolve) => {
          releaseLeaf = resolve;
        }),
    );

    const wait = c.suspendingWait(sleepSignal());
    await tick();
    expect(requests).toHaveLength(0); // a live leaf blocks the freeze

    releaseLeaf();
    await leaf;
    await tick();
    expect(requests).toHaveLength(1); // quiescent → frozen

    c.onWake(wakePayload());
    await wait;
  });

  it("queues new work while a freeze is pending and releases it after the wake", async () => {
    const { channel, requests } = fakeChannel();
    const c = new FreezeCoordinator({ channel });

    const wait = c.suspendingWait(sleepSignal());
    await tick();
    expect(requests).toHaveLength(1);

    // Work arriving while frozen must NOT start (nothing torn by the pause).
    const started = vi.fn();
    const queued = c.trackWork(() => {
      started();
      return Promise.resolve("done");
    });
    await tick();
    expect(started).not.toHaveBeenCalled();

    c.onWake(wakePayload());
    await wait;
    await expect(queued).resolves.toBe("done");
    expect(started).toHaveBeenCalledOnce();
  });

  it("returns the abort to a sleep seam (it holds in-process)", async () => {
    const { channel } = fakeChannel();
    const c = new FreezeCoordinator({ channel });
    const wait = c.suspendingWait(sleepSignal());
    await tick();
    c.onSuspendAbort({ reason: "store_unavailable" });
    const outcome = await wait;
    expect(outcome).toEqual({ kind: "aborted", reason: "store_unavailable" });
  });

  it("fires onFreezeAborted on suspend_abort so the paused runtime flusher resumes for the hold", async () => {
    const { channel } = fakeChannel();
    const c = new FreezeCoordinator({ channel });
    const onFreezeAborted = vi.fn();
    c.setHooks({ onFreezeAborted });
    const wait = c.suspendingWait(sleepSignal());
    await tick();
    c.onSuspendAbort({ reason: "store_unavailable" });
    await wait;
    expect(onFreezeAborted).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire onFreezeAborted on a wake (excludeIdle+resume own that path)", async () => {
    const { channel } = fakeChannel();
    const c = new FreezeCoordinator({ channel });
    const onFreezeAborted = vi.fn();
    c.setHooks({ onFreezeAborted });
    const wait = c.suspendingWait(sleepSignal());
    await tick();
    c.onWake(wakePayload());
    await wait;
    expect(onFreezeAborted).not.toHaveBeenCalled();
  });

  it("retries the freeze after an abort for a human-input seam", async () => {
    const { channel, requests } = fakeChannel();
    const delays: number[] = [];
    const c = new FreezeCoordinator({
      channel,
      delay: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    const wait = c.suspendingWait(gateSignal());
    await tick();
    expect(requests).toHaveLength(1);

    c.onSuspendAbort({ reason: "snapshot_failed" });
    await tick();
    await tick();
    expect(requests).toHaveLength(2); // re-requested after the backoff
    expect(delays).toEqual([30_000]);

    c.onWake(
      wakePayload({ wake: { kind: "human_input", answers: { approve: { value: "yes" } } } }),
    );
    const outcome = await wait;
    expect(outcome.kind).toBe("wake");
    if (outcome.kind === "wake") {
      expect(outcome.wake.answers).toEqual({ approve: { value: "yes" } });
    }
  });

  it("reports the primary reason of a composed freeze (a person to act on outranks a timer)", async () => {
    const { channel, requests } = fakeChannel();
    const c = new FreezeCoordinator({ channel });

    void c.suspendingWait(sleepSignal());
    void c.suspendingWait(gateSignal());
    await tick();
    expect(requests).toHaveLength(1);
    const req = requests[0] as { reason: string; wake: { kind: string } };
    expect(req.reason).toBe("human_input");
    expect(req.wake.kind).toBe("human_input");
  });

  it("runs the hooks in order: before-freeze at quiescence, after-wake before accept", async () => {
    const { channel } = fakeChannel();
    const order: string[] = [];
    const c = new FreezeCoordinator({ channel });
    c.setHooks({
      onBeforeFreeze: () => {
        order.push("before");
        return Promise.resolve();
      },
      onAfterWake: (wake) => {
        order.push(`after:${wake.run_token}`);
      },
    });
    const wait = c.suspendingWait(sleepSignal());
    await tick();
    expect(order).toEqual(["before"]);
    c.onWake(wakePayload());
    await wait;
    expect(order).toEqual(["before", "after:fresh-token"]);
  });

  it("re-confirms a duplicate wake without a parked seam (idempotent, never crashes)", async () => {
    const { channel, accepted } = fakeChannel();
    const c = new FreezeCoordinator({ channel });
    c.onWake(wakePayload());
    await tick();
    expect(accepted()).toBe(1);
  });

  it("ignores a malformed wake payload (init retries; the crash path owns recovery)", async () => {
    const { channel, accepted } = fakeChannel();
    const c = new FreezeCoordinator({ channel });
    const wait = c.suspendingWait(sleepSignal());
    await tick();
    c.onWake({ nonsense: true });
    await tick();
    expect(accepted()).toBe(0);
    // The real wake still lands.
    c.onWake(wakePayload());
    const outcome: FreezeOutcome = await wait;
    expect(outcome.kind).toBe("wake");
  });

  it("an abort with no parked seam is ignored", () => {
    const { channel } = fakeChannel();
    const c = new FreezeCoordinator({ channel });
    c.onSuspendAbort({ reason: "snapshot_failed" }); // must not throw
  });

  it("treats a failed before-freeze hook as an abort for a sleep seam", async () => {
    const { channel, requests } = fakeChannel();
    const c = new FreezeCoordinator({ channel });
    c.setHooks({
      onBeforeFreeze: () => Promise.reject(new Error("flush failed")),
    });
    const outcome = await c.suspendingWait(sleepSignal());
    expect(outcome).toEqual({ kind: "aborted", reason: "prepare_failed" });
    expect(requests).toHaveLength(0); // never asked to freeze with an unflushed meter
  });
});

describe("FreezeCoordinator — composed waits (SUSPEND_POLICY §1.1)", () => {
  it("covers every concurrent wait with ONE freeze", async () => {
    const { channel, requests } = fakeChannel();
    const c = new FreezeCoordinator({ channel });

    const a = c.suspendingWait(childSignal("child-a", 1));
    const b = c.suspendingWait(childSignal("child-b", 2));
    await tick();

    expect(requests).toHaveLength(1); // not one freeze per child
    const req = requests[0] as {
      wake: { waits: { kind: string; child_run_id?: string }[] };
      broker_signal: { waits: { childRunId?: string }[] };
    };
    // The broker signal is authoritative: every condition this freeze must be woken for.
    expect(req.broker_signal.waits.map((w) => w.childRunId)).toEqual(["child-a", "child-b"]);
    expect(req.wake.waits.map((w) => w.child_run_id)).toEqual(["child-a", "child-b"]);

    c.onWake(
      wakePayload({
        wake: {
          kind: "workflow_call",
          satisfied: [childEntry(1, "child-a", "A"), childEntry(2, "child-b", "B")],
        },
      }),
    );
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.kind === "wake" && ra.wake.child?.output).toBe("A");
    expect(rb.kind === "wake" && rb.wake.child?.output).toBe("B");
    expect(requests).toHaveLength(1); // one snapshot round-trip served both children
  });

  it("routes each entry to its own seq, so no await gets another child's output", async () => {
    const { channel } = fakeChannel();
    const c = new FreezeCoordinator({ channel });

    const a = c.suspendingWait(childSignal("child-a", 1));
    const b = c.suspendingWait(childSignal("child-b", 2));
    await tick();

    // Deliberately out of registration order: routing is by seq, not by arrival.
    c.onWake(
      wakePayload({
        wake: {
          kind: "workflow_call",
          satisfied: [childEntry(2, "child-b", "B"), childEntry(1, "child-a", "A")],
        },
      }),
    );
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.kind === "wake" && ra.wake.child?.run_id).toBe("child-a");
    expect(rb.kind === "wake" && rb.wake.child?.run_id).toBe("child-b");
  });

  it("re-freezes with the remainder when a wake satisfies only some waits", async () => {
    const { channel, requests } = fakeChannel();
    const c = new FreezeCoordinator({ channel, delay: () => Promise.resolve() });

    const a = c.suspendingWait(childSignal("child-a", 1));
    const b = c.suspendingWait(childSignal("child-b", 2));
    await tick();
    expect(requests).toHaveLength(1);

    c.onWake(
      wakePayload({ wake: { kind: "workflow_call", satisfied: [childEntry(1, "child-a", "A")] } }),
    );
    const ra = await a;
    expect(ra.kind === "wake" && ra.wake.child?.output).toBe("A");
    await tick();

    // The still-outstanding child is the whole condition of the next freeze.
    expect(requests).toHaveLength(2);
    const second = requests[1] as { broker_signal: { waits: { childRunId?: string }[] } };
    expect(second.broker_signal.waits.map((w) => w.childRunId)).toEqual(["child-b"]);

    c.onWake(
      wakePayload({ wake: { kind: "workflow_call", satisfied: [childEntry(2, "child-b", "B")] } }),
    );
    const rb = await b;
    expect(rb.kind === "wake" && rb.wake.child?.output).toBe("B");
  });

  it("refuses a child wake that names a child this seam is not waiting on", async () => {
    const { channel, requests } = fakeChannel();
    const delays: number[] = [];
    const c = new FreezeCoordinator({
      channel,
      delay: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });

    const a = c.suspendingWait(childSignal("child-a", 1));
    let resolved = false;
    void a.then(() => (resolved = true));
    await tick();

    // A stale/duplicate delivery for some other child must not satisfy this wait — that is how a
    // parent silently receives the wrong child's output.
    c.onWake(
      wakePayload({
        wake: {
          kind: "workflow_call",
          child: { run_id: "child-somebody-else", status: "completed", output: "wrong" },
        },
      }),
    );
    await tick();
    await tick();
    expect(resolved).toBe(false);
    expect(delays).toEqual([30_000]); // backed off instead of spinning the snapshot machinery
    expect(requests).toHaveLength(2); // then re-froze on the same condition

    c.onWake(
      wakePayload({
        wake: {
          kind: "workflow_call",
          child: { run_id: "child-a", status: "completed", output: "right" },
        },
      }),
    );
    const outcome = await a;
    expect(outcome.kind === "wake" && outcome.wake.child?.output).toBe("right");
  });

  it("settles composed sleeps on a suspend_abort and retries the freeze for the rest", async () => {
    const { channel, requests } = fakeChannel();
    const c = new FreezeCoordinator({ channel, delay: () => Promise.resolve() });

    const nap = c.suspendingWait(sleepSignal());
    const child = c.suspendingWait(childSignal("child-a", 3));
    await tick();
    expect(requests).toHaveLength(1);

    c.onSuspendAbort({ reason: "snapshot_failed" });
    // The sleep holds its remainder in-process; the child wait cannot hold, so it re-freezes.
    expect(await nap).toEqual({ kind: "aborted", reason: "snapshot_failed" });
    await tick();
    await tick();
    expect(requests).toHaveLength(2);
    const second = requests[1] as { reason: string; broker_signal: { waits: unknown[] } };
    expect(second.reason).toBe("workflow_call");
    expect(second.broker_signal.waits).toHaveLength(1);

    c.onWake(
      wakePayload({ wake: { kind: "workflow_call", satisfied: [childEntry(3, "child-a", "A")] } }),
    );
    expect((await child).kind).toBe("wake");
  });

  it("keeps a composed sleep on its own deadline (an absolute wake is never rebased)", async () => {
    const { channel, requests } = fakeChannel();
    let clock = 1_000;
    const c = new FreezeCoordinator({ channel, now: () => clock });
    // The freeze lands long after the seam was reached (a slow flush + workspace upload, or a
    // wait that composed behind others). A relative duration would drift by exactly that much.
    c.setHooks({
      onBeforeFreeze: () => {
        clock = 500_000;
        return Promise.resolve();
      },
    });

    void c.suspendingWait({ reason: "sleep", seq: 1, durationMs: 60_000, wakeAtMs: 61_000 });
    void c.suspendingWait(childSignal("child-a", 2));
    await tick();
    await tick();

    const req = requests[0] as { wake: { waits: { kind: string; wake_at_ms?: number }[] } };
    expect(req.wake.waits.find((w) => w.kind === "sleep")?.wake_at_ms).toBe(61_000);
  });

  it("closes the gate BEFORE the pre-freeze hook, so its I/O window cannot start work", async () => {
    const { channel, requests } = fakeChannel();
    const c = new FreezeCoordinator({ channel });
    let releaseHook: () => void = () => undefined;
    c.setHooks({
      onBeforeFreeze: () =>
        new Promise<void>((resolve) => {
          releaseHook = resolve;
        }),
    });

    const wait = c.suspendingWait(sleepSignal());
    await tick();
    expect(requests).toHaveLength(0); // still flushing + persisting the workspace

    // A sibling continuation asking for work mid-flush must QUEUE. If it ran, the snapshot would
    // capture its live socket, which is dead on restore.
    const started = vi.fn();
    const queued = c.trackWork(() => {
      started();
      return Promise.resolve("done");
    });
    await tick();
    expect(started).not.toHaveBeenCalled();

    releaseHook();
    await tick();
    expect(requests).toHaveLength(1);

    c.onWake(wakePayload());
    await wait;
    await expect(queued).resolves.toBe("done");
    expect(started).toHaveBeenCalledOnce();
  });

  it("fails the parked waits loudly when the freeze loop itself dies", async () => {
    // The loop is the only thing that can resolve a wait. If it dies silently the run sits with
    // nothing running and no wake coming — and with the meter already paused, it looks cheap.
    const { channel } = fakeChannel();
    const c = new FreezeCoordinator({
      channel: {
        ...channel,
        sendSuspendRequest: () => {
          throw new Error("relay closed");
        },
      },
    });
    const child = c.suspendingWait(childSignal("child-a", 1));
    const gate = c.suspendingWait(gateSignal());
    expect(await child).toEqual({
      kind: "aborted",
      reason: "freeze_driver_failed: relay closed",
    });
    expect((await gate).kind).toBe("aborted");
    // The gate must not stay closed behind a dead loop, or every later hook queues forever.
    await expect(c.trackWork(() => Promise.resolve("ran"))).resolves.toBe("ran");
  });

  it("abandons the freeze when every wait withdraws during the pre-freeze hook", async () => {
    const { channel, requests } = fakeChannel();
    const c = new FreezeCoordinator({ channel });
    let releaseHook: () => void = () => undefined;
    c.setHooks({
      onBeforeFreeze: () =>
        new Promise<void>((resolve) => {
          releaseHook = resolve;
        }),
    });

    const abort = new AbortController();
    const wait = c.suspendingWait(sleepSignal(), abort.signal);
    await tick();

    abort.abort(); // the gate got its answer mid-flush
    expect(await wait).toEqual({ kind: "withdrawn" });
    releaseHook();
    await tick();
    expect(requests).toHaveLength(0); // never froze on a condition nobody awaits
  });
});

describe("FreezeCoordinator — withdraw (register-without-release)", () => {
  it("an abort while HOLDING withdraws the wait (never freezes)", async () => {
    const { channel, requests } = fakeChannel();
    const c = new FreezeCoordinator({ channel });
    // Keep a leaf in flight so the suspending wait HOLDS (never reaches quiescence).
    let releaseLeaf: () => void = () => undefined;
    void c.trackWork(() => new Promise<void>((r) => (releaseLeaf = r)));

    const abort = new AbortController();
    const wait = c.suspendingWait(sleepSignal(), abort.signal);
    await tick();
    expect(requests).toHaveLength(0); // holding, not frozen

    abort.abort();
    const outcome = await wait;
    expect(outcome).toEqual({ kind: "withdrawn" });
    expect(requests).toHaveLength(0); // never froze
    releaseLeaf();
  });

  it("an abort AFTER the freeze request is moot — the freeze still resolves via wake", async () => {
    const { channel, requests } = fakeChannel();
    const c = new FreezeCoordinator({ channel });
    const abort = new AbortController();
    const wait = c.suspendingWait(sleepSignal(), abort.signal);
    await tick();
    expect(requests).toHaveLength(1); // already froze (quiescent immediately)

    abort.abort(); // too late — the process would be frozen; the wake still lands
    c.onWake(wakePayload());
    const outcome = await wait;
    expect(outcome.kind).toBe("wake");
  });
});
