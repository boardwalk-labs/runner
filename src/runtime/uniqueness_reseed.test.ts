import { describe, it, expect } from "vitest";
import { reseedUserspaceCsprng } from "./uniqueness_reseed.js";

// The real reseed's effect — divergence across snapshot CLONES — can only be proven on a KVM
// substrate (two microVMs restored from one base), so it lives in the hosting platform's own
// end-to-end harness, not here. These tests pin the JS contract: the
// entry point never throws, and it degrades to a no-op on a platform with no prebuilt addon
// (e.g. this test host, or the ARM64 Fargate worker where there is no snapshot to reseed).

describe("reseedUserspaceCsprng", () => {
  it("never throws and returns a boolean (ran vs degraded no-op)", () => {
    const ran = reseedUserspaceCsprng();
    expect(typeof ran).toBe("boolean");
  });

  it("is safe to call repeatedly (both restore boundaries call it, wake calls it every time)", () => {
    expect(() => {
      reseedUserspaceCsprng();
      reseedUserspaceCsprng();
      reseedUserspaceCsprng();
    }).not.toThrow();
  });
});
