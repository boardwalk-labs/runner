// LeaseRenewer — keeps a long run's lease fresh so the recovery sweep doesn't reclaim a STILL-ALIVE
// worker (the Runner Credential Broker model).
//
// A run is claimed with a fixed lease (DEFAULT_LEASE_MS, 5 min). The worker never used to renew it,
// so any run longer than the lease (an Opus agentic loop is routinely 7+ min) had its lease expire
// mid-flight; the 1-min recovery sweep then reclaimed the live run and re-dispatched it — a redundant
// concurrent attempt that doubled the spend. This watcher (the heartbeat counterpart to the credit /
// cancel watchers) re-extends the lease on a timer through the broker (`POST /renew`, since the runner
// holds no DB credential).
//
// On a transient renew failure it just retries next tick (the renew cadence leaves several minutes of
// lease headroom, so a blip is harmless). On a DEFINITIVE loss (the broker says the run is no longer
// ours — another worker reclaimed it), it fires `onLost` once: the orchestrator aborts with
// `lease_lost`, and the worker stops WITHOUT finalizing so it can't clobber the new owner's run.

import { createLogger } from "./support/index.js";

const log = createLogger("LeaseRenewer");

/** Renew cadence — well under the 5-min lease so a renewed lease always has minutes of headroom (a
 *  missed tick still has time to recover before the lease expires). */
export const DEFAULT_LEASE_RENEW_INTERVAL_MS = 120_000;

export interface LeaseRenewerDeps {
  /** The run being kept alive (for correlation/logging). */
  runId: string;
  /** Extend the lease; resolves true while we still hold it, false once it's definitively lost
   *  (brokered: `RunnerControlClient.renewLease` → `POST /renew`). */
  renew: () => Promise<boolean>;
  /** Fired exactly once the first time the lease is seen to be lost. */
  onLost: () => void;
  intervalMs?: number;
}

export class LeaseRenewer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private firing: Promise<void> = Promise.resolve();
  private lost = false;
  private stopped = false;

  constructor(private readonly deps: LeaseRenewerDeps) {}

  /** Begin periodic lease renewal. */
  start(): void {
    if (this.timer !== null) return;
    const interval = this.deps.intervalMs ?? DEFAULT_LEASE_RENEW_INTERVAL_MS;
    this.timer = setInterval(() => {
      this.firing = this.firing.then(() => this.tick());
    }, interval);
    // Don't keep the worker process alive solely for the renew timer.
    this.timer.unref();
  }

  /** Stop renewing and drain any in-flight renew. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.firing.catch(() => undefined);
  }

  /** Whether the lease was definitively lost (the orchestrator may read this to shape the outcome). */
  isLost(): boolean {
    return this.lost;
  }

  /** True once the renewer should no longer act. A method (re-evaluated after an `await`) so `stop()`
   *  can flip `stopped` mid-tick. */
  private done(): boolean {
    return this.stopped || this.lost;
  }

  private async tick(): Promise<void> {
    if (this.done()) return;
    let held: boolean;
    try {
      held = await this.deps.renew();
    } catch (err) {
      // A transient renew failure must NOT kill a live run — log and let the next tick retry while
      // the current lease still has headroom.
      log.warn("lease_renew_failed", {
        runId: this.deps.runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (held || this.done()) return;
    this.lost = true;
    log.info("run_lease_lost", { runId: this.deps.runId });
    this.deps.onLost();
  }
}
