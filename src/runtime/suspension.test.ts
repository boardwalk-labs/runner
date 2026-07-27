import { describe, it, expect } from "vitest";
import { suspendedEventBody, SuspensionCounter, type SuspendSignal } from "./suspension.js";

const sleep = (wakeAtMs?: number): SuspendSignal => ({
  reason: "sleep",
  seq: 1,
  ...(wakeAtMs !== undefined ? { wakeAtMs } : {}),
});

const gate = (expiresAt?: number): SuspendSignal => ({
  reason: "human_input",
  seq: 2,
  humanInput: {
    key: "approve",
    prompt: "ship it?",
    inputSpec: {},
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  },
});

describe("suspendedEventBody", () => {
  it("describes a sleep with its absolute deadline", () => {
    expect(suspendedEventBody([sleep(1_770_000_100_000)])).toEqual({
      kind: "suspended",
      reason: "sleep",
      wakeAt: 1_770_000_100_000,
    });
  });

  it("omits wakeAt for a gate that waits indefinitely", () => {
    expect(suspendedEventBody([gate()])).toEqual({ kind: "suspended", reason: "human_input" });
  });

  it("carries a gate's timeout as the wake time", () => {
    expect(suspendedEventBody([gate(1_770_000_500_000)])).toMatchObject({
      reason: "human_input",
      wakeAt: 1_770_000_500_000,
    });
  });

  it("takes its reason from the primary (first) wait", () => {
    // The coordinator hands the set primary-first; a composed park reads as what it's really
    // waiting on, matching the run's single-valued status.
    expect(suspendedEventBody([gate(), sleep(1_000)])).toMatchObject({ reason: "human_input" });
  });

  it("counts down to the EARLIEST deadline in a composed park, not the primary's", () => {
    // The gate is primary, but the sleep is when the run actually wakes — which is what a reader
    // counting down needs.
    expect(suspendedEventBody([gate(9_000), sleep(3_000)])).toMatchObject({
      reason: "human_input",
      wakeAt: 3_000,
    });
  });

  it("maps a workflow_call park onto the wire's `child`", () => {
    expect(suspendedEventBody([{ reason: "workflow_call", seq: 3, childRunId: "run_x" }])).toEqual({
      kind: "suspended",
      reason: "child",
    });
  });

  it("maps a budget park onto human_input — a person raising the cap is what it waits for", () => {
    // The wire enum is closed: a fourth value would make a strict consumer drop the frame whole.
    expect(suspendedEventBody([{ reason: "budget", seq: 4 }])).toEqual({
      kind: "suspended",
      reason: "human_input",
    });
  });
});

describe("SuspensionCounter", () => {
  it("hands out 1-based, monotonic seqs", () => {
    const c = new SuspensionCounter();
    expect([c.next(), c.next(), c.next()]).toEqual([1, 2, 3]);
  });
});
