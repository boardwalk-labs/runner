// BudgetMeter — enforces token / USD / compute-time caps declared in the manifest.
//
// One meter per run. The agent loop calls `addUsage()` after each LLM turn and
// `assertWithinCaps()` between turns. When a cap is exceeded the meter throws
// `AppError(BUDGET_EXCEEDED)` and the loop tears down with a `turn_ended
// reason='error'` event.
//
// USD here tracks the bill closely: for a MANAGED turn the meter is fed the managed provider's exact
// per-request cost (already cache-discounted + model-correct), so the `max_usd` cap reflects real spend —
// not a hand-rolled token estimate. Only a BYO turn (no upstream price) or a managed turn whose cost
// the broker couldn't read falls back to a single flat representative rate
// (`model_rates.ts::BUDGET_GUARDRAIL_RATE`), since a per-`agent()`-model run has no one model. Actual
// billing is metered by the platform, not by the runner. The meter takes
// the fallback rate as a constructor arg so tests inject a fixed rate.

import { AppError, ErrorCode } from "../support/index.js";
import type { UsageSnapshot } from "@boardwalk-labs/workflow/runtime";
import type { Budget } from "../wire/manifest.js";

/** Per-million-token rates. */
export interface ModelRate {
  /** USD per million input tokens. */
  inputPerMillion: number;
  /** USD per million output tokens. */
  outputPerMillion: number;
  /** USD per million cache-read tokens (Anthropic). Defaults to inputPerMillion / 10. */
  cacheReadPerMillion?: number;
  /** USD per million cache-write tokens (Anthropic). Defaults to inputPerMillion * 1.25. */
  cacheWritePerMillion?: number;
}

export interface UsageDelta {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Cumulative usage carried forward from PRIOR worker sessions of the same run. Seeded from the
 * checkpoint on resume so budget caps bound the WHOLE run, not just the current session — a run
 * that sleeps / waits on a child / recovers from a crash must not get a fresh budget each time
 *. Zero for a fresh run.
 */
export interface PriorUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalUsd: number;
  /**
   * Active execution time from prior sessions (ms). Only on-CPU turn time counts toward the
   * compute cap — sleep/wait pauses don't burn it (a run intentionally parked for a day must
   * not blow its `max_compute_seconds` budget on resume).
   */
  activeMs: number;
}

const ZERO_PRIOR: PriorUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalUsd: 0,
  activeMs: 0,
};

export interface BudgetMeterOptions {
  budget?: Budget;
  /** Rate for the model the agent is configured with. */
  rate: ModelRate;
  /** This SESSION's start time (ms). Per-session active duration is measured from here. */
  startedAt: number;
  /** Cumulative usage from prior sessions of this run (resume). Defaults to zero. */
  priorUsage?: PriorUsage;
  /** Injected clock for tests. */
  now?: () => number;
}

export interface BudgetSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalUsd: number;
  elapsedMs: number;
}

export class BudgetMeter {
  /** NOT readonly: a budget gate (docs/SUSPEND_POLICY.md Decision 3) raises `max_usd` in place when a
   *  responder approves more spend. The meter lives in the frozen heap, so the wake mutates this
   *  instance and the blocked model call proceeds against the new cap. */
  private budget: Budget | undefined;
  private readonly rate: ModelRate;
  private readonly startedAt: number;
  private readonly prior: PriorUsage;
  private readonly now: () => number;

  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private totalUsd = 0;

  constructor(opts: BudgetMeterOptions) {
    if (opts.budget !== undefined) this.budget = opts.budget;
    this.rate = opts.rate;
    this.startedAt = opts.startedAt;
    this.prior = opts.priorUsage ?? ZERO_PRIOR;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Add a usage delta to the accumulator + recompute USD. `realCostUsd`, when provided, is the EXACT
   * upstream cost the broker observed for this turn (the managed provider's per-request cost) — used
   * verbatim so the `max_usd` cap tracks ACTUAL spend (already cache-discounted, model-correct).
   * Omitted for a BYO turn (no upstream price) or a managed turn whose cost the broker couldn't read,
   * which fall back to the representative-rate {@link costFor} estimate. Token counts accumulate on
   * both paths (they drive the `max_tokens` cap + the snapshot); only the USD basis differs.
   */
  addUsage(delta: UsageDelta, realCostUsd?: number): void {
    this.inputTokens += delta.inputTokens ?? 0;
    this.outputTokens += delta.outputTokens ?? 0;
    this.cacheReadTokens += delta.cacheReadTokens ?? 0;
    this.cacheWriteTokens += delta.cacheWriteTokens ?? 0;
    this.totalUsd += realCostUsd ?? this.costFor(delta);
  }

  /**
   * THIS SESSION's accumulator snapshot (excludes prior-session usage). Read by per-session token
   * metering — which reports token deltas to the platform (deferred; not yet wired into the brokered
   * loop) — and by audit/post-run cost rollups. Cap enforcement uses {@link cumulative} instead.
   */
  snapshot(): BudgetSnapshot {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      totalTokens: this.inputTokens + this.outputTokens,
      totalUsd: this.totalUsd,
      elapsedMs: this.now() - this.startedAt,
    };
  }

  /**
   * RUN-CUMULATIVE snapshot: this session's usage PLUS the prior sessions' usage seeded at
   * construction. Cap enforcement ({@link assertWithinCaps}) and checkpoint persistence use
   * this so a run that resumes after a sleep/wait/crash is bounded by its declared caps across
   * the whole run — not once per session. `snapshot()` stays session-local because
   * per-session token metering reports token deltas; seeding it would double-report usage.
   */
  cumulative(): BudgetSnapshot {
    const s = this.snapshot();
    return {
      inputTokens: s.inputTokens + this.prior.inputTokens,
      outputTokens: s.outputTokens + this.prior.outputTokens,
      cacheReadTokens: s.cacheReadTokens + this.prior.cacheReadTokens,
      cacheWriteTokens: s.cacheWriteTokens + this.prior.cacheWriteTokens,
      totalTokens:
        s.inputTokens + this.prior.inputTokens + s.outputTokens + this.prior.outputTokens,
      totalUsd: s.totalUsd + this.prior.totalUsd,
      elapsedMs: s.elapsedMs + this.prior.activeMs,
    };
  }

  /**
   * Throws `AppError(BUDGET_EXCEEDED)` when any cap is breached. Call BETWEEN
   * turns (after `addUsage` reflects the latest delta) — that way the meter
   * tears the loop down before another LLM call is dispatched.
   */
  assertWithinCaps(): void {
    if (this.budget === undefined) return;
    // Cumulative across resume sessions — caps bound the whole run, not each session.
    const snap = this.cumulative();
    // `max_tokens` deliberately bounds CONVERSATION tokens (input + output) only; cache-read /
    // cache-write tokens are tracked + fully billed via costFor() and are bounded by `max_usd`,
    // not by this cap. totalTokens (snapshot/cumulative) reflects that choice.
    if (this.budget.max_tokens !== undefined && snap.totalTokens > this.budget.max_tokens) {
      throw new AppError(
        ErrorCode.BUDGET_EXCEEDED,
        `Token cap exceeded: ${snap.totalTokens.toString()} > ${this.budget.max_tokens.toString()}`,
        { kind: "tokens", used: snap.totalTokens, cap: this.budget.max_tokens },
      );
    }
    if (this.budget.max_usd !== undefined && snap.totalUsd > this.budget.max_usd) {
      throw new AppError(
        ErrorCode.BUDGET_EXCEEDED,
        `USD cap exceeded: $${snap.totalUsd.toFixed(4)} > $${this.budget.max_usd.toFixed(4)}`,
        { kind: "usd", used: snap.totalUsd, cap: this.budget.max_usd },
      );
    }
    // max_compute_seconds bounds ACTIVE compute (turn time) — a long sleep / human-input wait
    // doesn't burn it. There is deliberately no wall-clock deadline cap (deadline_seconds was
    // deleted with the workflow-format redesign; nothing replaces it).
    if (this.budget.max_compute_seconds !== undefined) {
      const elapsedSeconds = Math.floor(snap.elapsedMs / 1000);
      if (elapsedSeconds > this.budget.max_compute_seconds) {
        throw new AppError(
          ErrorCode.BUDGET_EXCEEDED,
          `Compute cap exceeded: ${elapsedSeconds.toString()}s > ${this.budget.max_compute_seconds.toString()}s`,
          { kind: "compute", used: elapsedSeconds, cap: this.budget.max_compute_seconds },
        );
      }
    }
  }

  /**
   * Predicate variant for callers that prefer to handle the cap-hit path
   * inline (e.g., the sleep tool rejects a sleep that would breach the
   * duration cap). Returns the first breach reason or null.
   */
  /**
   * Raise the `max_usd` cap to `usd` — the budget gate's approval path (docs/SUSPEND_POLICY.md
   * Decision 3). Only ever RAISES: a value at or below the current cap is ignored, so an approval
   * can't silently tighten a cap and re-park the run on the very next call. A no-op when the
   * workflow declared no budget (nothing to breach). Returns the cap now in force, or null when
   * there is no budget.
   */
  raiseUsdCap(usd: number): number | null {
    if (this.budget === undefined) return null;
    const current = this.budget.max_usd;
    if (current !== undefined && usd <= current) return current;
    this.budget = { ...this.budget, max_usd: usd };
    return usd;
  }

  /** The `max_usd` cap in force, or null when unset. The gate prompt reports it alongside spend. */
  usdCap(): number | null {
    return this.budget?.max_usd ?? null;
  }

  capBreachReason(): "tokens" | "usd" | "compute" | null {
    try {
      this.assertWithinCaps();
      return null;
    } catch (err) {
      if (
        err instanceof AppError &&
        typeof err.detail === "object" &&
        err.detail !== null &&
        "kind" in err.detail
      ) {
        return (err.detail as { kind: "tokens" | "usd" | "compute" }).kind;
      }
      throw err;
    }
  }

  /**
   * Live budget state in the host protocol's `usage.get` shape: every dimension always present
   * as `{spent, cap, remaining}`, with `cap`/`remaining` null when uncapped. RUN-CUMULATIVE (the
   * same basis cap enforcement uses), so a program polling it sees the numbers the platform's
   * budget pause would act on. `tokens.spent` is conversation tokens (input + output) — the same
   * basis as the `max_tokens` cap.
   */
  usageSnapshot(): UsageSnapshot {
    const snap = this.cumulative();
    const dimension = (spent: number, cap: number | undefined): UsageSnapshot["usd"] => ({
      spent,
      cap: cap ?? null,
      remaining: cap === undefined ? null : Math.max(0, cap - spent),
    });
    return {
      usd: dimension(snap.totalUsd, this.budget?.max_usd),
      tokens: dimension(snap.totalTokens, this.budget?.max_tokens),
      compute_seconds: dimension(
        Math.floor(snap.elapsedMs / 1000),
        this.budget?.max_compute_seconds,
      ),
    };
  }

  /**
   * USD cost for a single delta — the representative-rate ESTIMATE used only when the broker reports
   * no real upstream cost for the turn (a BYO-provider turn, or a managed turn whose cost tap missed).
   * Managed turns instead carry the managed provider's exact per-request cost through to {@link addUsage}. Public so
   * the loop can stamp the per-step cost without re-deriving the rate table.
   */
  costFor(delta: UsageDelta): number {
    const inputCost = ((delta.inputTokens ?? 0) * this.rate.inputPerMillion) / 1_000_000;
    const outputCost = ((delta.outputTokens ?? 0) * this.rate.outputPerMillion) / 1_000_000;
    const cacheReadRate = this.rate.cacheReadPerMillion ?? this.rate.inputPerMillion / 10;
    const cacheWriteRate = this.rate.cacheWritePerMillion ?? this.rate.inputPerMillion * 1.25;
    const cacheReadCost = ((delta.cacheReadTokens ?? 0) * cacheReadRate) / 1_000_000;
    const cacheWriteCost = ((delta.cacheWriteTokens ?? 0) * cacheWriteRate) / 1_000_000;
    return inputCost + outputCost + cacheReadCost + cacheWriteCost;
  }
}
