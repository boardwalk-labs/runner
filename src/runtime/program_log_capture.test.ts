import { describe, it, expect, vi } from "vitest";
import { captureConsole, createProgramLogSink } from "./program_log_capture.js";
import type { TurnEventSink, RunEvent, RunEventBody } from "./agent/events.js";

describe("captureConsole", () => {
  it("forwards to the original console AND hands the formatted line to the sink, then restores", () => {
    const sink = vi.fn();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const restore = captureConsole(sink);
    console.log("hello %s", "world");
    console.error("boom", 42);
    restore();

    // Assert BEFORE mockRestore (which clears the spies' recorded calls).
    expect(logSpy).toHaveBeenCalledWith("hello %s", "world"); // forwarded to original (→ CloudWatch)
    expect(sink).toHaveBeenNthCalledWith(1, "stdout", "hello world"); // util.format applied
    expect(sink).toHaveBeenNthCalledWith(2, "stderr", "boom 42"); // error → stderr stream
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("a throwing sink never breaks the program's own logging", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const restore = captureConsole(() => {
      throw new Error("telemetry down");
    });
    expect(() => {
      console.log("ok");
    }).not.toThrow();
    restore();
    spy.mockRestore();
  });
});

function fakeSink(): TurnEventSink & { bodies: RunEventBody[] } {
  const bodies: RunEventBody[] = [];
  return {
    bodies,
    emit: (body) => {
      bodies.push(body);
      return body as RunEvent; // envelope stamping is the emitter's concern, not this sink's
    },
    beginTurn: () => undefined,
  };
}

describe("createProgramLogSink", () => {
  it("emits one program_output body per line on the shared emitter", () => {
    const sink = fakeSink();
    const emit = createProgramLogSink({ sink });
    emit("stdout", "line one");
    emit("stderr", "line two");
    expect(sink.bodies).toEqual([
      { kind: "program_output", stream: "stdout", text: "line one" },
      { kind: "program_output", stream: "stderr", text: "line two" },
    ]);
  });

  it("truncates an over-long line", () => {
    const sink = fakeSink();
    const emit = createProgramLogSink({ sink, maxLineLength: 5 });
    emit("stdout", "abcdefghij");
    expect((sink.bodies[0] as { text: string }).text).toBe("abcde… (truncated)");
  });

  it("caps total frames and emits exactly one truncation notice (as stderr program_output)", () => {
    const sink = fakeSink();
    const emit = createProgramLogSink({ sink, maxFrames: 2 });
    emit("stdout", "a");
    emit("stdout", "b");
    emit("stdout", "c");
    emit("stdout", "d");
    expect(sink.bodies).toHaveLength(3); // 2 lines + 1 notice
    expect(sink.bodies[2]).toMatchObject({ stream: "stderr" });
    expect((sink.bodies[2] as { text: string }).text).toContain("truncated");
  });
});
