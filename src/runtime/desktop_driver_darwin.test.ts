// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { AppError } from "./support/index.js";
import {
  makeDarwinDriver,
  parseDarwinChord,
  pngSize,
  preflightDarwinDesktop,
  type DarwinExec,
} from "./desktop_driver_darwin.js";

/** A 1x1 PNG header carrying real IHDR dimensions (only the first 24 bytes are read). */
function fakePng(width: number, height: number): Buffer {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** Records every exec call; screenshots land via a stubbed `screencapture` writing the fake PNG. */
function fakeExec(opts: { points?: string; png?: Buffer } = {}): {
  exec: DarwinExec;
  calls: [string, readonly string[]][];
  scripts: string[];
} {
  const calls: [string, readonly string[]][] = [];
  const scripts: string[] = [];
  const exec: DarwinExec = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "screencapture") {
      const file = args[args.length - 1] ?? "";
      const { writeFile } = await import("node:fs/promises");
      await writeFile(file, opts.png ?? fakePng(2560, 1600));
      return "";
    }
    const script = args[args.length - 1] ?? "";
    scripts.push(script);
    if (script.includes("CGDisplayBounds")) return opts.points ?? "1280x800";
    if (script.includes("AXIsProcessTrusted")) return "true";
    return "ok";
  };
  return { exec, calls, scripts };
}

describe("parseDarwinChord", () => {
  it("maps modifiers to CGEventFlags and the key to a virtual keycode", () => {
    expect(parseDarwinChord("Meta+a")).toEqual({ flags: 0x00100000, keyCode: 0 });
    expect(parseDarwinChord("Control+Shift+t")).toEqual({ flags: 0x00060000, keyCode: 17 });
    expect(parseDarwinChord("Enter")).toEqual({ flags: 0, keyCode: 36 });
    expect(parseDarwinChord("Escape")).toEqual({ flags: 0, keyCode: 53 });
  });

  it("rejects an unmapped key and a modifier-only chord, with actionable messages", () => {
    expect(() => parseDarwinChord("XF86AudioMute")).toThrow(/not a key this driver can press/);
    expect(() => parseDarwinChord("Command")).toThrow(/only modifiers/);
    try {
      parseDarwinChord("nope");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect(err instanceof AppError ? (err.hint ?? "") : "").toContain("named key");
    }
  });
});

describe("pngSize", () => {
  it("reads IHDR dimensions and rejects a non-PNG", () => {
    expect(pngSize(fakePng(2560, 1600))).toEqual({ width: 2560, height: 1600 });
    expect(() => pngSize(Buffer.alloc(24))).toThrow(/not a PNG/);
  });
});

describe("preflightDarwinDesktop", () => {
  it("passes when both permissions are granted", async () => {
    const { exec } = fakeExec();
    await expect(preflightDarwinDesktop(exec)).resolves.toBeUndefined();
  });

  it("fails loudly (with the System Settings fix) when Accessibility is missing", async () => {
    const exec: DarwinExec = (cmd, args) => {
      if (cmd === "osascript" && (args[args.length - 1] ?? "").includes("AXIsProcessTrusted")) {
        return Promise.resolve("false");
      }
      return Promise.resolve("");
    };
    try {
      await preflightDarwinDesktop(exec);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect(err instanceof AppError ? err.message : "").toContain("Accessibility");
      expect(err instanceof AppError ? (err.hint ?? "") : "").toContain("Privacy & Security");
    }
  });

  it("fails loudly when Screen Recording is missing (screencapture refuses)", async () => {
    const exec: DarwinExec = (cmd, args) => {
      if (cmd === "screencapture") {
        return Promise.reject(
          new Error("screencapture failed: could not create image from display"),
        );
      }
      if ((args[args.length - 1] ?? "").includes("AXIsProcessTrusted"))
        return Promise.resolve("true");
      return Promise.resolve("ok");
    };
    await expect(preflightDarwinDesktop(exec)).rejects.toThrow(/Screen Recording/);
  });
});

describe("makeDarwinDriver", () => {
  it("screenshots via screencapture and reports the image's true pixel size", async () => {
    const { exec, calls } = fakeExec();
    const shot = await makeDarwinDriver(exec).screenshot();
    expect(shot.width).toBe(2560);
    expect(shot.height).toBe(1600);
    const capture = calls.find(([cmd]) => cmd === "screencapture");
    expect(capture?.[1]).toContain("-x"); // no shutter sound
    expect(capture?.[1]).toContain("png");
  });

  it("converts Retina pixel coordinates to CG points for clicks (2x panel ⇒ half)", async () => {
    const { exec, scripts } = fakeExec({ points: "1280x800", png: fakePng(2560, 1600) });
    const driver = makeDarwinDriver(exec);
    await driver.screenshot(); // learns points-per-pixel = 0.5
    await driver.click({ x: 1000, y: 600 });
    const click = scripts.find((s) => s.includes("CGEventCreateMouseEvent"));
    expect(click).toContain("x: 500");
    expect(click).toContain("y: 300");
  });

  it("passes coordinates through unscaled on a non-Retina display", async () => {
    const { exec, scripts } = fakeExec({ points: "1280x800", png: fakePng(1280, 800) });
    const driver = makeDarwinDriver(exec);
    await driver.screenshot();
    await driver.click({ x: 640, y: 400 });
    const click = scripts.find((s) => s.includes("CGEventCreateMouseEvent"));
    expect(click).toContain("x: 640");
    expect(click).toContain("y: 400");
  });

  it("types text as a Unicode string (no keycode map) and presses Return on submit", async () => {
    const { exec, scripts } = fakeExec();
    await makeDarwinDriver(exec).type({ text: "héllo 👋", submit: true });
    expect(scripts.some((s) => s.includes("CGEventKeyboardSetUnicodeString"))).toBe(true);
    // The Return press is a keycode event (36), not part of the unicode string.
    expect(scripts.some((s) => s.includes("CGEventCreateKeyboardEvent(null, 36"))).toBe(true);
  });

  it("scroll inverts dy so positive means down, matching the SDK contract", async () => {
    const { exec, scripts } = fakeExec();
    await makeDarwinDriver(exec).scroll({ dx: 0, dy: 120 });
    const scroll = scripts.find((s) => s.includes("CGEventCreateScrollWheelEvent2"));
    expect(scroll).toContain("-120");
  });

  it("drag interpolates between the endpoints (apps ignore a teleporting drag)", async () => {
    const { exec, scripts } = fakeExec();
    await makeDarwinDriver(exec).drag({ from: { x: 10, y: 10 }, to: { x: 20, y: 20 } });
    const drag = scripts.find((s) => s.includes("CGEventCreateMouseEvent"));
    expect(drag).toContain("i <= 10"); // interpolation loop
    expect(drag).toContain("$.CGEventPost");
  });

  it("surfaces a capture failure as a screenshot error carrying the permission hint", async () => {
    const exec: DarwinExec = (cmd) =>
      cmd === "screencapture"
        ? Promise.reject(new Error("could not create image from display"))
        : Promise.resolve("1280x800");
    await expect(makeDarwinDriver(exec).screenshot()).rejects.toThrow(/macOS screenshot failed/);
  });
});
