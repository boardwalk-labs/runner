import { describe, it, expect } from "vitest";
import { RunAbortedError, abortReason, throwIfAborted } from "./run_abort.js";

describe("RunAbortedError", () => {
  it("carries the reason and a readable message", () => {
    const err = new RunAbortedError("credit_exhausted");
    expect(err.reason).toBe("credit_exhausted");
    expect(err.name).toBe("RunAbortedError");
    expect(err.message).toContain("credit_exhausted");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("abortReason", () => {
  it("returns the reason when the signal was aborted with a RunAbortedError", () => {
    const c = new AbortController();
    c.abort(new RunAbortedError("credit_exhausted"));
    expect(abortReason(c.signal)).toBe("credit_exhausted");
  });

  it("returns null for a non-aborted signal", () => {
    expect(abortReason(new AbortController().signal)).toBeNull();
  });

  it("returns null when aborted with a non-RunAbortedError reason", () => {
    const c = new AbortController();
    c.abort(new Error("some other reason"));
    expect(abortReason(c.signal)).toBeNull();
  });
});

describe("throwIfAborted", () => {
  it("is a no-op for undefined / non-aborted signals", () => {
    expect(() => {
      throwIfAborted(undefined);
    }).not.toThrow();
    expect(() => {
      throwIfAborted(new AbortController().signal);
    }).not.toThrow();
  });

  it("re-throws the signal's RunAbortedError (reason preserved)", () => {
    const c = new AbortController();
    const err = new RunAbortedError("credit_exhausted");
    c.abort(err);
    expect(() => {
      throwIfAborted(c.signal);
    }).toThrow(err);
  });

  it("throws a generic RunAbortedError('cancelled') when aborted without one", () => {
    const c = new AbortController();
    c.abort(); // default reason (AbortError), not a RunAbortedError
    try {
      throwIfAborted(c.signal);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RunAbortedError);
      expect((err as RunAbortedError).reason).toBe("cancelled");
    }
  });
});
