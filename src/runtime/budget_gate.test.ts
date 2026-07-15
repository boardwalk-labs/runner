// SPDX-License-Identifier: MIT

import { describe, it, expect, vi } from "vitest";
import {
  BudgetGate,
  BudgetGateCancelled,
  budgetGatePrompt,
  budgetGateInputSpec,
  resolveBudgetAnswer,
  type BudgetClearancePort,
} from "./budget_gate.js";
import { BudgetMeter } from "./agent/budget.js";
import type { HumanInputResult } from "@boardwalk-labs/workflow";

/** A meter with a $10 cap, priced so 1M output tokens = $10 exactly (easy arithmetic below). */
function meter(maxUsd?: number): BudgetMeter {
  return new BudgetMeter({
    ...(maxUsd === undefined ? {} : { budget: { max_usd: maxUsd } }),
    rate: { inputPerMillion: 0, outputPerMillion: 10 },
    startedAt: 0,
    now: () => 0,
  });
}

/** Spend `usd` on the meter via a real usage delta (not a private poke). */
function spend(m: BudgetMeter, usd: number): void {
  m.addUsage({ outputTokens: 0 }, usd);
}

/** A host that answers every gate with `answers` in order, recording the prompts it was asked. */
function host(answers: string[]): BudgetClearancePort & { prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  return {
    prompts,
    budgetClearance: (gate: { prompt: string; inputSpec: unknown }): Promise<HumanInputResult> => {
      prompts.push(gate.prompt);
      const answer = answers[i++] ?? "cancel";
      return Promise.resolve({ value: answer } as unknown as HumanInputResult);
    },
  };
}

describe("resolveBudgetAnswer", () => {
  it("reads a +$N preset as an INCREMENT on the current cap", () => {
    expect(resolveBudgetAnswer("+$25", 25)).toBe(50);
    expect(resolveBudgetAnswer("+$10", 25)).toBe(35);
    expect(resolveBudgetAnswer("+100", 25)).toBe(125);
  });

  it("reads a bare number as an ABSOLUTE new cap", () => {
    expect(resolveBudgetAnswer("80", 25)).toBe(80);
    expect(resolveBudgetAnswer("$80", 25)).toBe(80);
    expect(resolveBudgetAnswer("12.50", 10)).toBe(12.5);
  });

  it("cancels on an absolute cap that wouldn't raise anything (it would re-park instantly)", () => {
    expect(resolveBudgetAnswer("25", 25)).toBeNull();
    expect(resolveBudgetAnswer("10", 25)).toBeNull();
  });

  it("cancels on an explicit cancel, a blank, or anything it can't read", () => {
    expect(resolveBudgetAnswer("cancel", 25)).toBeNull();
    expect(resolveBudgetAnswer("CANCEL", 25)).toBeNull();
    expect(resolveBudgetAnswer("", 25)).toBeNull();
    expect(resolveBudgetAnswer("   ", 25)).toBeNull();
    // Never guess at a misread answer — resuming spends real money.
    expect(resolveBudgetAnswer("yes please", 25)).toBeNull();
    expect(resolveBudgetAnswer("a lot more", 25)).toBeNull();
  });
});

describe("BudgetMeter.raiseUsdCap", () => {
  it("raises the cap and clears the breach", () => {
    const m = meter(10);
    spend(m, 12);
    expect(m.capBreachReason()).toBe("usd");
    expect(m.raiseUsdCap(25)).toBe(25);
    expect(m.capBreachReason()).toBeNull();
    expect(m.usdCap()).toBe(25);
  });

  it("only ever RAISES — a lower value is ignored, so an approval can't tighten the cap", () => {
    const m = meter(25);
    expect(m.raiseUsdCap(10)).toBe(25);
    expect(m.usdCap()).toBe(25);
  });

  it("is a no-op with no declared budget", () => {
    const m = meter();
    expect(m.raiseUsdCap(50)).toBeNull();
    expect(m.usdCap()).toBeNull();
  });
});

describe("BudgetGate.clear", () => {
  it("resolves immediately, without parking, when the cap isn't breached (the hot path)", async () => {
    const m = meter(10);
    spend(m, 1);
    const h = host([]);
    const clearance = vi.spyOn(h, "budgetClearance");
    await new BudgetGate(m, h).clear();
    expect(clearance).not.toHaveBeenCalled();
  });

  it("never parks a workflow that declared no budget", async () => {
    const m = meter();
    spend(m, 9_999);
    const h = host([]);
    const clearance = vi.spyOn(h, "budgetClearance");
    await new BudgetGate(m, h).clear();
    expect(clearance).not.toHaveBeenCalled();
  });

  it("parks on breach, raises the cap from the answer, and lets the call proceed", async () => {
    const m = meter(10);
    spend(m, 12);
    const h = host(["+$25"]);
    await new BudgetGate(m, h).clear();
    expect(m.usdCap()).toBe(35); // 10 + 25
    expect(m.capBreachReason()).toBeNull();
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain("$12.00");
    expect(h.prompts[0]).toContain("$10.00");
  });

  it("asks AGAIN when the approval was too small to clear the breach (never resume into a re-park)", async () => {
    const m = meter(10);
    spend(m, 30);
    // +$5 → cap 15, still under the $30 spent ⇒ ask again; +$25 → cap 40 ⇒ cleared.
    const h = host(["+$5", "+$25"]);
    await new BudgetGate(m, h).clear();
    expect(h.prompts).toHaveLength(2);
    expect(m.usdCap()).toBe(40);
    expect(m.capBreachReason()).toBeNull();
  });

  it("throws BudgetGateCancelled when the responder declines", async () => {
    const m = meter(10);
    spend(m, 12);
    await expect(new BudgetGate(m, host(["cancel"])).clear()).rejects.toThrow(BudgetGateCancelled);
  });

  it("does NOT park on a non-usd breach — those still fail the run (slice 1 scope)", async () => {
    const m = new BudgetMeter({
      budget: { max_tokens: 100 },
      rate: { inputPerMillion: 0, outputPerMillion: 0 },
      startedAt: 0,
      now: () => 0,
    });
    m.addUsage({ outputTokens: 500 });
    expect(m.capBreachReason()).toBe("tokens");
    const h = host([]);
    const clearance = vi.spyOn(h, "budgetClearance");
    await new BudgetGate(m, h).clear();
    expect(clearance).not.toHaveBeenCalled(); // the leaf executor's throw handles it
  });
});

describe("the gate's question", () => {
  it("states spend vs. cap and names max_usd, so a responder can decide without the dashboard", () => {
    expect(budgetGatePrompt(25, 25)).toBe(
      "Budget cap reached: this run has spent $25.00 of its $25.00 max_usd cap. " +
        "Approve more spend to continue, or cancel the run.",
    );
  });

  it("offers the presets plus cancel, and allows an open-ended absolute cap", () => {
    expect(budgetGateInputSpec()).toEqual({
      kind: "choice",
      options: ["+$10", "+$25", "+$100", "cancel"],
      other: true,
    });
  });
});
