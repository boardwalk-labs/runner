import { describe, it, expect, vi } from "vitest";
import { FreezeCoordinator, type FreezeOutcome, type WakePayload } from "./freeze_coordinator.js";
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
  return { reason: "sleep", seq: 1, fingerprint: "fp", durationMs };
}

function gateSignal(key = "approve"): SuspendSignal {
  return {
    reason: "human_input",
    seq: 2,
    fingerprint: "fp",
    humanInput: { key, prompt: "ok?", inputSpec: {} },
  };
}

function wakePayload(overrides: Partial<WakePayload> = {}): unknown {
  return {
    run_token: "fresh-token",
    wall_clock_ms: 1_000_000,
    wake: { kind: "sleep" },
    ...overrides,
  };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

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

  it("serializes concurrent suspending waits (one freeze at a time)", async () => {
    const { channel, requests } = fakeChannel();
    const c = new FreezeCoordinator({ channel });

    const first = c.suspendingWait(sleepSignal());
    const second = c.suspendingWait(gateSignal());
    await tick();
    expect(requests).toHaveLength(1); // only the first froze

    c.onWake(wakePayload());
    await first;
    await tick();
    expect(requests).toHaveLength(2); // now the second takes its turn
    const req = requests[1] as { reason: string };
    expect(req.reason).toBe("human_input");

    c.onWake(wakePayload({ wake: { kind: "human_input", answers: { approve: 1 } } }));
    await second;
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
