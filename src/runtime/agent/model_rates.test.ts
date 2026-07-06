import { describe, it, expect } from "vitest";
import { BUDGET_GUARDRAIL_RATE } from "./model_rates.js";

describe("BUDGET_GUARDRAIL_RATE", () => {
  it("is a flat Sonnet-class representative rate (USD / million tokens)", () => {
    expect(BUDGET_GUARDRAIL_RATE).toEqual({ inputPerMillion: 3, outputPerMillion: 15 });
  });
});
