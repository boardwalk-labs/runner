import { describe, it, expect } from "vitest";
import { formatRunEventLine } from "./run_log_file_sink.js";
import type { RunEvent } from "./agent/events.js";

function ev(body: Record<string, unknown>): RunEvent {
  return { runId: "r", turnId: "t", seq: 1, t: 0, ...body } as unknown as RunEvent;
}

describe("formatRunEventLine", () => {
  it("formats run_status / phase / output", () => {
    expect(formatRunEventLine(ev({ kind: "run_status", status: "running" }))).toContain(
      "● running",
    );
    expect(formatRunEventLine(ev({ kind: "phase", name: "setup" }))).toContain("▸ setup");
    expect(formatRunEventLine(ev({ kind: "output", value: { ok: true } }))).toContain("output");
  });

  it("shows program_output text, skips empty", () => {
    expect(
      formatRunEventLine(ev({ kind: "program_output", stream: "stdout", text: "hello world" })),
    ).toContain("hello world");
    expect(
      formatRunEventLine(ev({ kind: "program_output", stream: "stdout", text: "  \n" })),
    ).toBeNull();
  });

  it("names agent + tool activity", () => {
    expect(
      formatRunEventLine(ev({ kind: "turn_started", agentId: "a1", agentName: "reviewer" })),
    ).toContain("reviewer");
    expect(
      formatRunEventLine(ev({ kind: "tool_call_start", toolCallId: "c", toolName: "shell" })),
    ).toContain("shell");
  });

  it("returns null for buffered/noise kinds", () => {
    expect(formatRunEventLine(ev({ kind: "text_delta", blockId: "b", text: "x" }))).toBeNull();
    expect(
      formatRunEventLine(ev({ kind: "turn_ended", agentId: "a", reason: "complete" })),
    ).toBeNull();
  });
});
