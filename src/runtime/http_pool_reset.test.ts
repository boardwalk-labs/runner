import { describe, it, expect } from "vitest";
import { getGlobalDispatcher } from "undici";
import { resetHttpConnectionPool } from "./http_pool_reset.js";

describe("resetHttpConnectionPool", () => {
  it("swaps in a fresh global dispatcher so post-wake requests open new sockets", () => {
    const before = getGlobalDispatcher();
    const ok = resetHttpConnectionPool();
    const after = getGlobalDispatcher();
    expect(ok).toBe(true);
    // A distinct instance ⇒ the dead pool is discarded; the next request cannot reuse a frozen socket.
    expect(after).not.toBe(before);
  });

  it("is safe to call on every wake (each resets again, never throws)", () => {
    const first = getGlobalDispatcher();
    expect(resetHttpConnectionPool()).toBe(true);
    const second = getGlobalDispatcher();
    expect(resetHttpConnectionPool()).toBe(true);
    const third = getGlobalDispatcher();
    expect(second).not.toBe(first);
    expect(third).not.toBe(second);
  });
});
