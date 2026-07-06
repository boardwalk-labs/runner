import { describe, it, expect } from "vitest";
import { vi } from "vitest";
import { LeaseRenewer } from "./lease_renewer.js";

describe("LeaseRenewer", () => {
  it("renews on a timer while the lease is held, and never fires onLost", async () => {
    vi.useFakeTimers();
    try {
      let renews = 0;
      let lost = 0;
      const r = new LeaseRenewer({
        runId: "run_1",
        renew: () => {
          renews += 1;
          return Promise.resolve(true);
        },
        onLost: () => (lost += 1),
        intervalMs: 1000,
      });
      r.start();
      await vi.advanceTimersByTimeAsync(3000);
      expect(renews).toBe(3);
      expect(lost).toBe(0);
      expect(r.isLost()).toBe(false);
      await r.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fires onLost exactly once when the lease is first lost, then stops acting", async () => {
    vi.useFakeTimers();
    try {
      let held = true;
      let lost = 0;
      const r = new LeaseRenewer({
        runId: "run_1",
        renew: () => Promise.resolve(held),
        onLost: () => (lost += 1),
        intervalMs: 1000,
      });
      r.start();
      await vi.advanceTimersByTimeAsync(1000); // held → no fire
      expect(lost).toBe(0);
      held = false;
      await vi.advanceTimersByTimeAsync(1000); // lost → fire once
      expect(lost).toBe(1);
      expect(r.isLost()).toBe(true);
      await vi.advanceTimersByTimeAsync(3000); // stays lost → no further fires
      expect(lost).toBe(1);
      await r.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tolerates a transient renew failure (logs, does NOT fire onLost, retries next tick)", async () => {
    vi.useFakeTimers();
    try {
      let mode: "throw" | "lost" = "throw";
      let lost = 0;
      const r = new LeaseRenewer({
        runId: "run_1",
        renew: () =>
          mode === "throw" ? Promise.reject(new Error("broker 503")) : Promise.resolve(false),
        onLost: () => (lost += 1),
        intervalMs: 1000,
      });
      r.start();
      await vi.advanceTimersByTimeAsync(1000); // throws → no fire (a blip must not kill a live run)
      expect(lost).toBe(0);
      mode = "lost";
      await vi.advanceTimersByTimeAsync(1000); // definitive loss → fire
      expect(lost).toBe(1);
      await r.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() halts renewal — no fire after stop even once lost", async () => {
    vi.useFakeTimers();
    try {
      let lost = 0;
      const r = new LeaseRenewer({
        runId: "run_1",
        renew: () => Promise.resolve(false),
        onLost: () => (lost += 1),
        intervalMs: 1000,
      });
      r.start();
      await r.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(lost).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
