import { describe, it, expect, vi } from "vitest";
import { CancelWatcher } from "./cancel_watcher.js";

describe("CancelWatcher", () => {
  it("fires onCancelled exactly once when the run is first seen cancelled", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      let fired = 0;
      const w = new CancelWatcher({
        runId: "run_1",
        isCancelled: () => Promise.resolve(cancelled),
        onCancelled: () => (fired += 1),
        intervalMs: 1000,
      });
      w.start();
      await vi.advanceTimersByTimeAsync(1000); // not cancelled → no fire
      expect(fired).toBe(0);
      cancelled = true;
      await vi.advanceTimersByTimeAsync(1000); // cancelled → fire once
      expect(fired).toBe(1);
      expect(w.wasCancelled()).toBe(true);
      await vi.advanceTimersByTimeAsync(3000); // stays cancelled → no further fires
      expect(fired).toBe(1);
      await w.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tolerates a failing cancel check (logs, does not fire, retries next tick)", async () => {
    vi.useFakeTimers();
    try {
      let mode: "throw" | "cancelled" = "throw";
      let fired = 0;
      const w = new CancelWatcher({
        runId: "run_1",
        isCancelled: () =>
          mode === "throw" ? Promise.reject(new Error("broker 500")) : Promise.resolve(true),
        onCancelled: () => (fired += 1),
        intervalMs: 1000,
      });
      w.start();
      await vi.advanceTimersByTimeAsync(1000); // check throws → no fire
      expect(fired).toBe(0);
      mode = "cancelled";
      await vi.advanceTimersByTimeAsync(1000); // next tick → fire
      expect(fired).toBe(1);
      await w.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() halts checking — no fire after stop even once cancelled", async () => {
    vi.useFakeTimers();
    try {
      let fired = 0;
      const w = new CancelWatcher({
        runId: "run_1",
        isCancelled: () => Promise.resolve(true),
        onCancelled: () => (fired += 1),
        intervalMs: 1000,
      });
      w.start();
      await w.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(fired).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("start() is idempotent (a second call doesn't double the cadence)", async () => {
    vi.useFakeTimers();
    try {
      let checks = 0;
      const w = new CancelWatcher({
        runId: "run_1",
        isCancelled: () => {
          checks += 1;
          return Promise.resolve(false);
        },
        onCancelled: () => undefined,
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
