import { describe, it, expect, vi } from "vitest";
import { CreditWatcher } from "./credit_watcher.js";

describe("CreditWatcher", () => {
  it("fires onExhausted exactly once when the org first becomes unfunded", async () => {
    vi.useFakeTimers();
    try {
      let funded = true;
      let exhausted = 0;
      const w = new CreditWatcher({
        runId: "run_1",
        isFunded: () => Promise.resolve(funded),
        onExhausted: () => (exhausted += 1),
        intervalMs: 1000,
      });
      w.start();
      await vi.advanceTimersByTimeAsync(1000); // funded → no fire
      expect(exhausted).toBe(0);
      funded = false;
      await vi.advanceTimersByTimeAsync(1000); // unfunded → fire once
      expect(exhausted).toBe(1);
      expect(w.isExhausted()).toBe(true);
      await vi.advanceTimersByTimeAsync(3000); // stays exhausted → no further fires
      expect(exhausted).toBe(1);
      await w.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tolerates a failing funding check (logs, does not fire, retries next tick)", async () => {
    vi.useFakeTimers();
    try {
      let mode: "throw" | "unfunded" = "throw";
      let exhausted = 0;
      const w = new CreditWatcher({
        runId: "run_1",
        isFunded: () =>
          mode === "throw" ? Promise.reject(new Error("broker 500")) : Promise.resolve(false),
        onExhausted: () => (exhausted += 1),
        intervalMs: 1000,
      });
      w.start();
      await vi.advanceTimersByTimeAsync(1000); // check throws → no fire
      expect(exhausted).toBe(0);
      mode = "unfunded";
      await vi.advanceTimersByTimeAsync(1000); // next tick → fire
      expect(exhausted).toBe(1);
      await w.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() halts checking — no fire after stop even once unfunded", async () => {
    vi.useFakeTimers();
    try {
      let exhausted = 0;
      const w = new CreditWatcher({
        runId: "run_1",
        isFunded: () => Promise.resolve(false),
        onExhausted: () => (exhausted += 1),
        intervalMs: 1000,
      });
      w.start();
      await w.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(exhausted).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("start() is idempotent (a second call doesn't double the cadence)", async () => {
    vi.useFakeTimers();
    try {
      let checks = 0;
      const w = new CreditWatcher({
        runId: "run_1",
        isFunded: () => {
          checks += 1;
          return Promise.resolve(true);
        },
        onExhausted: () => undefined,
        intervalMs: 1000,
      });
      w.start();
      w.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(checks).toBe(1);
      await w.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
