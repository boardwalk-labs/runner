import { describe, it, expect, vi, afterEach } from "vitest";
import { createLogger, configureLogging } from "./index.js";

/** Run `fn` with process.stdout/stderr writes captured (the logger writes JSON lines to them). */
function captureOutput(fn: () => void): { out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const so = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
  const se = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    so.mockRestore();
    se.mockRestore();
  }
  return { out: out.join(""), err: err.join("") };
}

describe("configureLogging", () => {
  // Re-freeze to the default so a test's level doesn't leak into the next (module-level state).
  afterEach(() => {
    configureLogging({});
  });

  it("freezes the level from the given env — below-threshold levels are suppressed", () => {
    configureLogging({ BOARDWALK_RUNNER_LOG_LEVEL: "error" });
    const log = createLogger("t");
    const { out, err } = captureOutput(() => {
      log.info("hi");
      log.debug("dbg");
      log.error("boom");
    });
    expect(out).toBe(""); // info/debug are below ERROR
    expect(err).toContain("boom"); // errors go to stderr
  });

  it("BOARDWALK_RUNNER_DEBUG=1 is the legacy alias for debug", () => {
    configureLogging({ BOARDWALK_RUNNER_DEBUG: "1" });
    const { out } = captureOutput(() => createLogger("t").debug("dbg"));
    expect(out).toContain("dbg");
  });

  it("ignores a LATER process.env change — an author's meta.env can't raise verbosity post-boot", () => {
    configureLogging({ BOARDWALK_RUNNER_LOG_LEVEL: "error" }); // frozen from the trusted boot env
    // eslint-disable-next-line no-restricted-syntax -- test: read to save/restore the ambient env
    const prev = process.env.BOARDWALK_RUNNER_LOG_LEVEL;
    // Simulate the identity relay overlaying an author's meta.env onto process.env after boot.
    // eslint-disable-next-line no-restricted-syntax -- test: prove the frozen level ignores this
    process.env.BOARDWALK_RUNNER_LOG_LEVEL = "debug";
    try {
      const { out } = captureOutput(() => createLogger("t").info("hi"));
      expect(out).toBe(""); // still suppressed — the frozen ERROR level wins over process.env
    } finally {
      // eslint-disable-next-line no-restricted-syntax -- test cleanup: restore the ambient env
      if (prev === undefined) delete process.env.BOARDWALK_RUNNER_LOG_LEVEL;
      // eslint-disable-next-line no-restricted-syntax -- test cleanup: restore the ambient env
      else process.env.BOARDWALK_RUNNER_LOG_LEVEL = prev;
    }
  });
});
