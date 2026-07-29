// The empty-input rule: coerce ONLY where the derived schema rejects what arrived (`null`) and
// accepts `{}`. Everything else — a real input, an untyped contract, a nullable one, a contract
// with required properties — passes through untouched.

import { describe, it, expect } from "vitest";
import { effectiveProgramInput } from "./effective_input.js";

/** `run(input: { repos?: string[]; dryRun?: boolean })` — every property optional. */
const ALL_OPTIONAL = {
  type: "object",
  properties: { repos: { type: "array", items: { type: "string" } }, dryRun: { type: "boolean" } },
  additionalProperties: false,
};

describe("effectiveProgramInput", () => {
  it("hands an all-optional typed contract `{}` when the trigger supplied nothing", () => {
    expect(effectiveProgramInput(null, ALL_OPTIONAL)).toEqual({});
    expect(effectiveProgramInput(undefined, ALL_OPTIONAL)).toEqual({});
  });

  it("passes a supplied input through untouched, whatever the schema", () => {
    const input = { repos: ["owner/name"] };
    expect(effectiveProgramInput(input, ALL_OPTIONAL)).toBe(input);
    expect(effectiveProgramInput(false, ALL_OPTIONAL)).toBe(false);
    // `null` is only ever the ABSENT marker; an author wanting a real null declares it nullable
    // (covered below), so there is no supplied-null case to distinguish here.
    expect(effectiveProgramInput(0, null)).toBe(0);
    expect(effectiveProgramInput("", null)).toBe("");
  });

  it("leaves an untyped workflow alone (no schema, and the raw-JSON `{}` schema)", () => {
    expect(effectiveProgramInput(null, null)).toBeNull();
    // The deriver degrades an unresolvable or explicitly `any` input to `{}` — accepts everything,
    // so `null` is a valid input and nothing is wrong to fix.
    expect(effectiveProgramInput(null, {})).toBeNull();
  });

  it("leaves an explicitly nullable contract alone", () => {
    expect(effectiveProgramInput(null, { type: ["object", "null"], properties: {} })).toBeNull();
    expect(
      effectiveProgramInput(null, { anyOf: [{ type: "object" }, { type: "null" }] }),
    ).toBeNull();
  });

  it("leaves a contract with required properties as null — the deploy check owns that case", () => {
    const schema = {
      type: "object",
      properties: { repo: { type: "string" } },
      required: ["repo"],
    };
    // `{}` would not satisfy it either, so coercing would only push the failure deeper.
    expect(effectiveProgramInput(null, schema)).toBeNull();
  });

  it("leaves a non-object contract as null", () => {
    expect(effectiveProgramInput(null, { type: "string" })).toBeNull();
    expect(effectiveProgramInput(null, { type: "array", items: { type: "string" } })).toBeNull();
  });

  it("resolves a $ref root (a self-recursive input type hoists into $defs)", () => {
    const schema = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: { child: { $ref: "#/$defs/Node" } },
          additionalProperties: false,
        },
      },
    };
    expect(effectiveProgramInput(null, schema)).toEqual({});
  });

  it("fails soft on an uncompilable schema (a deriver bug is never a run failure)", () => {
    expect(effectiveProgramInput(null, { type: "object", required: "not-an-array" })).toBeNull();
  });
});
