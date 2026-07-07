// CreditWatcher — stops a run when its org runs out of prepaid credit mid-flight (the platform spec +
// the coding-agent design §6/§10).
//
// One per run session. On a timer it asks — through the broker (`GET /credit`, since the runner holds
// no Stripe credential) — whether the org is still funded; the FIRST time it isn't, it fires
// `onExhausted` once (the orchestrator wires this to `AbortController.abort`, which the WorkflowHost
// honors cooperatively) and stops checking. This is the org-level counterpart to the per-run
// BudgetMeter cap: the run can't see Stripe balances, so funding is enforced here, out of band,
// against the live balance that incremental token metering keeps fresh.
//
// "Prompt, not instant": Stripe meter aggregation is eventually-consistent and the host honors the
// abort at the next hook boundary, so a run stops within ~one check interval (plus Stripe's lag) of
// going unfunded — bounding overshoot, not eliminating it. Applies to MANAGED and BYOK runs alike,
// since runtime always burns credit (the gate requires the runtime floor regardless of token billing).

import { createLogger } from "./support/index.js";

const log = createLogger("CreditWatcher");

/** Default funding-check cadence. */
export const DEFAULT_CREDIT_CHECK_INTERVAL_MS = 60_000;

export interface CreditWatcherDeps {
  /** The run being watched (for correlation/logging). */
  runId: string;
  /** Resolves true while the org can keep spending; false once it's out of credit. Brokered
   *  (`RunnerControlClient.checkCredit` → `GET /credit`), so the runner never reads Stripe. */
  isFunded: () => Promise<boolean>;
  /** Fired exactly once when the org is first seen to be out of credit. */
  onExhausted: () => void;
  intervalMs?: number;
}

export class CreditWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private firing: Promise<void> = Promise.resolve();
  private exhausted = false;
  private stopped = false;

  constructor(private readonly deps: CreditWatcherDeps) {}

  /** Begin periodic funding checks. */
  start(): void {
    if (this.timer !== null) return;
    const interval = this.deps.intervalMs ?? DEFAULT_CREDIT_CHECK_INTERVAL_MS;
    this.timer = setInterval(() => {
      this.firing = this.firing.then(() => this.check());
    }, interval);
    // Don't keep the worker process alive solely for the credit timer.
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

  /** Whether exhaustion was detected (the orchestrator may read this to shape the terminal result). */
  isExhausted(): boolean {
    return this.exhausted;
  }

  /** True once the watcher should no longer act. A method (not an inline field read) so it's
   *  re-evaluated after an `await` — `stop()` can flip `stopped` mid-check. */
  private done(): boolean {
    return this.stopped || this.exhausted;
  }

  private async check(): Promise<void> {
    if (this.done()) return;
    let funded: boolean;
    try {
      funded = await this.deps.isFunded();
    } catch (err) {
      // A failed balance check must NOT kill a paying run — log and let the next tick retry.
      log.warn("credit_check_failed", {
        runId: this.deps.runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (funded || this.done()) return;
    this.exhausted = true;
    log.info("run_credit_exhausted", { runId: this.deps.runId });
    this.deps.onExhausted();
  }
}
