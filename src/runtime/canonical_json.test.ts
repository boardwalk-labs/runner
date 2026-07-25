import { describe, it, expect } from "vitest";
import { canonicalJson } from "./canonical_json.js";

describe("canonicalJson", () => {
  it("is independent of object key order (a jsonb round-trip reorders keys)", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson({ taskId: "t", sector: "s" })).toBe(
      canonicalJson({ sector: "s", taskId: "t" }),
    );
  });

  it("sorts nested keys too", () => {
    expect(canonicalJson({ outer: { z: 1, a: { y: 2, b: 3 } } })).toBe(
      '{"outer":{"a":{"b":3,"y":2},"z":1}}',
    );
  });

  it("preserves array order (arrays are ordered data, not a bag of keys)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson({ xs: [{ b: 1, a: 2 }] })).toBe('{"xs":[{"a":2,"b":1}]}');
  });

  it("distinguishes genuinely different inputs", () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: "1" }));
    expect(canonicalJson(null)).not.toBe(canonicalJson({}));
  });

  it("drops undefined members, matching what a jsonb round-trip keeps", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it("handles the scalar and empty cases", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson(5)).toBe("5");
    expect(canonicalJson("s")).toBe('"s"');
    expect(canonicalJson({})).toBe("{}");
  });
});
