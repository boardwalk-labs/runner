import { describe, it, expect, vi, afterEach } from "vitest";
import { RuntimeFlusher } from "./runtime_flusher.js";

/** A flusher over a hand-advanced clock, capturing every booked delta. `intervalMs` defaults small. */
function setup(
  opts: {
    startedAtMs?: number;
    report?: (s: number, id: string) => Promise<void>;
    vcpus?: number;
  } = {},
) {
  const startedAtMs = opts.startedAtMs ?? 1_000;
  let clock = startedAtMs;
  const reports: { seconds: number; id: string }[] = [];
  const report =
    opts.report ??
    ((seconds: number, id: string): Promise<void> => {
      reports.push({ seconds, id });
      return Promise.resolve();
    });
  const flusher = new RuntimeFlusher({
    runId: "run_1",
    sessionId: "s1",
    startedAtMs,
    ...(opts.vcpus !== undefined ? { vcpus: opts.vcpus } : {}),
    now: () => clock,
    report,
    intervalMs: 1_000,
  });
  return { flusher, reports, advance: (ms: number) => (clock += ms) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RuntimeFlusher — delta accounting", () => {
  it("books each flush as the delta since the last, with incrementing per-flush ids", async () => {
    const { flusher, reports, advance } = setup();
    advance(2_000);
    await flusher.flushFinal(); // total 2s, delta 2, seq 0
    advance(3_000);
    await flusher.flushFinal(); // total 5s, delta 3, seq 1
    expect(reports).toEqual([
      { seconds: 2, id: "run_1:s1:rt:0" },
      { seconds: 3, id: "run_1:s1:rt:1" },
    ]);
  });

  it("scales each delta by vCPUs — runtime is billed per vCPU-second", async () => {
    // A 4-vCPU task that holds for 10s consumes 40 vCPU-seconds of compute, so it must book 40 (not 10).
    const { flusher, reports, advance } = setup({ vcpus: 4 });
    advance(10_000);
    await flusher.flushFinal(); // 10s wall-clock × 4 vCPU = 40 vCPU-seconds
    advance(5_000);
    await flusher.flushFinal(); // +5s × 4 = +20
    expect(reports).toEqual([
      { seconds: 40, id: "run_1:s1:rt:0" },
      { seconds: 20, id: "run_1:s1:rt:1" },
    ]);
  });

  it("defaults to 1 vCPU (vCPU-seconds == wall-clock) when vcpus is omitted", async () => {
    const { flusher, reports, advance } = setup();
    advance(7_000);
    await flusher.flushFinal();
    expect(reports).toEqual([{ seconds: 7, id: "run_1:s1:rt:0" }]);
  });

  it("skips a flush when less than a whole second has accrued (rounded)", async () => {
    const { flusher, reports, advance } = setup();
    advance(300); // round(0.3s) = 0 → nothing to book
    await flusher.flushFinal();
    expect(reports).toEqual([]);
  });

  it("on a report failure, retries the SAME id with the grown delta (no double-bill, no advance)", async () => {
    const report = vi
      .fn<(s: number, id: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("broker down"))
      .mockResolvedValue(undefined);
    const { flusher, advance } = setup({ report });
    advance(2_000);
    await flusher.flushFinal(); // total 2, delta 2, id rt:0 → fails; cursor + seq NOT advanced
    advance(1_000);
    await flusher.flushFinal(); // total 3, delta 3 (from 0), id STILL rt:0 → succeeds
    expect(report.mock.calls).toEqual([
      [2, "run_1:s1:rt:0"],
      [3, "run_1:s1:rt:0"],
    ]);
  });
});

describe("RuntimeFlusher — periodic timer", () => {
  it("flushes on the interval", async () => {
    vi.useFakeTimers();
    let clock = 0;
    const reports: { seconds: number; id: string }[] = [];
    const flusher = new RuntimeFlusher({
      runId: "run_1",
      sessionId: "s1",
      startedAtMs: 0,
      now: () => clock,
      report: (seconds, id) => {
        reports.push({ seconds, id });
        return Promise.resolve();
      },
      intervalMs: 1_000,
    });
    flusher.start();
    clock = 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reports).toEqual([{ seconds: 1, id: "run_1:s1:rt:0" }]);
    await flusher.stop();
  });

  it("stops flushing on the timer once stopped (but flushFinal still books the tail)", async () => {
    vi.useFakeTimers();
    let clock = 0;
    const reports: { seconds: number; id: string }[] = [];
    const flusher = new RuntimeFlusher({
      runId: "run_1",
      sessionId: "s1",
      startedAtMs: 0,
      now: () => clock,
      report: (seconds, id) => {
        reports.push({ seconds, id });
        return Promise.resolve();
      },
      intervalMs: 1_000,
    });
    flusher.start();
    await flusher.stop(); // halt the timer
    clock = 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reports).toEqual([]); // timer is dead — no periodic flush after stop
    await flusher.flushFinal(); // …but the terminal tail still books
    expect(reports).toEqual([{ seconds: 5, id: "run_1:s1:rt:0" }]);
  });

  it("stop() is idempotent", async () => {
    const { flusher } = setup();
    await flusher.stop();
    await expect(flusher.stop()).resolves.toBeUndefined();
  });
});
