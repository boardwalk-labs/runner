import { describe, it, expect } from "vitest";
import { SecretRedactor, REDACTION_PLACEHOLDER, MIN_REDACTABLE_LENGTH } from "./secret_redactor.js";

describe("SecretRedactor.record", () => {
  it("starts empty", () => {
    expect(new SecretRedactor().size).toBe(0);
  });

  it("records a value of sufficient length", () => {
    const r = new SecretRedactor();
    r.record("super-secret-token");
    expect(r.size).toBe(1);
  });

  it("ignores values shorter than the length floor", () => {
    const r = new SecretRedactor();
    r.record("ab"); // 2 chars
    r.record("abc"); // 3 chars, still under MIN_REDACTABLE_LENGTH (4)
    expect(r.size).toBe(0);
  });

  it("records a value exactly at the floor", () => {
    const r = new SecretRedactor();
    r.record("a".repeat(MIN_REDACTABLE_LENGTH));
    expect(r.size).toBe(1);
  });

  it("dedupes repeated values (idempotent)", () => {
    const r = new SecretRedactor();
    r.record("repeated-secret");
    r.record("repeated-secret");
    expect(r.size).toBe(1);
  });

  it("honors a custom minLength", () => {
    const r = new SecretRedactor({ minLength: 8 });
    r.record("1234567"); // 7 chars
    expect(r.size).toBe(0);
    r.record("12345678"); // 8 chars
    expect(r.size).toBe(1);
  });
});

describe("SecretRedactor.redactText", () => {
  it("returns text unchanged when nothing is recorded", () => {
    const r = new SecretRedactor();
    expect(r.redactText("nothing to hide here")).toBe("nothing to hide here");
  });

  it("replaces a single occurrence with the placeholder", () => {
    const r = new SecretRedactor();
    r.record("sk-live-abc123");
    expect(r.redactText("the key is sk-live-abc123 ok")).toBe(
      `the key is ${REDACTION_PLACEHOLDER} ok`,
    );
  });

  it("replaces ALL occurrences of a value", () => {
    const r = new SecretRedactor();
    r.record("token-xyz");
    expect(r.redactText("token-xyz and again token-xyz")).toBe(
      `${REDACTION_PLACEHOLDER} and again ${REDACTION_PLACEHOLDER}`,
    );
  });

  it("redacts multiple distinct secrets", () => {
    const r = new SecretRedactor();
    r.record("aaaa-secret");
    r.record("bbbb-secret");
    expect(r.redactText("first aaaa-secret then bbbb-secret")).toBe(
      `first ${REDACTION_PLACEHOLDER} then ${REDACTION_PLACEHOLDER}`,
    );
  });

  it("redacts the longer secret first when one contains another", () => {
    const r = new SecretRedactor();
    r.record("prefix-secret"); // substring of the longer one
    r.record("prefix-secret-extended");
    // The full longer value must be fully replaced, not fragmented into "[REDACTED]-extended".
    expect(r.redactText("see prefix-secret-extended now")).toBe(`see ${REDACTION_PLACEHOLDER} now`);
  });

  it("uses a custom placeholder", () => {
    const r = new SecretRedactor({ placeholder: "***" });
    r.record("hunter2-password");
    expect(r.redactText("pw=hunter2-password")).toBe("pw=***");
  });
});

describe("SecretRedactor.redactValue", () => {
  it("returns the value unchanged when nothing is recorded", () => {
    const r = new SecretRedactor();
    const input = { a: "secret-ish", b: [1, 2] };
    expect(r.redactValue(input)).toBe(input); // identity — allocation-free fast path
  });

  it("redacts a bare string", () => {
    const r = new SecretRedactor();
    r.record("my-secret-value");
    expect(r.redactValue("contains my-secret-value here")).toBe(
      `contains ${REDACTION_PLACEHOLDER} here`,
    );
  });

  it("redacts strings nested in objects and arrays", () => {
    const r = new SecretRedactor();
    r.record("nested-secret");
    const out = r.redactValue({
      ok: true,
      note: "has nested-secret inside",
      list: ["clean", "nested-secret", { deep: "nested-secret!" }],
    });
    expect(out).toEqual({
      ok: true,
      note: `has ${REDACTION_PLACEHOLDER} inside`,
      list: ["clean", REDACTION_PLACEHOLDER, { deep: `${REDACTION_PLACEHOLDER}!` }],
    });
  });

  it("leaves non-string primitives untouched", () => {
    const r = new SecretRedactor();
    r.record("the-secret");
    expect(r.redactValue(42)).toBe(42);
    expect(r.redactValue(true)).toBe(true);
    expect(r.redactValue(null)).toBe(null);
  });

  it("does not redact object keys that match a secret (keys are field names, not values)", () => {
    const r = new SecretRedactor();
    r.record("keyname-secret");
    const out = r.redactValue({ "keyname-secret": "value" });
    expect(out).toEqual({ "keyname-secret": "value" });
  });
});
