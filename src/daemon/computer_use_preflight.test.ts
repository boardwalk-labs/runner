// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  permissionReport,
  reportComputerUsePermissions,
  requiredPermissions,
} from "./computer_use_preflight.js";

const BOTH_HELD = { accessibility: true, screenRecording: true };
const NONE_HELD = { accessibility: false, screenRecording: false };

describe("requiredPermissions", () => {
  it("needs nothing when no tier is enabled", () => {
    expect(requiredPermissions({})).toBeNull();
  });

  it("the desktop tier needs both (it injects input AND captures)", () => {
    expect(requiredPermissions({ BOARDWALK_DESKTOP_TIER: "1" })).toEqual({
      accessibility: true,
      screenRecording: true,
    });
  });

  it("the browser tier alone needs Screen Recording only — for the session recording, not Chrome", () => {
    // Chrome is driven over CDP, so browsing itself needs no OS grant.
    expect(requiredPermissions({ BOARDWALK_BROWSER_TIER: "1" })).toEqual({
      accessibility: false,
      screenRecording: true,
    });
  });

  it("recording off drops the Screen Recording requirement for the browser tier", () => {
    expect(
      requiredPermissions({ BOARDWALK_BROWSER_TIER: "1", BOARDWALK_RECORDING_ENABLED: "0" }),
    ).toEqual({ accessibility: false, screenRecording: false });
  });

  it("the desktop tier still needs Accessibility with recording off", () => {
    expect(
      requiredPermissions({ BOARDWALK_DESKTOP_TIER: "1", BOARDWALK_RECORDING_ENABLED: "0" }),
    ).toEqual({ accessibility: true, screenRecording: true });
  });
});

describe("permissionReport", () => {
  it("says nothing when every needed permission is held", () => {
    expect(permissionReport({ accessibility: true, screenRecording: true }, BOTH_HELD)).toEqual([]);
  });

  it("names each missing permission, what breaks, and where to grant it", () => {
    const lines = permissionReport({ accessibility: true, screenRecording: true }, NONE_HELD).join(
      "",
    );
    expect(lines).toContain("Accessibility");
    expect(lines).toContain("silently swallowed");
    expect(lines).toContain("Screen Recording");
    expect(lines).toContain("Privacy & Security");
    // The reader must know their other workflows are fine.
    expect(lines).toContain("Runs that do not open a computer-use session are unaffected");
  });

  it("reports only what is REQUIRED (a held-but-unneeded grant is not mentioned)", () => {
    const lines = permissionReport({ accessibility: false, screenRecording: true }, NONE_HELD).join(
      "",
    );
    expect(lines).toContain("Screen Recording");
    expect(lines).not.toContain("Accessibility");
  });
});

describe("reportComputerUsePermissions", () => {
  const logged = (): { log: (l: string) => void; lines: string[] } => {
    const lines: string[] = [];
    return { log: (l) => lines.push(l), lines };
  };

  it("warns on a --host Mac with a tier enabled and a permission missing", async () => {
    const { log, lines } = logged();
    await reportComputerUsePermissions({
      mode: "host",
      env: { BOARDWALK_DESKTOP_TIER: "1" },
      log,
      platform: "darwin",
      check: () => Promise.resolve(NONE_HELD),
    });
    expect(lines.join("")).toContain("Accessibility");
  });

  it("is silent in CONTAINER mode — the run uses its own display, not the Mac's", async () => {
    const { log, lines } = logged();
    await reportComputerUsePermissions({
      mode: "container",
      env: { BOARDWALK_DESKTOP_TIER: "1" },
      log,
      platform: "darwin",
      check: () => Promise.resolve(NONE_HELD),
    });
    expect(lines).toEqual([]);
  });

  it("is silent off macOS, and silent when no tier is enabled", async () => {
    const linux = logged();
    await reportComputerUsePermissions({
      mode: "host",
      env: { BOARDWALK_DESKTOP_TIER: "1" },
      log: linux.log,
      platform: "linux",
      check: () => Promise.resolve(NONE_HELD),
    });
    expect(linux.lines).toEqual([]);

    const noTier = logged();
    await reportComputerUsePermissions({
      mode: "host",
      env: {},
      log: noTier.log,
      platform: "darwin",
      check: () => Promise.resolve(NONE_HELD),
    });
    expect(noTier.lines).toEqual([]);
  });

  it("stays quiet when the permissions are held", async () => {
    const { log, lines } = logged();
    await reportComputerUsePermissions({
      mode: "host",
      env: { BOARDWALK_DESKTOP_TIER: "1" },
      log,
      platform: "darwin",
      check: () => Promise.resolve(BOTH_HELD),
    });
    expect(lines).toEqual([]);
  });

  it("never blocks the start when the probe itself fails", async () => {
    const { log, lines } = logged();
    await expect(
      reportComputerUsePermissions({
        mode: "host",
        env: { BOARDWALK_DESKTOP_TIER: "1" },
        log,
        platform: "darwin",
        check: () => Promise.reject(new Error("osascript missing")),
      }),
    ).resolves.toBeUndefined();
    expect(lines).toEqual([]);
  });

  it("does not run the probe at all when it cannot matter (container mode)", async () => {
    const check = vi.fn();
    await reportComputerUsePermissions({
      mode: "container",
      env: { BOARDWALK_DESKTOP_TIER: "1" },
      log: () => undefined,
      platform: "darwin",
      check: check as never,
    });
    expect(check).not.toHaveBeenCalled();
  });
});
