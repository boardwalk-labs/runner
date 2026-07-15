// RuntimeFlusher — meters a run's held-task runtime as periodic DELTAS, instead of one charge at
// terminal. The heartbeat counterpart to the credit / cancel
// / lease watchers.
//
// Why: runtime used to be booked once, at terminal (`now - sessionStart`). That left two holes — a run
// that never terminates (a perpetual loop) NEVER billed its runtime (and the credit watcher, reading
// the billing balance, never saw the burn so it couldn't stop it); and a session that crashed before finalizing had
// its whole runtime lost. Metering on a timer closes both: runtime is billed as it accrues, the credit
// watcher sees it, and a crashed session keeps the deltas it already flushed (the fresh session bills
// its own — distinct ids sum, so the restart isn't double-charged or under-charged for the overlap-free
// portion).
//
// Idempotency: each flush is a delta with a fixed per-flush id (`<runId>:<sessionId>:rt:<seq>`); the
// broker/usage store dedupes on it, so a retried flush bills once. On a report failure we DON'T advance
// `flushedSeconds`/`seq`, so the next tick retries the SAME id (with a delta grown by the elapsed since)
// — the dedup keeps whichever landed first, bounding any loss to ~one interval and NEVER double-billing.
// `flushFinal()` books the tail (since the last successful flush) on a clean terminal; it is deliberately
// NOT called on a `lease_lost` handoff (the new owner books its own runtime — see program_worker).

import { createLogger } from "./support/index.js";

const log = createLogger("RuntimeFlusher");

/** Flush cadence — runtime is billed within ~this window of accruing, so a long/perpetual run can't
 *  burn unbilled compute and the credit watcher sees the spend promptly. */
export const DEFAULT_RUNTIME_FLUSH_INTERVAL_MS = 60_000;

export interface RuntimeFlusherDeps {
  /** The run being metered (for the id base + correlation). */
  runId: string;
  /** This worker session's id (fresh per claim) — separates a restarted run's sessions in the id. */
  sessionId: string;
  /** Wall-clock at which this session's runtime starts accruing (the claim time). */
  startedAtMs: number;
  /** vCPUs provisioned for the task. Runtime is billed per vCPU-SECOND, so each delta is wall-clock
   *  seconds × this. Defaults to 1 (the 1-vCPU `small` size → vCPU-seconds == wall-clock). */
  vcpus?: number;
  /** Monotonic-ish clock; injected for tests. */
  now: () => number;
  /** Book a runtime vCPU-seconds delta under `identifier` (brokered: `RunnerControlClient.reportUsage`). */
  report: (deltaSeconds: number, identifier: string) => Promise<void>;
  intervalMs?: number;
}

export class RuntimeFlusher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private firing: Promise<void> = Promise.resolve();
  private stopped = false;
  /** Total vCPU-seconds already booked (across successful flushes). The next delta is `total - this`. */
  private flushedSeconds = 0;
  /** Per-flush sequence — advances only on a successful flush, so a retry reuses the same id. */
  private seq = 0;
  /** Wall-clock ms excluded from billing — frozen (suspended) time on the snapshot substrate. */
  private excludedMs = 0;

  constructor(private readonly deps: RuntimeFlusherDeps) {}

  /** Book everything unbilled right now (the pre-freeze flush: suspended time must never appear as
   *  billed runtime, so the tail is booked BEFORE the snapshot — the suspension billing rule). */
  async flushNow(): Promise<void> {
    await this.flush(false);
  }

  /** Exclude `ms` of wall-clock from billing — the frozen window on a wake (computed from the wake's
   *  authoritative wall clock, since the guest's own clock was stopped). Never lets elapsed go
   *  negative. */
  excludeIdle(ms: number): void {
    if (ms > 0) this.excludedMs += ms;
  }

  /** Begin periodic delta flushing. */
  start(): void {
    if (this.timer !== null) return;
    const interval = this.deps.intervalMs ?? DEFAULT_RUNTIME_FLUSH_INTERVAL_MS;
    this.timer = setInterval(() => {
      this.firing = this.firing.then(() => this.flush(false));
    }, interval);
    // Don't keep the worker process alive solely for the flush timer.
    this.timer.unref();
  }

  /**
   * Suspend the periodic timer across a VM freeze — the pre-freeze hook pauses AFTER the tail flush
   * (as its last, non-throwing step), and the wake path resumes AFTER {@link excludeIdle}. Without
   * this, a tick landing in the sliver between the guest clock resync and the idle rebase would
   * compute its delta over the whole frozen window and bill suspended time. Reversible, unlike
   * {@link stop}; a freeze that aborts (snapshot failure → the seam holds in-process) must resume so
   * a long hold keeps metering.
   */
  pause(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Restart periodic flushing after {@link pause} (wake, or a freeze abort). No-op once stopped. */
  resume(): void {
    if (this.stopped) return;
    this.start();
  }

  /** Stop the periodic timer and drain any in-flight flush. Does NOT book the final tail — call
   *  {@link flushFinal} for that on a clean terminal. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.firing.catch(() => undefined);
  }

  /** Book the remaining runtime since the last successful flush (the terminal tail). Runs even after
   *  {@link stop}; it's the replacement for the old single terminal runtime charge. */
  async flushFinal(): Promise<void> {
    await this.flush(true);
  }

  /** Compute the unbilled delta and book it under a fixed per-flush id. `final` lets the terminal tail
   *  flush after `stop()`; the timer path skips once stopped. */
  private async flush(final: boolean): Promise<void> {
    if (this.stopped && !final) return;
    // vCPU-seconds = wall-clock seconds × vCPUs (billed per vCPU-second). Rounding the cumulative
    // product (not per-delta) keeps the booked total aligned with wall-clock×vcpus over many flushes.
    const vcpus = this.deps.vcpus ?? 1;
    const total = Math.max(
      0,
      Math.round(((this.deps.now() - this.deps.startedAtMs - this.excludedMs) / 1000) * vcpus),
    );
    const delta = total - this.flushedSeconds;
    if (delta < 1) return;
    const identifier = `${this.deps.runId}:${this.deps.sessionId}:rt:${String(this.seq)}`;
    try {
      await this.deps.report(delta, identifier);
    } catch (err) {
      // A transient report failure must NOT kill a live run — leave `flushedSeconds`/`seq` unadvanced
      // so the next flush retries the SAME id (dedup => no double-bill; at most ~one interval lost).
      log.warn("runtime_flush_failed", {
        runId: this.deps.runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    this.flushedSeconds = total;
    this.seq += 1;
  }
}
