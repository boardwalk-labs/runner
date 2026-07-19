import { describe, it, expect } from "vitest";
import type { ChatTurn } from "@boardwalk-labs/engine/core";
import {
  parseInferenceFrame,
  serializeReasoningFrame,
  serializeResultFrame,
} from "./inference_proxy.js";

const turn: ChatTurn = { text: "ok", toolCalls: [], usage: {}, wantsTools: false };

describe("reasoning frame", () => {
  it("round-trips a reasoning delta as its own frame kind (not a text delta)", () => {
    const frame = parseInferenceFrame(serializeReasoningFrame("let me think").trimEnd());
    expect(frame).toEqual({ kind: "reasoning", text: "let me think" });
  });

  it("coerces a missing/non-string reasoning text to empty, like the delta frame", () => {
    const frame = parseInferenceFrame(JSON.stringify({ t: "reasoning" }));
    expect(frame).toEqual({ kind: "reasoning", text: "" });
  });
});

describe("forward compatibility", () => {
  it("tolerates an unknown frame kind as a no-op instead of crashing the stream", () => {
    // The whole point: a newer broker can emit a frame kind an older runner predates (this is how
    // `reasoning` reaches a fleet mid-rollout) without killing the model turn.
    expect(parseInferenceFrame(JSON.stringify({ t: "something-new" }))).toEqual({ kind: "ping" });
  });
});

describe("result frame contextTokens", () => {
  it("round-trips the served model's context window", () => {
    const frame = parseInferenceFrame(
      serializeResultFrame(turn, "boardwalk/auto", 0, 1_000_000).trimEnd(),
    );
    expect(frame.kind === "result" && frame.contextTokens).toBe(1_000_000);
  });

  it("omits the key entirely when the broker doesn't know the window", () => {
    expect(serializeResultFrame(turn, "p/m", 0)).not.toContain("contextTokens");
  });

  /**
   * The rolling-deploy case: a pre-window broker sends no `contextTokens`, and the loop must fall
   * back to its conservative default budget rather than see a bogus window.
   */
  it("parses a frame from a pre-window broker as an unknown window", () => {
    const line = JSON.stringify({ t: "result", turn, modelRef: "p/m", costMicros: 0 });
    const frame = parseInferenceFrame(line);
    expect(frame.kind === "result" && frame.contextTokens).toBeUndefined();
  });

  it("drops a nonsense window rather than sizing a budget from it", () => {
    for (const bogus of [0, -1, "1000000", null, {}]) {
      const line = JSON.stringify({
        t: "result",
        turn,
        modelRef: "p/m",
        costMicros: 0,
        contextTokens: bogus,
      });
      const frame = parseInferenceFrame(line);
      expect(frame.kind === "result" && frame.contextTokens).toBeUndefined();
    }
  });
});
