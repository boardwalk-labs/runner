// FreezeCoordinator — the runtime's half of snapshot suspension on the microVM substrate.
//
// On this substrate the worker process NEVER exits to suspend: a suspending seam (a long
// sleep, a human-input gate, a child-run wait) BLOCKS on a real promise, the platform
// freezes the whole VM into a snapshot, and a later restore resolves that same promise with
// the wake value — the heap is the literal heap, nothing replays. This coordinator owns the
// two policies that make freezing safe and predictable:
//
// 1. THE QUIESCENCE GATE: never freeze while non-suspending runtime work (an agent leaf, a
//    tool call, an artifact write) is in flight — a snapshot must not capture a live
//    platform stream that would be dead on restore. A suspending wait created during such
//    work HOLDS until the work drains; new runtime work that arrives once the gate has
//    CLOSED (at quiescence, before the pre-freeze hook) QUEUES — it never started, so
//    nothing is torn — and runs after the wake.
// 2. SNAPSHOT-FIRST FALLBACK: a `suspend_abort` from the platform (snapshot/store/broker
//    failure) means the seam falls back to HOLDING — a sleep waits in-process for its
//    remainder; a human-input or child wait retries the freeze after a backoff (the host
//    may throttle repeated attempts).
//
// Concurrent suspending waits COMPOSE (docs/SUSPEND_POLICY.md §1.1): they register here, one
// freeze covers the whole set with a compound wake condition, and a wake resolves exactly the
// waits it satisfies. Waits still outstanding after a wake re-freeze with the remainder when
// the run next reaches quiescence. This is what makes `Promise.all([workflows.call(a),
// workflows.call(b)])` — or any mix of children, gates, and sleeps — a supported shape rather
// than N serialized snapshot round-trips.
//
// The wire below this is the guest init's relay (identity_relay `openChannel`); the policy
// above it is decided platform-side. The coordinator never interprets a wake VALUE — it
// validates the envelope, routes each entry to the wait that asked for it, and hands `wake`
// to that seam.

import { z } from "zod";
import { createLogger } from "./support/index.js";
import type { RelayChannel } from "./identity_relay.js";
import type { SuspendSignal } from "./suspension.js";

const log = createLogger("FreezeCoordinator");

/** First retry delay after a suspend_abort (doubles per attempt, capped below). */
export const ABORT_RETRY_INITIAL_MS = 30_000;
export const ABORT_RETRY_MAX_MS = 5 * 60_000;

/** What one satisfied wait resolves with — the per-kind payload, opaque to the coordinator. */
const wakeEntrySchema = z.object({
  kind: z.enum(["sleep", "human_input", "workflow_call"]),
  /** human_input: EVERY gate this suspension raised, keyed by gate key / tool-call id. */
  answers: z.record(z.string(), z.unknown()).optional(),
  /** workflow_call: the finalized child. */
  child: z
    .object({
      run_id: z.string().min(1),
      status: z.string().min(1),
      output: z.unknown(),
    })
    .optional(),
});

/** The wake value inside a wake injection — `kind` echoes the parked seam's reason; the
 *  per-kind fields are opaque to the coordinator and interpreted by the seam. */
export const wakeValueSchema = wakeEntrySchema.extend({
  /**
   * Compound wake: every wait this injection satisfies, each naming the suspension `seq` it
   * belongs to. Present from any control plane that understands composed waits; the top-level
   * fields then describe the PRIMARY entry (so a reader that predates composition still sees a
   * coherent single wake). Absent ⇒ a single-wait payload, routed by matching its condition.
   */
  satisfied: z.array(wakeEntrySchema.extend({ seq: z.number() })).optional(),
});
export type WakeValue = z.infer<typeof wakeValueSchema>;
export type WakeEntry = z.infer<typeof wakeEntrySchema>;

/** The wake-injection payload as init relays it (snake_case, the platform env contract's
 *  sibling): fresh tokens — the frozen ones expired while suspended — plus the
 *  authoritative wall clock (the guest's own clock was stopped) and the wake value. */
export const wakePayloadSchema = z.object({
  run_token: z.string().min(1),
  api_token: z.string().optional(),
  wall_clock_ms: z.number(),
  wake: wakeValueSchema,
});
export type WakePayload = z.infer<typeof wakePayloadSchema>;

const suspendAbortSchema = z.object({ reason: z.string().optional() });

/** What a suspending wait resolves to: the wake (the normal path), or — for a `sleep` seam
 *  only — the abort that tells it to hold its remainder in-process (other reasons retry the
 *  freeze internally and never surface an abort). */
export type FreezeOutcome =
  | { kind: "wake"; wake: WakeValue }
  | { kind: "aborted"; reason: string }
  /** The caller withdrew the wait via its abort signal BEFORE it froze (register-without-release:
   *  a held gate got its answer during the hold, so it resolves in-process instead of freezing). */
  | { kind: "withdrawn" };

/** How the driver's park resolves: the platform woke us, or the freeze attempt died. */
type FrozenOutcome = { kind: "wake"; payload: WakePayload } | { kind: "aborted"; reason: string };

export interface FreezeCoordinatorHooks {
  /** Runs at quiescence, immediately before the freeze is requested: flush billable runtime
   *  (suspended time must never appear billed) and persist the workspace. Its own failure
   *  aborts THIS freeze attempt (the seam holds/retries) — never the run. */
  onBeforeFreeze?: () => Promise<void>;
  /** Runs when a wake lands, before the seam resolves: swap the run/api tokens onto the
   *  broker client and rebase the runtime meter past the frozen window. */
  onAfterWake?: (wake: WakePayload) => void | Promise<void>;
  /** Runs when a REQUESTED freeze aborts (`suspend_abort` — snapshot/store failure) before the
   *  parked seam resolves: undo onBeforeFreeze's reversible effects (resume the paused runtime
   *  flusher) since the run now HOLDS in-process instead of freezing. Not called for a failure
   *  inside onBeforeFreeze itself — that hook owns its own unwind. Must not throw. */
  onFreezeAborted?: () => void;
}

export interface FreezeCoordinatorDeps {
  channel: RelayChannel;
  now?: () => number;
  /** Injected delay (tests). Defaults to a real timer. */
  delay?: (ms: number) => Promise<void>;
  /** Yield until every already-queued continuation has run — see {@link FreezeCoordinator.drive}.
   *  Defaults to a macrotask hop, which is where the microtask queue is drained. */
  drain?: () => Promise<void>;
}

/** One registered-but-unsettled suspending wait. */
interface RegisteredWait {
  signal: SuspendSignal;
  resolve: (outcome: FreezeOutcome) => void;
  settled: boolean;
}

/** Which wait's condition describes the freeze as a whole: a person waiting to act outranks a
 *  child run, which outranks a timer. The control plane derives the run's single-valued status
 *  from it, so this ordering is what a reader sees ("awaiting input", not "sleeping"); ties go
 *  to the earliest suspension so the choice is stable across re-freezes. */
const REASON_PRECEDENCE: Record<SuspendSignal["reason"], number> = {
  human_input: 0,
  budget: 0,
  workflow_call: 1,
  sleep: 2,
};

/** A non-empty set of waits — the driver only ever freezes for one. */
type WaitSet = readonly [RegisteredWait, ...RegisteredWait[]];

function primaryWait(waits: WaitSet): RegisteredWait {
  return waits.reduce((best, w) => (outranks(w.signal, best.signal) ? w : best));
}

function outranks(a: SuspendSignal, b: SuspendSignal): boolean {
  const byReason = REASON_PRECEDENCE[a.reason] - REASON_PRECEDENCE[b.reason];
  return byReason !== 0 ? byReason < 0 : a.seq < b.seq;
}

export class FreezeCoordinator {
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly drain: () => Promise<void>;
  private hooks: FreezeCoordinatorHooks = {};

  /** Non-suspending runtime work in flight (the quiescence gate's count). */
  private inFlight = 0;
  private quiescenceWaiters: Array<() => void> = [];
  /** True from freeze request until wake/abort — new runtime work queues behind it. */
  private freezePending = false;
  private gateWaiters: Array<() => void> = [];
  /** Every registered-but-unsettled suspending wait, keyed by its suspension seq. */
  private readonly waits = new Map<number, RegisteredWait>();
  /** Resolves the driver's park — non-null from suspend_request until wake/abort. */
  private frozen: ((outcome: FrozenOutcome) => void) | null = null;
  /** True while the freeze driver loop is running (at most one). */
  private driving = false;

  constructor(private readonly deps: FreezeCoordinatorDeps) {
    this.now = deps.now ?? Date.now;
    // A pending retry delay legitimately keeps the process alive — the run isn't done.
    this.delay =
      deps.delay ??
      ((ms: number): Promise<void> =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.drain =
      deps.drain ??
      ((): Promise<void> =>
        new Promise((resolve) => {
          setImmediate(resolve);
        }));
  }

  /** Late-bound per-run hooks (the flusher/broker/redactor exist only once a run is claimed). */
  setHooks(hooks: FreezeCoordinatorHooks): void {
    this.hooks = hooks;
  }

  /**
   * Run one unit of non-suspending runtime work under the gate: queue while a freeze is
   * pending (the work never starts, so nothing can be torn by the pause), then count it
   * in-flight so a suspending wait holds until it drains. The gate check and the count
   * increment share one synchronous segment — a freeze requested in between cannot miss us.
   */
  async trackWork<T>(fn: () => Promise<T>): Promise<T> {
    while (this.freezePending) {
      await new Promise<void>((resolve) => {
        this.gateWaiters.push(resolve);
      });
    }
    this.beginWork();
    try {
      return await fn();
    } finally {
      this.endWork();
    }
  }

  /** A suspending seam's own wait is NOT "work" — it decrements around its park so the gate
   *  sees true quiescence. (The host wraps every hook in trackWork; the suspending seams
   *  call these around their freeze wait.) */
  beginWork(): void {
    this.inFlight += 1;
  }

  endWork(): void {
    this.inFlight -= 1;
    if (this.inFlight === 0) {
      const waiters = this.quiescenceWaiters;
      this.quiescenceWaiters = [];
      for (const w of waiters) w();
    }
  }

  /**
   * Register a suspending wait and resolve it when the platform says its condition is met.
   * The next thing this promise sees is a wake (possibly epochs later, through a restored
   * heap) or — for `sleep` only — the abort that tells it to hold its remainder (other
   * reasons retry the freeze internally). Concurrent waits COMPOSE: one freeze covers every
   * registered wait, and each resolves on its own condition, in whatever order the platform
   * satisfies them.
   */
  suspendingWait(signal: SuspendSignal, abort?: AbortSignal): Promise<FreezeOutcome> {
    return new Promise<FreezeOutcome>((resolve) => {
      // An already-aborted caller withdraws without ever registering (a fired AbortSignal
      // never re-dispatches, so the listener below would not fire for it).
      if (abort?.aborted === true) {
        resolve({ kind: "withdrawn" });
        return;
      }
      this.waits.set(signal.seq, { signal, resolve, settled: false });
      abort?.addEventListener("abort", () => this.withdraw(signal.seq), { once: true });
      this.startDriver();
    });
  }

  /** Relay handler: a wake injection landed. Validates, runs the after-wake hook (token
   *  swap + meter rebase), confirms to init, and hands the payload to the driver, which
   *  routes each entry to the wait that asked for it. A wake with nothing frozen is a
   *  duplicate delivery — re-confirm (idempotent), never crash. */
  onWake(payload: unknown): void {
    const parsed = wakePayloadSchema.safeParse(payload);
    if (!parsed.success) {
      // Unanswerable garbage: init will retry, time out, and the platform's crash path owns
      // recovery. Log loudly — this is a control-plane/init bug, not author code.
      log.error("wake_payload_invalid", { issues: parsed.error.message });
      return;
    }
    const resolve = this.frozen;
    if (resolve === null) {
      log.warn("duplicate_wake_ignored", {});
      this.deps.channel.sendWakeAccepted();
      return;
    }
    this.frozen = null;
    void (async (): Promise<void> => {
      try {
        await this.hooks.onAfterWake?.(parsed.data);
      } catch (err) {
        // Token swap / meter rebase failing is survivable only loudly — the run continues
        // on the old token and fails fast if it truly expired.
        log.error("after_wake_hook_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.deps.channel.sendWakeAccepted();
      resolve({ kind: "wake", payload: parsed.data });
    })();
  }

  /** Relay handler: the snapshot attempt failed; the parked seams fall back to holding. */
  onSuspendAbort(payload: unknown): void {
    const parsed = suspendAbortSchema.safeParse(payload);
    const reason = parsed.success ? (parsed.data.reason ?? "unknown") : "unknown";
    const resolve = this.frozen;
    if (resolve === null) {
      log.warn("suspend_abort_without_parked_seam", { reason });
      return;
    }
    this.frozen = null;
    // The freeze is off — the seams will hold in-process, so onBeforeFreeze's reversible prep
    // (the paused runtime flusher) must unwind before the hold starts metering-blind.
    this.hooks.onFreezeAborted?.();
    resolve({ kind: "aborted", reason });
  }

  /** Drop a wait whose caller withdrew before the freeze was REQUESTED. Once requested the
   *  process is paused (or about to be) and the abort is moot — the wake resolves it instead. */
  private withdraw(seq: number): void {
    const wait = this.waits.get(seq);
    if (wait === undefined || this.frozen !== null) return;
    this.settle(wait, { kind: "withdrawn" });
  }

  private settle(wait: RegisteredWait, outcome: FreezeOutcome): void {
    if (wait.settled) return;
    wait.settled = true;
    this.waits.delete(wait.signal.seq);
    wait.resolve(outcome);
  }

  /** Settle every outstanding `sleep` wait with a freeze failure: a sleep holds its remainder
   *  in-process rather than retrying (its deadline is absolute, so holding still lands on time). */
  private settleSleeps(reason: string): void {
    for (const wait of [...this.waits.values()]) {
      if (wait.signal.reason !== "sleep") continue;
      this.settle(wait, { kind: "aborted", reason });
    }
  }

  private startDriver(): void {
    if (this.driving) return;
    this.driving = true;
    void this.drive()
      .catch((err: unknown) => {
        // This loop is the ONLY thing that can resolve a parked wait, so its death must fail the
        // seams loudly. Left alone it would be the worst possible failure: a run sitting with
        // nothing running, no wake coming, and — because the pre-freeze hook already paused the
        // meter — looking cheap while it hangs. A sleep still holds its remainder in-process; a
        // gate or child wait rejects, which fails the run with a real error.
        const message = err instanceof Error ? err.message : String(err);
        log.error("freeze_driver_failed", { error: message, waits: this.waits.size });
        this.freezePending = false;
        this.releaseGate();
        for (const wait of [...this.waits.values()]) {
          this.settle(wait, { kind: "aborted", reason: `freeze_driver_failed: ${message}` });
        }
      })
      .finally(() => {
        this.driving = false;
      });
  }

  /**
   * The single freeze loop. Holds until quiescence, closes the gate, runs the pre-freeze hook,
   * requests ONE freeze covering every registered wait, and parks. Each wake settles the waits
   * it satisfies; anything still outstanding re-freezes on the next pass. Exits when no waits
   * remain (a later wait restarts it).
   */
  private async drive(): Promise<void> {
    let backoff = ABORT_RETRY_INITIAL_MS;
    for (;;) {
      if (this.waits.size === 0) return;
      await this.awaitQuiescence();
      if (this.inFlight > 0) continue;
      if (this.waits.size === 0) return;
      // An in-flight count of zero is not yet proof the run is idle: the seam that just woke has
      // resolved its caller, and that caller's continuation — the next `workflows.call` of a
      // fan-out pool, say — is a QUEUED microtask that has not begun counting itself as work.
      // Committing to a freeze here would shut the gate in its face and stall the pool for a
      // whole snapshot cycle. So drain the queue first (a macrotask hop) and look again.
      await this.drain();
      if (this.inFlight > 0) continue;
      if (this.waits.size === 0) return;
      // Now close the gate — at quiescence, BEFORE the pre-freeze hook's flush + workspace upload
      // (seconds of I/O), which is what keeps THAT window from starting work the snapshot would
      // capture live. Safe only at quiescence: no seam is half-done, so a queued hook is one that
      // never started. Observing quiescence and closing the gate share this synchronous step, so
      // nothing can slip between them.
      this.freezePending = true;
      try {
        await this.hooks.onBeforeFreeze?.();
      } catch (err) {
        // A failed pre-freeze flush must not strand the seams: treat it like an abort.
        log.warn("freeze_prepare_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        this.freezePending = false;
        this.releaseGate();
        this.settleSleeps("prepare_failed");
        if (this.waits.size === 0) continue;
        await this.delay(backoff);
        backoff = Math.min(backoff * 2, ABORT_RETRY_MAX_MS);
        continue;
      }
      // Read the set to freeze on AFTER the hook: a wait can withdraw during that flush (a held
      // gate answered mid-upload), and freezing on a condition nobody awaits burns a round-trip.
      const [head, ...rest] = [...this.waits.values()];
      if (head === undefined) {
        this.freezePending = false;
        this.releaseGate();
        continue;
      }
      const frozen: WaitSet = [head, ...rest];
      const outcome = await new Promise<FrozenOutcome>((resolve) => {
        this.frozen = resolve;
        this.deps.channel.sendSuspendRequest({
          reason: primaryWait(frozen).signal.reason,
          wake: this.wakeConditionOf(frozen),
          broker_signal: this.brokerSignalOf(frozen),
        });
        // ← the VM freezes while this promise is pending; the wake resolves it with the
        //   heap (and this very closure) restored.
      });
      this.freezePending = false;
      this.releaseGate();
      if (outcome.kind === "wake") {
        if (this.routeWake(outcome.payload.wake) > 0) {
          backoff = ABORT_RETRY_INITIAL_MS;
          continue;
        }
        // A wake that satisfied nothing outstanding. Re-freezing immediately would spin the
        // snapshot machinery against a control plane that keeps re-sending it, so back off
        // exactly as an abort does.
        log.warn("wake_satisfied_nothing", { kind: outcome.payload.wake.kind });
      } else {
        this.settleSleeps(outcome.reason);
        if (this.waits.size === 0) continue;
        log.warn("suspend_aborted_retrying", {
          reason: outcome.reason,
          waits: this.waits.size,
          backoffMs: backoff,
        });
      }
      await this.delay(backoff);
      backoff = Math.min(backoff * 2, ABORT_RETRY_MAX_MS);
    }
  }

  /** Hand each satisfied condition to the wait that asked for it. Returns how many settled —
   *  zero means the wake matched nothing outstanding (the driver backs off rather than
   *  re-freezing into a loop). */
  private routeWake(wake: WakeValue): number {
    if (wake.satisfied !== undefined) {
      let settled = 0;
      for (const entry of wake.satisfied) {
        const wait = this.waits.get(entry.seq);
        if (wait === undefined) {
          // Already settled (a duplicate delivery) or never ours — both are safe to drop.
          log.warn("wake_entry_unmatched", { seq: entry.seq, kind: entry.kind });
          continue;
        }
        this.settle(wait, { kind: "wake", wake: entry });
        settled += 1;
      }
      return settled;
    }
    // A payload that names no seqs can still only satisfy a wait whose CONDITION it matches —
    // never "whichever wait is first". With several outstanding, handing a child-run wake to the
    // wrong wait would return another child's output to that await, silently.
    const match = [...this.waits.values()].find((w) => matchesWake(w.signal, wake));
    if (match === undefined) {
      log.warn("wake_unmatched", { kind: wake.kind });
      return 0;
    }
    this.settle(match, { kind: "wake", wake });
    return 1;
  }

  private awaitQuiescence(): Promise<void> {
    if (this.inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.quiescenceWaiters.push(resolve);
    });
  }

  private releaseGate(): void {
    const waiters = this.gateWaiters;
    this.gateWaiters = [];
    for (const w of waiters) w();
  }

  /** The host-readable wake summary on the wire (logs/metrics/placement): the primary wait's
   *  condition, plus the whole set when this freeze composes several. The opaque broker_signal
   *  beside it carries the authoritative conditions. */
  private wakeConditionOf(waits: WaitSet): Record<string, unknown> {
    const summaries = waits.map((w) => this.summaryOf(w.signal));
    return {
      ...this.summaryOf(primaryWait(waits).signal),
      ...(waits.length > 1 ? { waits: summaries } : {}),
    };
  }

  private summaryOf(signal: SuspendSignal): Record<string, unknown> {
    switch (signal.reason) {
      case "sleep":
        return {
          kind: "sleep",
          // Absolute when the seam carries one (a sleep that queued behind another wait must
          // still land on ITS deadline, not one rebased to when the freeze finally happened).
          wake_at_ms: signal.wakeAtMs ?? this.now() + (signal.durationMs ?? 0),
        };
      case "human_input":
        return {
          kind: "human_input",
          ...(signal.humanInput !== undefined ? { request_keys: [signal.humanInput.key] } : {}),
        };
      // A budget park waits on the same gate machinery as human_input, but reports its own kind so
      // the control plane can say "paused on budget" rather than "waiting on a human" — a different
      // thing to a person triaging the run list (SUSPEND_POLICY Decision 3).
      case "budget":
        return {
          kind: "budget",
          ...(signal.humanInput !== undefined ? { request_keys: [signal.humanInput.key] } : {}),
        };
      case "workflow_call":
        return {
          kind: "workflow_call",
          ...(signal.childRunId !== undefined ? { child_run_id: signal.childRunId } : {}),
        };
    }
  }

  /** The broker's suspend body: the primary wait inline (what a control plane that predates
   *  composed waits persists) plus `waits` — every condition this freeze must be woken for,
   *  which is the authoritative set. */
  private brokerSignalOf(waits: WaitSet): Record<string, unknown> {
    return {
      ...primaryWait(waits).signal,
      waits: waits.map((w) => w.signal),
    };
  }
}

/**
 * Does a wake payload that names no seq satisfy this wait? Kind must always agree. Beyond that the
 * checks are deliberately asymmetric — match strictly wherever a mismatch would be SILENT, and
 * leave the rest to the seam, which reports it better:
 *
 *  - `workflow_call` also checks the child id. A child wake handed to the wrong wait would return
 *    another child's output to that `await` and look like a perfectly good answer.
 *  - `human_input` checks kind only. The gate seam already validates that the answers contain its
 *    key and fails with a precise "does not answer the parked gate" — a control-plane/snapshot
 *    disagreement should surface as that error, not as a refusal here that re-freezes forever.
 */
function matchesWake(signal: SuspendSignal, wake: WakeValue): boolean {
  switch (wake.kind) {
    case "sleep":
      return signal.reason === "sleep";
    case "human_input":
      // A budget park is answered through the same gate machinery, so it accepts this kind too.
      return signal.reason === "human_input" || signal.reason === "budget";
    case "workflow_call":
      return signal.reason === "workflow_call" && wake.child?.run_id === signal.childRunId;
  }
}
