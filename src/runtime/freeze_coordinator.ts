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
//    work HOLDS until the work drains; new runtime work that arrives while a freeze is
//    pending QUEUES (it never started, so nothing is torn) and runs after the wake.
// 2. SNAPSHOT-FIRST FALLBACK: a `suspend_abort` from the platform (snapshot/store/broker
//    failure) means the seam falls back to HOLDING — a sleep waits in-process for its
//    remainder; a human-input or child wait retries the freeze after a backoff (the host
//    may throttle repeated attempts).
//
// Concurrent suspending waits SERIALIZE: the first to reach quiescence freezes with its own
// wake condition; after its wake, the next takes its turn. (A compound wake condition —
// one freeze covering several waits — is a future optimization, not a correctness need:
// the heap survives every cycle.)
//
// The wire below this is the guest init's relay (identity_relay `openChannel`); the policy
// above it is decided platform-side. The coordinator never interprets the wake VALUE — it
// validates the envelope and hands `wake` to the seam that parked.

import { z } from "zod";
import { createLogger } from "./support/index.js";
import type { RelayChannel } from "./identity_relay.js";
import type { SuspendSignal } from "./suspension.js";

const log = createLogger("FreezeCoordinator");

/** First retry delay after a suspend_abort (doubles per attempt, capped below). */
export const ABORT_RETRY_INITIAL_MS = 30_000;
export const ABORT_RETRY_MAX_MS = 5 * 60_000;

/** The wake value inside a wake injection — `kind` echoes the parked seam's reason; the
 *  per-kind fields are opaque to the coordinator and interpreted by the seam. */
export const wakeValueSchema = z.object({
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
export type WakeValue = z.infer<typeof wakeValueSchema>;

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
export type FreezeOutcome = { kind: "wake"; wake: WakeValue } | { kind: "aborted"; reason: string };

export interface FreezeCoordinatorHooks {
  /** Runs at quiescence, immediately before the freeze is requested: flush billable runtime
   *  (suspended time must never appear billed) and persist the workspace. Its own failure
   *  aborts THIS freeze attempt (the seam holds/retries) — never the run. */
  onBeforeFreeze?: () => Promise<void>;
  /** Runs when a wake lands, before the seam resolves: swap the run/api tokens onto the
   *  broker client and rebase the runtime meter past the frozen window. */
  onAfterWake?: (wake: WakePayload) => void | Promise<void>;
}

export interface FreezeCoordinatorDeps {
  channel: RelayChannel;
  now?: () => number;
  /** Injected delay (tests). Defaults to a real timer. */
  delay?: (ms: number) => Promise<void>;
}

export class FreezeCoordinator {
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private hooks: FreezeCoordinatorHooks = {};

  /** Non-suspending runtime work in flight (the quiescence gate's count). */
  private inFlight = 0;
  private quiescenceWaiters: Array<() => void> = [];
  /** True from freeze request until wake/abort — new runtime work queues behind it. */
  private freezePending = false;
  private gateWaiters: Array<() => void> = [];
  /** The parked suspending wait (at most one — waits serialize). */
  private parked: ((outcome: FreezeOutcome) => void) | null = null;
  /** Serializes suspending waits. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: FreezeCoordinatorDeps) {
    this.now = deps.now ?? Date.now;
    // A pending retry delay legitimately keeps the process alive — the run isn't done.
    this.delay =
      deps.delay ??
      ((ms: number): Promise<void> =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
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
   * The suspending wait: hold until quiescence, run the pre-freeze hook, request the
   * freeze, and park. The next thing this promise sees is a wake (possibly epochs later,
   * through a restored heap) or a suspend_abort. Returns the wake, or — for `sleep` only —
   * the abort (the seam then holds in-process); other reasons retry the freeze after a
   * backoff. Concurrent suspending waits serialize through an internal chain.
   */
  suspendingWait(signal: SuspendSignal): Promise<FreezeOutcome> {
    const turn = this.chain;
    let release: () => void = () => undefined;
    this.chain = new Promise((resolve) => {
      release = resolve;
    });
    return (async (): Promise<FreezeOutcome> => {
      await turn;
      try {
        let backoff = ABORT_RETRY_INITIAL_MS;
        for (;;) {
          await this.awaitQuiescence();
          try {
            await this.hooks.onBeforeFreeze?.();
          } catch (err) {
            // A failed pre-freeze flush must not strand the seam: treat it like an abort.
            log.warn("freeze_prepare_failed", {
              error: err instanceof Error ? err.message : String(err),
            });
            if (signal.reason === "sleep") return { kind: "aborted", reason: "prepare_failed" };
            await this.delay(backoff);
            backoff = Math.min(backoff * 2, ABORT_RETRY_MAX_MS);
            continue;
          }
          this.freezePending = true;
          const outcome = await new Promise<FreezeOutcome>((resolve) => {
            this.parked = resolve;
            this.deps.channel.sendSuspendRequest({
              reason: signal.reason,
              wake: this.wakeConditionOf(signal),
              broker_signal: signal,
            });
            // ← the VM freezes while this promise is pending; the wake resolves it with the
            //   heap (and this very closure) restored.
          });
          this.freezePending = false;
          this.releaseGate();
          if (outcome.kind === "wake") return outcome;
          if (signal.reason === "sleep") return outcome;
          log.warn("suspend_aborted_retrying", {
            reason: outcome.reason,
            seamReason: signal.reason,
            backoffMs: backoff,
          });
          await this.delay(backoff);
          backoff = Math.min(backoff * 2, ABORT_RETRY_MAX_MS);
        }
      } finally {
        release();
      }
    })();
  }

  /** Relay handler: a wake injection landed. Validates, runs the after-wake hook (token
   *  swap + meter rebase), confirms to init, and resolves the parked seam. A wake with no
   *  parked seam is a duplicate delivery — re-confirm (idempotent), never crash. */
  onWake(payload: unknown): void {
    const parsed = wakePayloadSchema.safeParse(payload);
    if (!parsed.success) {
      // Unanswerable garbage: init will retry, time out, and the platform's crash path owns
      // recovery. Log loudly — this is a control-plane/init bug, not author code.
      log.error("wake_payload_invalid", { issues: parsed.error.message });
      return;
    }
    if (this.parked === null) {
      log.warn("duplicate_wake_ignored", {});
      this.deps.channel.sendWakeAccepted();
      return;
    }
    const resolve = this.parked;
    this.parked = null;
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
      resolve({ kind: "wake", wake: parsed.data.wake });
    })();
  }

  /** Relay handler: the snapshot attempt failed; the parked seam falls back to holding. */
  onSuspendAbort(payload: unknown): void {
    const parsed = suspendAbortSchema.safeParse(payload);
    const reason = parsed.success ? (parsed.data.reason ?? "unknown") : "unknown";
    if (this.parked === null) {
      log.warn("suspend_abort_without_parked_seam", { reason });
      return;
    }
    const resolve = this.parked;
    this.parked = null;
    resolve({ kind: "aborted", reason });
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

  /** The host-readable wake summary on the wire (logs/metrics/placement) — the opaque
   *  broker_signal beside it carries the full condition. */
  private wakeConditionOf(signal: SuspendSignal): Record<string, unknown> {
    switch (signal.reason) {
      case "sleep":
        return { kind: "sleep", wake_at_ms: this.now() + (signal.durationMs ?? 0) };
      case "human_input":
        return {
          kind: "human_input",
          ...(signal.humanInput !== undefined ? { request_keys: [signal.humanInput.key] } : {}),
        };
      case "workflow_call":
        return {
          kind: "workflow_call",
          ...(signal.childRunId !== undefined ? { child_run_id: signal.childRunId } : {}),
        };
    }
  }
}
