// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  chordToXdotool,
  desktopTierEnabled,
  loadGuestDesktopConfig,
  makeXdotoolDriver,
  scrollNotches,
  type DriverExec,
  type GuestDesktopConfig,
} from "./desktop_driver.js";

const CFG: GuestDesktopConfig = { display: ":0", screenWidth: 1280, screenHeight: 800 };

function fakeExec(): { exec: DriverExec; calls: [string, readonly string[]][] } {
  const calls: [string, readonly string[]][] = [];
  const exec: DriverExec = (cmd, args) => {
    calls.push([cmd, args]);
    return Promise.resolve(Buffer.from("png-bytes"));
  };
  return { exec, calls };
}

describe("desktopTierEnabled / loadGuestDesktopConfig", () => {
  it("requires BOARDWALK_DESKTOP_TIER=1", () => {
    expect(desktopTierEnabled({})).toBe(false);
    expect(desktopTierEnabled({ BOARDWALK_DESKTOP_TIER: "1" })).toBe(true);
    expect(loadGuestDesktopConfig({})).toBeNull();
  });

  it("reads display + screen size with the standard defaults (linux only)", () => {
    const env = {
      BOARDWALK_DESKTOP_TIER: "1",
      BOARDWALK_SCREEN_WIDTH: "1920",
      BOARDWALK_SCREEN_HEIGHT: "1080",
      DISPLAY: ":7",
    };
    expect(loadGuestDesktopConfig(env, "linux")).toEqual({
      display: ":7",
      screenWidth: 1920,
      screenHeight: 1080,
    });
    // The macOS/Windows drivers are not built yet — the tier declines off Linux.
    expect(loadGuestDesktopConfig(env, "darwin")).toBeNull();
  });
});

describe("chordToXdotool", () => {
  it("maps SDK modifier/key names to xdotool syntax", () => {
    expect(chordToXdotool("Meta+a")).toBe("super+a");
    expect(chordToXdotool("Control+Shift+t")).toBe("ctrl+shift+t");
    expect(chordToXdotool("Enter")).toBe("Return");
    expect(chordToXdotool("Escape")).toBe("Escape");
    expect(chordToXdotool("PageDown")).toBe("Next");
  });

  it("passes unknown tokens through verbatim (raw keysyms stay reachable)", () => {
    expect(chordToXdotool("F5")).toBe("F5");
    expect(chordToXdotool("ctrl+XF86AudioMute")).toBe("ctrl+XF86AudioMute");
  });
});

describe("scrollNotches", () => {
  it("is at least 1 for any non-zero delta and caps large deltas", () => {
    expect(scrollNotches(1)).toBe(1);
    expect(scrollNotches(-1)).toBe(1);
    expect(scrollNotches(120)).toBe(2);
    expect(scrollNotches(1_000_000)).toBe(50);
  });
});

describe("makeXdotoolDriver", () => {
  it("screenshot grabs one x11grab frame as PNG at the screen size", async () => {
    const { exec, calls } = fakeExec();
    const shot = await makeXdotoolDriver(CFG, exec).screenshot();
    expect(shot).toEqual({ png: Buffer.from("png-bytes"), width: 1280, height: 800 });
    const [cmd, args] = calls[0] ?? ["", []];
    expect(cmd).toBe("ffmpeg");
    expect(args).toContain("x11grab");
    expect(args).toContain("1280x800");
    expect(args).toContain("pipe:1");
    expect(args[args.indexOf("-frames:v") + 1]).toBe("1");
  });

  it("click moves then clicks, mapping button names and double-click", async () => {
    const { exec, calls } = fakeExec();
    const driver = makeXdotoolDriver(CFG, exec);
    await driver.click({ x: 10, y: 20 });
    expect(calls[0]).toEqual(["xdotool", ["mousemove", "--sync", "10", "20", "click", "1"]]);
    await driver.click({ x: 5, y: 6, button: "right", clicks: 2 });
    expect(calls[1]).toEqual([
      "xdotool",
      ["mousemove", "--sync", "5", "6", "click", "--repeat", "2", "--delay", "50", "3"],
    ]);
  });

  it("clamps out-of-bounds coordinates into the screen", async () => {
    const { exec, calls } = fakeExec();
    await makeXdotoolDriver(CFG, exec).click({ x: 99_999, y: 900.7 });
    expect(calls[0]?.[1].slice(2, 4)).toEqual(["1279", "799"]);
  });

  it("type sends the text, and Return only with submit", async () => {
    const { exec, calls } = fakeExec();
    const driver = makeXdotoolDriver(CFG, exec);
    await driver.type({ text: "hello" });
    expect(calls).toEqual([["xdotool", ["type", "--delay", "12", "--", "hello"]]]);
    await driver.type({ text: "world", submit: true });
    expect(calls[2]).toEqual(["xdotool", ["key", "--clearmodifiers", "Return"]]);
  });

  it("key presses the translated chord", async () => {
    const { exec, calls } = fakeExec();
    await makeXdotoolDriver(CFG, exec).key("Meta+a");
    expect(calls[0]).toEqual(["xdotool", ["key", "--clearmodifiers", "super+a"]]);
  });

  it("scroll converts deltas to wheel clicks (down=5, up=4, right=7, left=6) at the point", async () => {
    const { exec, calls } = fakeExec();
    const driver = makeXdotoolDriver(CFG, exec);
    await driver.scroll({ dx: 0, dy: 120, x: 40, y: 50 });
    expect(calls[0]).toEqual([
      "xdotool",
      ["mousemove", "--sync", "40", "50", "click", "--repeat", "2", "5"],
    ]);
    await driver.scroll({ dx: -60, dy: -60 });
    expect(calls[1]).toEqual([
      "xdotool",
      ["click", "--repeat", "1", "4", "click", "--repeat", "1", "6"],
    ]);
  });

  it("drag presses at from, moves, releases at to", async () => {
    const { exec, calls } = fakeExec();
    await makeXdotoolDriver(CFG, exec).drag({ from: { x: 1, y: 2 }, to: { x: 3, y: 4 } });
    expect(calls[0]).toEqual([
      "xdotool",
      [
        "mousemove",
        "--sync",
        "1",
        "2",
        "mousedown",
        "1",
        "mousemove",
        "--sync",
        "3",
        "4",
        "mouseup",
        "1",
      ],
    ]);
  });

  it("surfaces a failed exec as a rejection", async () => {
    const exec: DriverExec = vi.fn(() => Promise.reject(new Error("xdotool failed: no display")));
    await expect(makeXdotoolDriver(CFG, exec).key("a")).rejects.toThrow(/no display/);
  });
});
