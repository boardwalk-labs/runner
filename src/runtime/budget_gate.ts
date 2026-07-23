// SPDX-License-Identifier: MIT

// The budget gate (docs/SUSPEND_POLICY.md Decision 3): when a run hits ANY of its budget caps —
// `max_usd`, `max_tokens`, or `max_compute_seconds` — PARK and ask a person instead of failing the
// run.
//
// Why park rather than throw: on the snapshot fleet a park costs a memory snapshot and releases the
// host, so "wait for a human" is effectively free — while a hard failure discards everything the run
// has done (a real run lost ~40 minutes of paid agent work to a cap breach with no warning). The cap
// stops being a cliff and becomes a checkpoint.
//
// This module is the POLICY (when to park, what to ask, what an answer means). The MECHANISM is the
// host's `budgetClearance` (register-without-release + freeze), which is the same machinery any
// `humanInput()` gate uses.
//
// ## Park points (where `clear()` is awaited)
//
//   - the leaf executor's `streamModel` seam, before EVERY model call — the only place `usd` and
//     `tokens` can move, so they always park here within one in-flight turn of the breach;
//   - the workflow host's blocking/spending capability seams (`sleep`, `shell`, `workflows.call`) —
//     `compute` burns continuously, so a breach between model calls parks at whichever capability
//     the program touches next;
//   - between seams, {@link ComputeBreachWatcher} detects a compute breach on a timer. It cannot
//     itself freeze the VM (see its doc block — true park-anywhere needs fleet-host coordination),
//     so its job is prompt detection + logging; the park still lands at the next seam above.
//
// ## The answer wire format (what backend/web/CLI must send back)
//
// The gate registers as an ordinary human-input row, key `budget`, with a `choice` input spec:
//
//   { kind: "choice", options: [<dimension presets>, "cancel"], other: true }
//
// The presets are dimension-native (render them as the row's buttons verbatim):
//
//   usd      "+$10"   | "+$25" | "+$100"
//   tokens   "+100k"  | "+1M"  | "+10M"
//   compute  "+15min" | "+1h"  | "+4h"
//
// The ANSWER is a single string (a chosen option, or a free-form value via the choice's `other`),
// interpreted against the dimension the gate asked about (the runner knows which dimension parked;
// the answer does not repeat it). Grammar, per dimension — `+` prefix = INCREMENT on the current
// cap, no prefix = ABSOLUTE new cap:
//
//   usd      "+$25", "+25"            → cap + 25 dollars;   "50", "$50"       → cap = $50
//   tokens   "+100k", "+1M", "+2500000" → cap + that many;  "5M", "750k", "2000000" → cap = that
//            (k = thousand, M = million, case-insensitive, fractions allowed: "+2.5M")
//   compute  "+15min", "+1h", "+90s", "+600" → cap + that;  "2h", "90min", "5400" → cap = that
//            (bare number = seconds; s / min / m = minutes / h accepted, fractions allowed: "1.5h")
//
// "cancel" (any case), an empty answer, an unparseable answer, or an absolute value at or below the
// current cap (it would re-park instantly) all CANCEL the run — never guess at a misread answer,
// resuming spends real money. An approved increment too small to clear the breach re-asks (the
// `clear()` loop), so a responder can never resume a run into an instant re-park.
//
// NOTE (inherited from the usd-only gate): concurrent leaves that breach together each register
// their own `budget` gate row; answering each with an increment applies each increment. Approvals
// are explicit per-row human actions, so this compounds by design.

import { createLogger } from "./support/index.js";
import type { BudgetDimension, BudgetMeter } from "./agent/budget.js";
import type { HumanInputResult } from "@boardwalk-labs/workflow";

const log = createLogger("BudgetGate");

/** The stable key a responder answers a budget gate by (`boardwalk respond <runId> budget …`). */
export const BUDGET_GATE_KEY = "budget";

/** Preset approvals per dimension, plus the open-ended `other` answer. Kept small: the point is a
 *  fast decision. These strings ARE the wire options — backend/web render them verbatim. */
export const BUDGET_PRESETS: Record<BudgetDimension, readonly [string, string, string]> = {
  usd: ["+$10", "+$25", "+$100"],
  tokens: ["+100k", "+1M", "+10M"],
  compute: ["+15min", "+1h", "+4h"],
};
export const BUDGET_CHOICE_CANCEL = "cancel";

/** The port the gate needs from the host — narrowed so tests don't build a whole WorkflowHost. */
export interface BudgetClearancePort {
  budgetClearance(gate: { prompt: string; inputSpec: unknown }): Promise<HumanInputResult>;
}

/** Raised when a responder answers `cancel`: the run stops, deliberately, at the user's word. */
export class BudgetGateCancelled extends Error {
  constructor() {
    super("Run cancelled at the budget gate.");
    this.name = "BudgetGateCancelled";
  }
}

/** Money in a prompt: 2dp is right for a cap, which is always a human-chosen round-ish number. */
function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Token counts in a prompt: grouped digits ("1,200,000") — exact beats approximate at a gate. */
function tokens(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Compute time in a prompt: "1h 15m", "45m", "30s" — seconds only below a minute. */
function computeTime(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${String(h)}h`);
  if (m > 0) parts.push(`${String(m)}m`);
  if (parts.length === 0 || (h === 0 && sec > 0)) parts.push(`${String(sec)}s`);
  return parts.join(" ");
}

/**
 * The gate's question. It states the two numbers that matter (spent vs. cap) so the responder can
 * decide without opening the dashboard, and names the run's own manifest cap field so it's obvious
 * WHICH cap was hit (not the org's credit balance — a different failure with a different fix).
 */
export function budgetGatePrompt(dimension: BudgetDimension, spent: number, cap: number): string {
  if (dimension === "usd") {
    return (
      `Budget cap reached: this run has spent ${usd(spent)} of its ${usd(cap)} ` +
      `max_usd cap. Approve more spend to continue, or cancel the run.`
    );
  }
  if (dimension === "tokens") {
    return (
      `Budget cap reached: this run has used ${tokens(spent)} tokens of its ${tokens(cap)}-token ` +
      `max_tokens cap. Approve more tokens to continue, or cancel the run.`
    );
  }
  return (
    `Budget cap reached: this run has used ${computeTime(spent)} of its ${computeTime(cap)} ` +
    `max_compute_seconds cap. Approve more compute time to continue, or cancel the run.`
  );
}

/** The gate's response form — a choice, so the common answers are one click / one word. */
export function budgetGateInputSpec(dimension: BudgetDimension): unknown {
  return {
    kind: "choice",
    options: [...BUDGET_PRESETS[dimension], BUDGET_CHOICE_CANCEL],
    // `other` lets a responder type an absolute cap ("50") instead of taking a preset increment.
    other: true,
  };
}

/** Parse one numeric budget answer (`"25"`, `"2.5M"`, `"90min"`) into the dimension's native unit
 *  (dollars / tokens / seconds), or null when unreadable. The `+` increment prefix is handled by
 *  the caller — this reads only the magnitude. */
function parseAmount(dimension: BudgetDimension, raw: string): number | null {
  if (dimension === "usd") {
    const m = /^\$?\s*(\d+(?:\.\d+)?)$/.exec(raw);
    return m?.[1] === undefined ? null : Number(m[1]);
  }
  if (dimension === "tokens") {
    const m = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(raw);
    if (m?.[1] === undefined) return null;
    const mult = m[2]?.toLowerCase() === "k" ? 1_000 : m[2]?.toLowerCase() === "m" ? 1_000_000 : 1;
    return Math.round(Number(m[1]) * mult);
  }
  const m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs)?$/i.exec(raw);
  if (m?.[1] === undefined) return null;
  const unit = m[2]?.toLowerCase() ?? "s";
  const mult = unit.startsWith("h") ? 3600 : unit.startsWith("m") ? 60 : 1;
  return Math.round(Number(m[1]) * mult);
}

/**
 * Interpret an answer as the NEW absolute cap for `dimension`, or null to cancel the run.
 *
 * `+<amount>` is an INCREMENT on the current cap (the presets); a bare amount is an ABSOLUTE new
 * cap (the "set a cap" escape hatch, via the choice's `other` entry). Anything unrecognized is
 * treated as cancel rather than guessed at — silently resuming a run on a misread answer spends
 * real money. See the module header for the full per-dimension grammar.
 */
export function resolveBudgetAnswer(
  dimension: BudgetDimension,
  answer: string,
  currentCap: number,
): number | null {
  const raw = answer.trim();
  if (raw === "" || raw.toLowerCase() === BUDGET_CHOICE_CANCEL) return null;

  if (raw.startsWith("+")) {
    const amount = parseAmount(dimension, raw.slice(1).trim());
    return amount === null ? null : currentCap + amount;
  }
  const absolute = parseAmount(dimension, raw);
  if (absolute === null) return null;
  // An "absolute" cap at or below the current one would re-park instantly — read it as a refusal
  // to fund more, which is a cancel.
  return absolute > currentCap ? absolute : null;
}

/** Pull the answer's text out of the SDK's result union (text | choice | multiselect). */
function answerText(result: HumanInputResult): string {
  if (typeof result === "string") return result;
  if (typeof result === "object" && result !== null && "value" in result) {
    const value = (result as { value: unknown }).value;
    if (typeof value === "string") return value;
  }
  return "";
}

/**
 * Budget clearance, awaited at every park point (see the module header). Fast path: no breach ⇒
 * resolve immediately (the overwhelming majority of calls). On a breach of ANY dimension: park at
 * a gate, then apply the answer to the live meter and let the call proceed.
 *
 * The park's own wall-clock is EXCLUDED from the compute cap (`meter.excludeIdle`): parked time is
 * not compute (SUSPEND_POLICY Decision 3.4), and on the snapshot fleet the guest clock resyncs
 * across the frozen window — without the exclusion a compute park would re-breach the instant it
 * woke, forever. `usage.get()` polled DURING a park may transiently show the parked wall-clock as
 * compute spend; the exclusion lands when the park resolves.
 */
export class BudgetGate {
  constructor(
    private readonly meter: BudgetMeter,
    private readonly host: BudgetClearancePort,
    private readonly now: () => number = Date.now,
  ) {}

  async clear(): Promise<void> {
    // Loop, don't `if`: a responder can approve an increment too small to clear the breach (spend
    // already exceeds it) — ask again rather than resume into an instant re-park — and clearing
    // one dimension can reveal a second breached one, which parks next.
    for (;;) {
      const dimension = this.meter.capBreachReason();
      if (dimension === null) return;
      const cap = this.meter.cap(dimension);
      if (cap === null) return; // no cap ⇒ nothing to breach (defensive; capBreachReason implies one)
      const spent = this.meter.spent(dimension);

      // The park needs no bespoke event: registering the gate moves the run to `awaiting_input` and
      // the prompt below rides the gate row, so the live tail + `boardwalk inputs` explain the pause
      // through exactly the same path a humanInput() gate uses.
      const parkedAt = this.now();
      const answer = await this.host.budgetClearance({
        prompt: budgetGatePrompt(dimension, spent, cap),
        inputSpec: budgetGateInputSpec(dimension),
      });
      // Parked time is not compute — exclude it BEFORE re-checking the breach, or a compute park
      // could never clear (the frozen/held wait would count as fresh compute spend).
      this.meter.excludeIdle(this.now() - parkedAt);

      const newCap = resolveBudgetAnswer(dimension, answerText(answer), cap);
      if (newCap === null) throw new BudgetGateCancelled();
      this.meter.raiseCap(dimension, newCap);
    }
  }
}

/** How often the watcher samples the meter. Coarse is fine: compute presets are minutes. */
export const DEFAULT_COMPUTE_WATCH_INTERVAL_MS = 15_000;

/**
 * Detects a `max_compute_seconds` breach BETWEEN park points. `usd`/`tokens` only move at the
 * `streamModel` seam, but compute burns continuously — a breach can land mid-shell, mid-turn, or
 * mid-program-compute, far from any model call.
 *
 * WHY THIS ONLY DETECTS AND DOES NOT PARK — true park-anywhere needs fleet-host work. The freeze
 * machinery is quiescence-gated: `budgetClearance` may only be entered from a work-tracked seam
 * (its `freezeWait` steps the CALLER out of the work count; from a timer context that corrupts the
 * count and could freeze around live in-flight work, which SUSPEND_POLICY Decision 1 forbids). A
 * timer-initiated park would need (a) a host-agent-initiated out-of-band VM pause that does not
 * require runner quiescence, plus a wake path that re-arms the runner-side gate and applies the
 * answer to the meter, and (b) on hold-only substrates a program-process stop (SIGSTOP) in the
 * program runner. Until that lands, the honest contract is: the watcher logs the breach the moment
 * it happens, and the run PARKS AT ITS NEXT SEAM (`streamModel`, `sleep`, `shell`,
 * `workflows.call`) via the same {@link BudgetGate.clear} every park point awaits.
 */
export class ComputeBreachWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private announced = false;

  constructor(
    private readonly meter: BudgetMeter,
    private readonly opts: { runId: string; intervalMs?: number } = { runId: "" },
  ) {}

  /** True while a compute breach is standing (sampled; resets when an approval clears it). */
  get breachDetected(): boolean {
    return this.announced;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.sample();
    }, this.opts.intervalMs ?? DEFAULT_COMPUTE_WATCH_INTERVAL_MS);
    // Never keep the worker process alive solely for this watcher.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One sample tick (exposed for tests — real ticks come from the interval). */
  sample(): void {
    const cap = this.meter.cap("compute");
    const breached = cap !== null && this.meter.spent("compute") > cap;
    if (breached && !this.announced) {
      this.announced = true;
      log.warn("budget_compute_breach_between_seams", {
        runId: this.opts.runId,
        spentSeconds: this.meter.spent("compute"),
        capSeconds: cap,
        note: "run parks at its next capability seam (streamModel / sleep / shell / workflows.call)",
      });
    } else if (!breached && this.announced) {
      // The cap was raised at a gate — re-arm so a later breach of the NEW cap logs again.
      this.announced = false;
    }
  }
}
