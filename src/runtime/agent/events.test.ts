// The wire contract lives in the SDK — these tests prove the backend re-export wiring and that
// a representative enveloped event of each channel validates against `runEventSchema`.

import { describe, it, expect } from "vitest";
import { runEventSchema, CHANNELS, channelOf, makeCursor, type RunEventBody } from "./events.js";

const ENVELOPE = { runId: "run_1", turnId: "run_1", seq: 1, t: 1000 };

const SAMPLES: RunEventBody[] = [
  { kind: "run_status", status: "running" },
  { kind: "phase", name: "Collect", id: "phase-1" },
  { kind: "output", value: { ok: true } },
  { kind: "program_output", stream: "stdout", text: "hello" },
  { kind: "turn_started", agentId: "agent-1" },
  { kind: "turn_started", agentId: "agent-2", agentName: "reviewer" },
  {
    kind: "turn_ended",
    agentId: "agent-1",
    reason: "complete",
    usage: { inputTokens: 3, outputTokens: 2 },
  },
  { kind: "text_delta", blockId: "b1", text: "hi" },
  { kind: "tool_call_result", toolCallId: "t1", result: { humanSummary: "did it" } },
];

describe("v1 run-event re-export", () => {
  it("every produced body validates once enveloped", () => {
    for (const body of SAMPLES) {
      const parsed = runEventSchema.safeParse({ ...body, ...ENVELOPE });
      expect(parsed.success, JSON.stringify(body)).toBe(true);
    }
  });

  it("every kind maps onto one of the five channels", () => {
    for (const body of SAMPLES) {
      expect(CHANNELS).toContain(channelOf({ kind: body.kind }));
    }
  });

  it("cursor math matches the engine: turn * stride + seq", () => {
    expect(makeCursor(0, 1)).toBe(1);
    expect(makeCursor(2, 5)).toBe(2_000_005);
  });
});
