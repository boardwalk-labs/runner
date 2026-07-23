import { describe, it, expect } from "vitest";
import { BudgetMeter, type BudgetMeterOptions, type ModelRate } from "./budget.js";
import { AppError, ErrorCode } from "../support/index.js";

const NOW = 1_700_000_000_000;

const RATE: ModelRate = {
  inputPerMillion: 3, // $3 / 1M input tokens
  outputPerMillion: 15, // $15 / 1M output tokens
};

function meter(opts: Partial<BudgetMeterOptions> = {}) {
  return new BudgetMeter({
    rate: RATE,
    startedAt: NOW,
    now: () => NOW,
    ...opts,
  });
}

describe("BudgetMeter.costFor", () => {
  it("computes input + output cost per million", () => {
    const m = meter();
    // 1M input + 1M output → $3 + $15 = $18
    expect(m.costFor({ inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(18, 6);
  });

  it("derives default cache rates from input rate", () => {
    const m = meter();
    // 1M cache-read → input/10 = $0.30; 1M cache-write → input*1.25 = $3.75
    expect(m.costFor({ cacheReadTokens: 1_000_000 })).toBeCloseTo(0.3, 6);
    expect(m.costFor({ cacheWriteTokens: 1_000_000 })).toBeCloseTo(3.75, 6);
  });

  it("honors explicit cache rates when supplied", () => {
    const m = new BudgetMeter({
      rate: { ...RATE, cacheReadPerMillion: 1, cacheWritePerMillion: 5 },
      startedAt: NOW,
      now: () => NOW,
    });
    expect(m.costFor({ cacheReadTokens: 1_000_000 })).toBe(1);
    expect(m.costFor({ cacheWriteTokens: 1_000_000 })).toBe(5);
  });
});

describe("BudgetMeter.addUsage + snapshot", () => {
  it("accumulates across deltas", () => {
    const m = meter();
    m.addUsage({ inputTokens: 100, outputTokens: 50 });
    m.addUsage({ inputTokens: 200, outputTokens: 80 });
    const snap = m.snapshot();
    expect(snap.inputTokens).toBe(300);
    expect(snap.outputTokens).toBe(130);
    expect(snap.totalTokens).toBe(430);
    expect(snap.totalUsd).toBeCloseTo((300 * 3 + 130 * 15) / 1_000_000, 8);
  });

  it("snapshot.elapsedMs reflects clock movement", () => {
    let t = NOW;
    const m = new BudgetMeter({ rate: RATE, startedAt: NOW, now: () => t });
    t = NOW + 5_000;
    expect(m.snapshot().elapsedMs).toBe(5_000);
  });

  it("uses the real upstream cost when supplied, not the representative-rate estimate", () => {
    const m = meter();
    // 1M input would ESTIMATE at $3 (1M × $3/M), but the broker's real cache-discounted cost is $0.20.
    m.addUsage({ inputTokens: 1_000_000 }, 0.2);
    const snap = m.snapshot();
    expect(snap.totalUsd).toBeCloseTo(0.2, 8);
    expect(snap.inputTokens).toBe(1_000_000); // tokens still accumulate (max_tokens cap + display)
  });

  it("falls back to the representative-rate estimate when no real cost is supplied", () => {
    const m = meter();
    m.addUsage({ inputTokens: 1_000_000 });
    expect(m.snapshot().totalUsd).toBeCloseTo(3, 8);
  });
});

describe("BudgetMeter.assertWithinCaps", () => {
  it("no-op when budget is absent", () => {
    const m = meter();
    m.addUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(() => {
      m.assertWithinCaps();
    }).not.toThrow();
  });

  it("throws when token cap is exceeded", () => {
    const m = meter({ budget: { max_tokens: 100 } });
    m.addUsage({ inputTokens: 60, outputTokens: 50 });
    expect(() => {
      m.assertWithinCaps();
    }).toThrow(AppError);
    try {
      m.assertWithinCaps();
    } catch (err) {
      expect((err as AppError).code).toBe(ErrorCode.BUDGET_EXCEEDED);
      expect((err as AppError).detail).toMatchObject({ kind: "tokens", used: 110, cap: 100 });
    }
  });

  it("throws when USD cap is exceeded", () => {
    const m = meter({ budget: { max_usd: 0.01 } });
    // 10000 output tokens at $15/M = $0.15
    m.addUsage({ outputTokens: 10_000 });
    expect(() => {
      m.assertWithinCaps();
    }).toThrow(AppError);
    try {
      m.assertWithinCaps();
    } catch (err) {
      expect((err as AppError).detail).toMatchObject({ kind: "usd" });
    }
  });

  it("throws when the compute cap is exceeded (seconds-resolution)", () => {
    let t = NOW;
    const m = new BudgetMeter({
      rate: RATE,
      budget: { max_compute_seconds: 5 },
      startedAt: NOW,
      now: () => t,
    });
    t = NOW + 6_000;
    expect(() => {
      m.assertWithinCaps();
    }).toThrow(/Compute cap exceeded/);
  });

  it("does NOT throw at the boundary (eq, not gt)", () => {
    const m = meter({ budget: { max_tokens: 100 } });
    m.addUsage({ inputTokens: 100 });
    expect(() => {
      m.assertWithinCaps();
    }).not.toThrow();
  });
});

describe("BudgetMeter — cumulative usage across resume sessions", () => {
  const priorUsage = {
    inputTokens: 80,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalUsd: 0,
    activeMs: 0,
  };

  it("snapshot() stays session-local (so the UsageFlusher never re-reports prior tokens)", () => {
    const m = meter({ priorUsage });
    m.addUsage({ inputTokens: 30 });
    // Session-local: prior 80 tokens are NOT included — the flusher reports per-session deltas.
    expect(m.snapshot().inputTokens).toBe(30);
  });

  it("cumulative() adds prior-session usage to this session's", () => {
    const m = meter({ priorUsage });
    m.addUsage({ inputTokens: 30, outputTokens: 5 });
    const c = m.cumulative();
    expect(c.inputTokens).toBe(110);
    expect(c.outputTokens).toBe(5);
    expect(c.totalTokens).toBe(115);
  });

  it("trips the token cap on CUMULATIVE usage even when this session alone is under it", () => {
    // max_tokens 100; prior sessions burned 80; this session's 30 is under 100 on its own but
    // 110 cumulatively — without the fix the run would get a fresh 100-token budget every resume.
    const m = meter({ budget: { max_tokens: 100 }, priorUsage });
    m.addUsage({ inputTokens: 30 });
    expect(() => {
      m.assertWithinCaps();
    }).toThrow(AppError);
    try {
      m.assertWithinCaps();
    } catch (err) {
      expect((err as AppError).detail).toMatchObject({ kind: "tokens", used: 110, cap: 100 });
    }
  });

  it("does NOT trip when cumulative usage is within the cap", () => {
    const m = meter({ budget: { max_tokens: 100 }, priorUsage });
    m.addUsage({ inputTokens: 10 }); // 80 + 10 = 90 ≤ 100
    expect(() => {
      m.assertWithinCaps();
    }).not.toThrow();
  });

  it("trips the USD cap on cumulative spend", () => {
    const m = meter({
      budget: { max_usd: 0.01 },
      priorUsage: { ...priorUsage, inputTokens: 0, totalUsd: 0.009 },
    });
    m.addUsage({ inputTokens: 1_000 }); // 1000 * $3/M = $0.003 → cumulative $0.012 > $0.01
    expect(() => {
      m.assertWithinCaps();
    }).toThrow(AppError);
  });

  it("trips the compute cap on cumulative ACTIVE time (prior activeMs + this session)", () => {
    let t = NOW;
    const m = new BudgetMeter({
      rate: RATE,
      budget: { max_compute_seconds: 10 },
      startedAt: NOW,
      now: () => t,
      priorUsage: { ...priorUsage, activeMs: 8_000 }, // 8s of prior active time
    });
    t = NOW + 3_000; // +3s this session → 11s cumulative > 10s cap
    expect(() => {
      m.assertWithinCaps();
    }).toThrow(AppError);
    try {
      m.assertWithinCaps();
    } catch (err) {
      expect((err as AppError).detail).toMatchObject({ kind: "compute" });
    }
  });
});

describe("BudgetMeter.capBreachReason", () => {
  it("returns null when within caps", () => {
    const m = meter({ budget: { max_tokens: 100 } });
    expect(m.capBreachReason()).toBeNull();
  });

  it("returns the breach kind when caps are exceeded", () => {
    const m = meter({ budget: { max_tokens: 10 } });
    m.addUsage({ inputTokens: 50 });
    expect(m.capBreachReason()).toBe("tokens");
  });
});

describe("BudgetMeter.usageSnapshot (the usage.get shape)", () => {
  it("reports every dimension with cap/remaining null when uncapped", () => {
    const m = meter();
    m.addUsage({ inputTokens: 100, outputTokens: 50 });
    const snap = m.usageSnapshot();
    expect(snap.tokens).toEqual({ spent: 150, cap: null, remaining: null });
    expect(snap.usd.cap).toBeNull();
    expect(snap.compute_seconds.cap).toBeNull();
  });

  it("reports spent/cap/remaining per capped dimension, run-cumulatively", () => {
    let t = NOW;
    const m = new BudgetMeter({
      rate: RATE,
      budget: { max_tokens: 1_000, max_usd: 1, max_compute_seconds: 60 },
      startedAt: NOW,
      now: () => t,
      priorUsage: {
        inputTokens: 200,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalUsd: 0.25,
        activeMs: 10_000,
      },
    });
    m.addUsage({ inputTokens: 100 }, 0.05);
    t = NOW + 5_000;
    const snap = m.usageSnapshot();
    expect(snap.tokens).toEqual({ spent: 300, cap: 1_000, remaining: 700 });
    expect(snap.usd.spent).toBeCloseTo(0.3, 8);
    expect(snap.usd.cap).toBe(1);
    expect(snap.usd.remaining).toBeCloseTo(0.7, 8);
    expect(snap.compute_seconds).toEqual({ spent: 15, cap: 60, remaining: 45 });
  });

  it("clamps remaining at 0 once a dimension is over its cap", () => {
    const m = meter({ budget: { max_tokens: 100 } });
    m.addUsage({ inputTokens: 150 });
    expect(m.usageSnapshot().tokens).toEqual({ spent: 150, cap: 100, remaining: 0 });
  });
});
