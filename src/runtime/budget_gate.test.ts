// SPDX-License-Identifier: MIT

import { describe, it, expect, vi } from "vitest";
import {
  BudgetGate,
  BudgetGateCancelled,
  ComputeBreachWatcher,
  budgetGatePrompt,
  budgetGateInputSpec,
  resolveBudgetAnswer,
  type BudgetClearancePort,
} from "./budget_gate.js";
import { BudgetMeter } from "./agent/budget.js";
import type { Budget } from "./wire/manifest.js";
import type { HumanInputResult } from "@boardwalk-labs/workflow";

/** A meter priced so 1M output tokens = $10 exactly (easy arithmetic below), with an injectable
 *  clock for the compute dimension. */
function meter(budget?: Budget, clock?: { now: number }): BudgetMeter {
  return new BudgetMeter({
    ...(budget === undefined ? {} : { budget }),
    rate: { inputPerMillion: 0, outputPerMillion: 10 },
    startedAt: 0,
    now: () => clock?.now ?? 0,
  });
}

/** Spend `usd` on the meter via a real usage delta (not a private poke). */
function spend(m: BudgetMeter, usd: number): void {
  m.addUsage({ outputTokens: 0 }, usd);
}

/** A host that answers every gate with `answers` in order, recording the gates it was asked. */
function host(
  answers: string[],
  onPark?: () => void,
): BudgetClearancePort & { prompts: string[]; specs: unknown[] } {
  const prompts: string[] = [];
  const specs: unknown[] = [];
  let i = 0;
  return {
    prompts,
    specs,
    budgetClearance: (gate: { prompt: string; inputSpec: unknown }): Promise<HumanInputResult> => {
      prompts.push(gate.prompt);
      specs.push(gate.inputSpec);
      onPark?.();
      const answer = answers[i++] ?? "cancel";
      return Promise.resolve({ value: answer } as unknown as HumanInputResult);
    },
  };
}

describe("resolveBudgetAnswer — usd", () => {
  it("reads a +$N preset as an INCREMENT on the current cap", () => {
    expect(resolveBudgetAnswer("usd", "+$25", 25)).toBe(50);
    expect(resolveBudgetAnswer("usd", "+$10", 25)).toBe(35);
    expect(resolveBudgetAnswer("usd", "+100", 25)).toBe(125);
  });

  it("reads a bare number as an ABSOLUTE new cap", () => {
    expect(resolveBudgetAnswer("usd", "80", 25)).toBe(80);
    expect(resolveBudgetAnswer("usd", "$80", 25)).toBe(80);
    expect(resolveBudgetAnswer("usd", "12.50", 10)).toBe(12.5);
  });

  it("cancels on an absolute cap that wouldn't raise anything (it would re-park instantly)", () => {
    expect(resolveBudgetAnswer("usd", "25", 25)).toBeNull();
    expect(resolveBudgetAnswer("usd", "10", 25)).toBeNull();
  });

  it("cancels on an explicit cancel, a blank, or anything it can't read", () => {
    expect(resolveBudgetAnswer("usd", "cancel", 25)).toBeNull();
    expect(resolveBudgetAnswer("usd", "CANCEL", 25)).toBeNull();
    expect(resolveBudgetAnswer("usd", "", 25)).toBeNull();
    expect(resolveBudgetAnswer("usd", "   ", 25)).toBeNull();
    // Never guess at a misread answer — resuming spends real money.
    expect(resolveBudgetAnswer("usd", "yes please", 25)).toBeNull();
    expect(resolveBudgetAnswer("usd", "a lot more", 25)).toBeNull();
  });
});

describe("resolveBudgetAnswer — tokens", () => {
  it("reads the k/M presets as INCREMENTS on the current cap", () => {
    expect(resolveBudgetAnswer("tokens", "+100k", 1_000_000)).toBe(1_100_000);
    expect(resolveBudgetAnswer("tokens", "+1M", 1_000_000)).toBe(2_000_000);
    expect(resolveBudgetAnswer("tokens", "+10M", 500_000)).toBe(10_500_000);
    expect(resolveBudgetAnswer("tokens", "+2.5m", 0)).toBe(2_500_000);
    expect(resolveBudgetAnswer("tokens", "+250000", 100)).toBe(250_100);
  });

  it("reads a bare amount (with optional k/M suffix) as an ABSOLUTE new cap", () => {
    expect(resolveBudgetAnswer("tokens", "5M", 1_000_000)).toBe(5_000_000);
    expect(resolveBudgetAnswer("tokens", "750k", 100_000)).toBe(750_000);
    expect(resolveBudgetAnswer("tokens", "2000000", 1_000_000)).toBe(2_000_000);
  });

  it("cancels on cancel / blank / unreadable / a non-raising absolute", () => {
    expect(resolveBudgetAnswer("tokens", "cancel", 100)).toBeNull();
    expect(resolveBudgetAnswer("tokens", "", 100)).toBeNull();
    expect(resolveBudgetAnswer("tokens", "$5", 100)).toBeNull(); // dollars are not tokens
    expect(resolveBudgetAnswer("tokens", "100", 100)).toBeNull(); // absolute == cap: re-park
    expect(resolveBudgetAnswer("tokens", "50", 100)).toBeNull();
  });
});

describe("resolveBudgetAnswer — compute", () => {
  it("reads the min/h presets as INCREMENTS on the current cap (in seconds)", () => {
    expect(resolveBudgetAnswer("compute", "+15min", 3600)).toBe(3600 + 900);
    expect(resolveBudgetAnswer("compute", "+1h", 3600)).toBe(7200);
    expect(resolveBudgetAnswer("compute", "+4h", 0)).toBe(14_400);
    expect(resolveBudgetAnswer("compute", "+90s", 10)).toBe(100);
    expect(resolveBudgetAnswer("compute", "+600", 100)).toBe(700); // bare number = seconds
    expect(resolveBudgetAnswer("compute", "+1.5h", 0)).toBe(5400);
  });

  it("reads a bare duration as an ABSOLUTE new cap (in seconds)", () => {
    expect(resolveBudgetAnswer("compute", "2h", 3600)).toBe(7200);
    expect(resolveBudgetAnswer("compute", "90min", 3600)).toBe(5400);
    expect(resolveBudgetAnswer("compute", "5400", 3600)).toBe(5400);
  });

  it("cancels on cancel / blank / unreadable / a non-raising absolute", () => {
    expect(resolveBudgetAnswer("compute", "cancel", 100)).toBeNull();
    expect(resolveBudgetAnswer("compute", "", 100)).toBeNull();
    expect(resolveBudgetAnswer("compute", "later", 100)).toBeNull();
    expect(resolveBudgetAnswer("compute", "100", 100)).toBeNull(); // absolute == cap: re-park
    expect(resolveBudgetAnswer("compute", "1min", 3600)).toBeNull();
  });
});

describe("BudgetMeter.raiseCap", () => {
  it("raises the breached dimension's cap and clears the breach", () => {
    const m = meter({ max_usd: 10 });
    spend(m, 12);
    expect(m.capBreachReason()).toBe("usd");
    expect(m.raiseCap("usd", 25)).toBe(25);
    expect(m.capBreachReason()).toBeNull();
    expect(m.cap("usd")).toBe(25);
  });

  it("raises tokens and compute caps too", () => {
    const clock = { now: 0 };
    const m = meter({ max_tokens: 100, max_compute_seconds: 60 }, clock);
    m.addUsage({ outputTokens: 500 });
    expect(m.capBreachReason()).toBe("tokens");
    expect(m.raiseCap("tokens", 1_000)).toBe(1_000);
    expect(m.capBreachReason()).toBeNull();
    clock.now = 120_000; // 120s elapsed > 60s cap
    expect(m.capBreachReason()).toBe("compute");
    expect(m.raiseCap("compute", 300)).toBe(300);
    expect(m.capBreachReason()).toBeNull();
  });

  it("only ever RAISES — a lower value is ignored, so an approval can't tighten the cap", () => {
    const m = meter({ max_usd: 25 });
    expect(m.raiseCap("usd", 10)).toBe(25);
    expect(m.cap("usd")).toBe(25);
  });

  it("is a no-op with no declared budget", () => {
    const m = meter();
    expect(m.raiseCap("usd", 50)).toBeNull();
    expect(m.cap("usd")).toBeNull();
  });
});

describe("BudgetMeter.excludeIdle", () => {
  it("excludes parked wall-clock from the compute dimension only", () => {
    const clock = { now: 100_000 };
    const m = meter({ max_compute_seconds: 60 }, clock);
    expect(m.spent("compute")).toBe(100);
    m.excludeIdle(40_000);
    expect(m.spent("compute")).toBe(60);
    expect(m.capBreachReason()).toBeNull();
  });

  it("never lets elapsed go negative", () => {
    const clock = { now: 5_000 };
    const m = meter(undefined, clock);
    m.excludeIdle(60_000);
    expect(m.spent("compute")).toBe(0);
  });
});

describe("BudgetGate.clear", () => {
  it("resolves immediately, without parking, when no cap is breached (the hot path)", async () => {
    const m = meter({ max_usd: 10 });
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

  it("parks on a usd breach, raises the cap from the answer, and lets the call proceed", async () => {
    const m = meter({ max_usd: 10 });
    spend(m, 12);
    const h = host(["+$25"]);
    await new BudgetGate(m, h).clear();
    expect(m.cap("usd")).toBe(35); // 10 + 25
    expect(m.capBreachReason()).toBeNull();
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain("$12.00");
    expect(h.prompts[0]).toContain("$10.00");
  });

  it("parks on a TOKENS breach, raises the cap from a preset, and resumes", async () => {
    const m = meter({ max_tokens: 100_000 });
    m.addUsage({ inputTokens: 90_000, outputTokens: 20_000 });
    expect(m.capBreachReason()).toBe("tokens");
    const h = host(["+1M"]);
    await new BudgetGate(m, h).clear();
    expect(m.cap("tokens")).toBe(1_100_000);
    expect(m.capBreachReason()).toBeNull();
    expect(h.prompts[0]).toContain("110,000 tokens");
    expect(h.prompts[0]).toContain("100,000-token");
    expect(h.specs[0]).toEqual({
      kind: "choice",
      options: ["+100k", "+1M", "+10M", "cancel"],
      other: true,
    });
  });

  it("parks on a COMPUTE breach and EXCLUDES the parked wall-clock from the compute cap", async () => {
    const clock = { now: 4_000_000 }; // 4000s elapsed > 3600s cap
    const m = meter({ max_compute_seconds: 3600 }, clock);
    // The park spans an hour of wall-clock (a human answered eventually) — advance the clock inside
    // the host answer, the way a freeze wake or a held poll would observe it.
    const h = host(["+15min"], () => {
      clock.now += 3_600_000;
    });
    await new BudgetGate(m, h, () => clock.now).clear();
    expect(m.cap("compute")).toBe(3600 + 900);
    // Parked time burned no compute: spend is still the pre-park 4000s, under the raised 4500s cap.
    expect(m.spent("compute")).toBe(4000);
    expect(m.capBreachReason()).toBeNull();
    expect(h.prompts[0]).toContain("1h 6m"); // 4000s spent
    expect(h.prompts[0]).toContain("1h"); // 3600s cap
    expect(h.prompts[0]).toContain("max_compute_seconds");
  });

  it("asks AGAIN when the approval was too small to clear the breach (never resume into a re-park)", async () => {
    const m = meter({ max_usd: 10 });
    spend(m, 30);
    // +$5 → cap 15, still under the $30 spent ⇒ ask again; +$25 → cap 40 ⇒ cleared.
    const h = host(["+$5", "+$25"]);
    await new BudgetGate(m, h).clear();
    expect(h.prompts).toHaveLength(2);
    expect(m.cap("usd")).toBe(40);
    expect(m.capBreachReason()).toBeNull();
  });

  it("clears MULTIPLE breached dimensions in sequence, one gate each", async () => {
    const m = meter({ max_tokens: 100, max_usd: 10 });
    m.addUsage({ outputTokens: 500 }, 12); // breaches tokens (500 > 100) AND usd ($12 > $10)
    const h = host(["+10M", "+$100"]);
    await new BudgetGate(m, h).clear();
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[0]).toContain("max_tokens");
    expect(h.prompts[1]).toContain("max_usd");
    expect(m.capBreachReason()).toBeNull();
  });

  it("throws BudgetGateCancelled when the responder declines", async () => {
    const m = meter({ max_usd: 10 });
    spend(m, 12);
    await expect(new BudgetGate(m, host(["cancel"])).clear()).rejects.toThrow(BudgetGateCancelled);
  });

  it("throws BudgetGateCancelled on a declined tokens or compute gate too", async () => {
    const tokensMeter = meter({ max_tokens: 10 });
    tokensMeter.addUsage({ outputTokens: 50 });
    await expect(new BudgetGate(tokensMeter, host(["cancel"])).clear()).rejects.toThrow(
      BudgetGateCancelled,
    );
    const clock = { now: 120_000 };
    const computeMeter = meter({ max_compute_seconds: 60 }, clock);
    await expect(
      new BudgetGate(computeMeter, host(["nonsense answer"]), () => clock.now).clear(),
    ).rejects.toThrow(BudgetGateCancelled);
  });

  it("keeps usage.get() consistent across a park: spend stays accrued, the cap shows the raise", async () => {
    const m = meter({ max_usd: 10 });
    spend(m, 12);
    const h = host(["+$25"]);
    await new BudgetGate(m, h).clear();
    const snap = m.usageSnapshot();
    expect(snap.usd.spent).toBeCloseTo(12, 6); // spend survives the park
    expect(snap.usd.cap).toBe(35); // the approval raised the live cap
    expect(snap.usd.remaining).toBeCloseTo(23, 6);
  });
});

describe("the gate's question", () => {
  it("states spend vs. cap and names the manifest field, per dimension", () => {
    expect(budgetGatePrompt("usd", 25, 25)).toBe(
      "Budget cap reached: this run has spent $25.00 of its $25.00 max_usd cap. " +
        "Approve more spend to continue, or cancel the run.",
    );
    expect(budgetGatePrompt("tokens", 1_200_000, 1_000_000)).toBe(
      "Budget cap reached: this run has used 1,200,000 tokens of its 1,000,000-token " +
        "max_tokens cap. Approve more tokens to continue, or cancel the run.",
    );
    expect(budgetGatePrompt("compute", 4500, 3600)).toBe(
      "Budget cap reached: this run has used 1h 15m of its 1h " +
        "max_compute_seconds cap. Approve more compute time to continue, or cancel the run.",
    );
  });

  it("offers dimension-native presets plus cancel, and allows an open-ended absolute value", () => {
    expect(budgetGateInputSpec("usd")).toEqual({
      kind: "choice",
      options: ["+$10", "+$25", "+$100", "cancel"],
      other: true,
    });
    expect(budgetGateInputSpec("tokens")).toEqual({
      kind: "choice",
      options: ["+100k", "+1M", "+10M", "cancel"],
      other: true,
    });
    expect(budgetGateInputSpec("compute")).toEqual({
      kind: "choice",
      options: ["+15min", "+1h", "+4h", "cancel"],
      other: true,
    });
  });
});

describe("ComputeBreachWatcher", () => {
  it("detects a compute breach between seams, and re-arms once an approval clears it", () => {
    const clock = { now: 0 };
    const m = meter({ max_compute_seconds: 60 }, clock);
    const w = new ComputeBreachWatcher(m, { runId: "run_1" });
    w.sample();
    expect(w.breachDetected).toBe(false);
    clock.now = 120_000; // 120s > 60s cap
    w.sample();
    expect(w.breachDetected).toBe(true);
    m.raiseCap("compute", 300); // a gate approval raised the cap
    w.sample();
    expect(w.breachDetected).toBe(false); // re-armed for a breach of the NEW cap
    clock.now = 400_000; // 400s > 300s cap
    w.sample();
    expect(w.breachDetected).toBe(true);
  });

  it("never flags an uncapped run", () => {
    const clock = { now: 10_000_000 };
    const m = meter(undefined, clock);
    const w = new ComputeBreachWatcher(m, { runId: "run_1" });
    w.sample();
    expect(w.breachDetected).toBe(false);
  });

  it("start()/stop() manage the interval without keeping the process alive", () => {
    const m = meter({ max_compute_seconds: 60 });
    const w = new ComputeBreachWatcher(m, { runId: "run_1", intervalMs: 5 });
    w.start();
    w.start(); // idempotent
    w.stop();
    w.stop(); // idempotent
  });
});
