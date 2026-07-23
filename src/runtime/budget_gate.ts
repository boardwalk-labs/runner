// SPDX-License-Identifier: MIT

// The budget gate (docs/SUSPEND_POLICY.md Decision 3): when a run hits its `max_usd` cap, PARK and
// ask a person instead of failing the run.
//
// Why park rather than throw: on the snapshot fleet a park costs a memory snapshot and releases the
// host, so "wait for a human" is effectively free — while a hard failure discards everything the run
// has done (a real run lost ~40 minutes of paid agent work to a cap breach with no warning). The cap
// stops being a cliff and becomes a checkpoint.
//
// This module is the POLICY (when to park, what to ask, what an answer means). The MECHANISM is the
// host's `budgetClearance` (register-without-release + freeze), which is the same machinery any
// `humanInput()` gate uses.

import type { BudgetMeter } from "./agent/budget.js";
import type { HumanInputResult } from "@boardwalk-labs/workflow";

/** The stable key a responder answers a budget gate by (`boardwalk respond <runId> budget …`). */
export const BUDGET_GATE_KEY = "budget";

/** Preset approvals, plus the two open-ended answers. Kept small: the point is a fast decision. */
export const BUDGET_CHOICE_ADD_10 = "+$10";
export const BUDGET_CHOICE_ADD_25 = "+$25";
export const BUDGET_CHOICE_ADD_100 = "+$100";
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

/**
 * The gate's question. It states the two numbers that matter (spent vs. cap) so the responder can
 * decide without opening the dashboard, and names the run's own `max_usd` so it's obvious WHICH cap
 * was hit (not the org's credit balance — a different failure with a different fix).
 */
export function budgetGatePrompt(spentUsd: number, capUsd: number): string {
  return (
    `Budget cap reached: this run has spent ${usd(spentUsd)} of its ${usd(capUsd)} ` +
    `max_usd cap. Approve more spend to continue, or cancel the run.`
  );
}

/** The gate's response form — a choice, so the common answers are one click / one word. */
export function budgetGateInputSpec(): unknown {
  return {
    kind: "choice",
    options: [
      BUDGET_CHOICE_ADD_10,
      BUDGET_CHOICE_ADD_25,
      BUDGET_CHOICE_ADD_100,
      BUDGET_CHOICE_CANCEL,
    ],
    // `other` lets a responder type an absolute cap ("50") instead of taking a preset increment.
    other: true,
  };
}

/**
 * Interpret an answer as the NEW absolute `max_usd`, or null to cancel the run.
 *
 * `+$N` is an INCREMENT on the current cap (the presets); a bare number is an ABSOLUTE new cap (the
 * "set a cap" escape hatch, via the choice's `other` entry). Anything unrecognized is treated as
 * cancel rather than guessed at — silently resuming a run on a misread answer spends real money.
 */
export function resolveBudgetAnswer(answer: string, currentCapUsd: number): number | null {
  const raw = answer.trim();
  if (raw === "" || raw.toLowerCase() === BUDGET_CHOICE_CANCEL) return null;

  const increment = /^\+\s*\$?\s*(\d+(?:\.\d+)?)$/.exec(raw);
  if (increment?.[1] !== undefined) return currentCapUsd + Number(increment[1]);

  const absolute = /^\$?\s*(\d+(?:\.\d+)?)$/.exec(raw);
  if (absolute?.[1] !== undefined) {
    const value = Number(absolute[1]);
    // An "absolute" cap at or below what's already spent would re-park instantly — read it as a
    // refusal to fund more, which is a cancel.
    return value > currentCapUsd ? value : null;
  }
  return null;
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
 * Budget clearance, awaited before every model call. Fast path: no breach ⇒ resolve immediately (the
 * overwhelming majority of calls). On a `usd` breach: park at a gate, then apply the answer to the
 * live meter and let the call proceed.
 *
 * Scope (slice 1): ONLY the `usd` cap parks. A `tokens` / `compute` breach still fails the run
 * through the leaf executor's existing throw — the locked budget decision makes those pausable too
 * (dimension-native presets at the same gate), which is the remaining P3 budget-alignment work.
 */
export class BudgetGate {
  constructor(
    private readonly meter: BudgetMeter,
    private readonly host: BudgetClearancePort,
  ) {}

  async clear(): Promise<void> {
    // Loop, don't `if`: a responder can approve an increment too small to clear the breach (spend
    // already exceeds it), in which case we ask again rather than resume into an instant re-park.
    while (this.meter.capBreachReason() === "usd") {
      const cap = this.meter.usdCap();
      if (cap === null) return; // no cap ⇒ nothing to breach (defensive; capBreachReason implies one)
      const spent = this.meter.snapshot().totalUsd;

      // The park needs no bespoke event: registering the gate moves the run to `awaiting_input` and
      // the prompt below rides the gate row, so the live tail + `boardwalk inputs` explain the pause
      // through exactly the same path a humanInput() gate uses.
      const answer = await this.host.budgetClearance({
        prompt: budgetGatePrompt(spent, cap),
        inputSpec: budgetGateInputSpec(),
      });

      const newCap = resolveBudgetAnswer(answerText(answer), cap);
      if (newCap === null) throw new BudgetGateCancelled();
      this.meter.raiseUsdCap(newCap);
    }
  }
}
