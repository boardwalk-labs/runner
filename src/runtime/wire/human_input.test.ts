import { describe, it, expect } from "vitest";
import { AppError } from "../support/index.js";
import {
  parseHumanInputSpec,
  validateHumanInputResponse,
  normalizeHumanInputResult,
  parseOnTimeout,
} from "./human_input.js";

describe("parseHumanInputSpec", () => {
  it("passes a valid text/choice/multiselect spec through", () => {
    expect(parseHumanInputSpec({ kind: "text", required: true })).toEqual({
      kind: "text",
      required: true,
    });
    expect(parseHumanInputSpec({ kind: "choice", options: ["a", "b"] })).toEqual({
      kind: "choice",
      options: ["a", "b"],
    });
  });

  it("defaults a missing/malformed spec to free text (never strands a gate)", () => {
    expect(parseHumanInputSpec(undefined)).toEqual({ kind: "text" });
    expect(parseHumanInputSpec(null)).toEqual({ kind: "text" });
    expect(parseHumanInputSpec({ kind: "bogus" })).toEqual({ kind: "text" });
    expect(parseHumanInputSpec({ kind: "choice" })).toEqual({ kind: "text" }); // options missing
  });
});

describe("validateHumanInputResponse — text", () => {
  it("accepts any string", () => {
    expect(validateHumanInputResponse({ kind: "text" }, { value: "hi" })).toEqual({ value: "hi" });
  });

  it("rejects a non-string value", () => {
    expect(() => validateHumanInputResponse({ kind: "text" }, { value: 5 })).toThrow(AppError);
  });

  it("rejects empty when required", () => {
    expect(() =>
      validateHumanInputResponse({ kind: "text", required: true }, { value: "   " }),
    ).toThrow(/required/);
  });
});

describe("validateHumanInputResponse — choice", () => {
  const spec = { kind: "choice" as const, options: ["yes", "no"] };

  it("marks a known option isOther=false", () => {
    expect(validateHumanInputResponse(spec, { value: "yes" })).toEqual({
      value: "yes",
      isOther: false,
    });
  });

  it("treats an unknown value as open text (isOther=true) when allowed (default)", () => {
    expect(validateHumanInputResponse(spec, { value: "maybe" })).toEqual({
      value: "maybe",
      isOther: true,
    });
  });

  it("rejects an unknown value when allowOther is false", () => {
    expect(() =>
      validateHumanInputResponse({ ...spec, allowOther: false }, { value: "maybe" }),
    ).toThrow(/not one of the allowed options/);
  });

  it("rejects a non-string value", () => {
    expect(() => validateHumanInputResponse(spec, { value: ["yes"] })).toThrow(AppError);
  });
});

describe("validateHumanInputResponse — multiselect", () => {
  const spec = { kind: "multiselect" as const, options: ["a", "b", "c"] };

  it("accepts a subset of options", () => {
    expect(validateHumanInputResponse(spec, { values: ["a", "c"] })).toEqual({
      values: ["a", "c"],
    });
  });

  it("accepts an open-text `other` when allowed", () => {
    expect(validateHumanInputResponse(spec, { values: ["a"], other: "d" })).toEqual({
      values: ["a"],
      other: "d",
    });
  });

  it("drops an empty `other` rather than recording it", () => {
    expect(validateHumanInputResponse(spec, { values: ["a"], other: "  " })).toEqual({
      values: ["a"],
    });
  });

  it("rejects a value not in options", () => {
    expect(() => validateHumanInputResponse(spec, { values: ["z"] })).toThrow(
      /not one of the allowed options/,
    );
  });

  it("rejects `other` when allowOther is false", () => {
    expect(() =>
      validateHumanInputResponse({ ...spec, allowOther: false }, { values: ["a"], other: "x" }),
    ).toThrow(/does not allow an open-text answer/);
  });

  it("enforces min/max (counting `other` as a selection)", () => {
    expect(() => validateHumanInputResponse({ ...spec, min: 2 }, { values: ["a"] })).toThrow(
      /at least 2/,
    );
    expect(() => validateHumanInputResponse({ ...spec, max: 1 }, { values: ["a", "b"] })).toThrow(
      /at most 1/,
    );
    // `other` counts toward the total
    expect(validateHumanInputResponse({ ...spec, min: 2 }, { values: ["a"], other: "d" })).toEqual({
      values: ["a"],
      other: "d",
    });
  });

  it("rejects a non-array values", () => {
    expect(() => validateHumanInputResponse(spec, { values: "a" })).toThrow(AppError);
  });
});

describe("normalizeHumanInputResult", () => {
  it("round-trips each stored result shape", () => {
    expect(normalizeHumanInputResult({ value: "hi" })).toEqual({ value: "hi" });
    expect(normalizeHumanInputResult({ value: "x", isOther: true })).toEqual({
      value: "x",
      isOther: true,
    });
    expect(normalizeHumanInputResult({ values: ["a"] })).toEqual({ values: ["a"] });
    expect(normalizeHumanInputResult({ values: ["a"], other: "d" })).toEqual({
      values: ["a"],
      other: "d",
    });
  });

  it("throws on a corrupt stored result", () => {
    expect(() => normalizeHumanInputResult({ nope: 1 })).toThrow(AppError);
  });
});

describe("parseOnTimeout", () => {
  it("defaults null / 'fail' / unrecognized to fail", () => {
    expect(parseOnTimeout(null)).toEqual({ kind: "fail" });
    expect(parseOnTimeout(undefined)).toEqual({ kind: "fail" });
    expect(parseOnTimeout("fail")).toEqual({ kind: "fail" });
    expect(parseOnTimeout({ nope: 1 })).toEqual({ kind: "fail" });
  });

  it("parses a { value } policy into a normalized result", () => {
    expect(parseOnTimeout({ value: { value: "no", isOther: false } })).toEqual({
      kind: "value",
      value: { value: "no", isOther: false },
    });
  });

  it("degrades a { value } with a malformed value to fail", () => {
    expect(parseOnTimeout({ value: { bogus: true } })).toEqual({ kind: "fail" });
  });
});
