// CancelWatcher — stops a run when the user cancels it mid-flight.
//
// The user-cancel counterpart to CreditWatcher. One per run session. On a timer it asks — through the
// broker (`GET /cancel`, since the runner holds no DB/Redis credential) — whether the run has been
// asked to cancel; the FIRST time it has, it fires `onCancelled` once (the orchestrator wires this to
// `AbortController.abort(new RunAbortedError("cancelled"))`, which the WorkflowHost honors cooperatively
// at the next hook boundary — a `sleep` hold wakes immediately, an `agent()`/`workflows.call` unwinds)
// and stops checking.
//
// Why brokered + polled (not Redis pub/sub): the brokered worker holds NO Redis client, so the
// api-server's `run-cancel:<id>` publish never reached it — a flipped-to-`cancelling` run just ran to
// completion. The broker exposes the run's status; the worker polls it, like funding.

import { createLogger } from "./support/index.js";

const log = createLogger("CancelWatcher");

/** Default cancel-poll cadence. Snappier than the 60s credit poll so a user's cancel lands within a few
 *  seconds; each poll is a cheap brokered run-status read. */
export const DEFAULT_CANCEL_CHECK_INTERVAL_MS = 5_000;

export interface CancelWatcherDeps {
  /** The run being watched (for correlation/logging). */
  runId: string;
  /** Resolves true once the run has been asked to cancel. Brokered
   *  (`RunnerControlClient.checkCancelled` → `GET /cancel`), so the runner never reads the DB. */
  isCancelled: () => Promise<boolean>;
  /** Fired exactly once the first time the run is seen to be cancelled. */
  onCancelled: () => void;
  intervalMs?: number;
}

export class CancelWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private firing: Promise<void> = Promise.resolve();
  private cancelled = false;
  private stopped = false;

  constructor(private readonly deps: CancelWatcherDeps) {}

  /** Begin periodic cancel checks. */
  start(): void {
    if (this.timer !== null) return;
    const interval = this.deps.intervalMs ?? DEFAULT_CANCEL_CHECK_INTERVAL_MS;
    this.timer = setInterval(() => {
      this.firing = this.firing.then(() => this.check());
    }, interval);
    // Don't keep the worker process alive solely for the cancel timer.
    this.timer.unref();
  }

  /** Stop checking and drain any in-flight check. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.firing.catch(() => undefined);
  }

  /** Whether a cancel was detected (the orchestrator may read this to shape the terminal result). */
  wasCancelled(): boolean {
    return this.cancelled;
  }

  /** True once the watcher should no longer act. A method (not an inline field read) so it's
   *  re-evaluated after an `await` — `stop()` can flip `stopped` mid-check. */
  private done(): boolean {
    return this.stopped || this.cancelled;
  }

  private async check(): Promise<void> {
    if (this.done()) return;
    let cancelled: boolean;
    try {
      cancelled = await this.deps.isCancelled();
    } catch (err) {
      // A failed cancel check must NOT kill a healthy run — log and let the next tick retry.
      log.warn("cancel_check_failed", {
        runId: this.deps.runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!cancelled || this.done()) return;
    this.cancelled = true;
    log.info("run_cancel_requested", { runId: this.deps.runId });
    this.deps.onCancelled();
  }
}
