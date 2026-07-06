import { describe, it, expect } from "vitest";
import { AppError } from "./support/index.js";
import type { TurnEventSink, RunEvent, RunEventBody } from "./agent/events.js";
import { PhaseTracker } from "./phase_tracker.js";

function fakeSink(): TurnEventSink & { bodies: RunEventBody[] } {
  const bodies: RunEventBody[] = [];
  return {
    bodies,
    emit: (body) => {
      bodies.push(body);
      return body as RunEvent; // envelope irrelevant to the tracker
    },
    beginTurn: () => undefined,
  };
}

describe("PhaseTracker", () => {
  it("emits a phase MARKER per set(); close() emits nothing (v1 has no phase_ended)", () => {
    const sink = fakeSink();
    const tracker = new PhaseTracker({ sink });

    tracker.set("Install dependencies", undefined);
    tracker.set("Analyze failures", { id: "analyze" });
    tracker.close("failed");

    expect(sink.bodies).toEqual([
      { kind: "phase", name: "Install dependencies", id: "phase-1" },
      { kind: "phase", name: "Analyze failures", id: "analyze" },
    ]);
  });

  it("capture() reflects the current phase and clears on close", () => {
    const sink = fakeSink();
    const tracker = new PhaseTracker({ sink });
    expect(tracker.capture()).toBeNull();
    tracker.set("Build", { id: "build" });
    expect(tracker.capture()).toBe("build");
    tracker.close("completed");
    expect(tracker.capture()).toBeNull();
  });

  it("capture() snapshots a phase id even after the current phase changes", () => {
    const sink = fakeSink();
    const tracker = new PhaseTracker({ sink });
    tracker.set("First", { id: "first" });
    const captured = tracker.capture();
    tracker.set("Second", { id: "second" });
    expect(captured).toBe("first");
    expect(tracker.capture()).toBe("second");
  });

  it("runInPhase runs the callback to completion", async () => {
    const tracker = new PhaseTracker({ sink: fakeSink() });
    tracker.set("First", { id: "first" });
    const out = await tracker.runInPhase(tracker.capture(), () => Promise.resolve(42));
    expect(out).toBe(42);
  });

  it("rejects empty names and duplicate ids", () => {
    const tracker = new PhaseTracker({ sink: fakeSink() });
    expect(() => {
      tracker.set("  ", undefined);
    }).toThrow(AppError);
    tracker.set("One", { id: "same" });
    expect(() => {
      tracker.set("Two", { id: "same" });
    }).toThrow(AppError);
  });

  it("generated ids keep counting past explicit ids (phase-1, custom, phase-3)", () => {
    const sink = fakeSink();
    const tracker = new PhaseTracker({ sink });
    tracker.set("A", undefined);
    tracker.set("B", { id: "custom" });
    tracker.set("C", undefined);
    expect(sink.bodies.map((b) => (b as { id: string }).id)).toEqual([
      "phase-1",
      "custom",
      "phase-3",
    ]);
  });
});
