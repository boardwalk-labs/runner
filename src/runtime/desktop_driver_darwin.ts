// SPDX-License-Identifier: Apache-2.0

// The macOS DesktopDriver — self-hosted computer use on the operator's real Mac (COMPUTER_USE_SESSION.md
// §6.2 "self-hosted parity"). Input is CGEvent, capture is the system `screencapture`; both are reached
// through JXA (`osascript -l JavaScript`), measured at ~30ms per call — negligible beside a model turn,
// so this needs NO native addon and no build toolchain on an operator's machine.
//
// Two OS permissions gate it, and each fails in its own silent way, so `preflightDarwinDesktop` checks
// both BEFORE a session opens rather than letting a run click into the void:
//   - Accessibility     — CGEventPost SUCCEEDS but the event is filtered; nothing moves.
//   - Screen Recording  — `screencapture` exits non-zero ("could not create image from display").
//
// Retina: `screencapture` writes BACKING-STORE pixels (2x on a Retina panel) while CGEvent takes
// POINTS. The model grounds on the image it sees, so the driver reports true pixel dimensions and
// converts every incoming coordinate by the measured points/pixels ratio.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError, ErrorCode, createLogger } from "./support/index.js";
import type {
  DesktopClick,
  DesktopDriver,
  DesktopScreenshotCapture,
  DesktopScroll,
} from "./desktop_driver.js";

const log = createLogger("desktop_driver_darwin");

/** How to grant each permission, in the words System Settings uses. */
const ACCESSIBILITY_HINT =
  "Grant Accessibility to the app running the runner (usually Terminal/iTerm): System Settings > Privacy & Security > Accessibility, then restart the runner.";
const SCREEN_RECORDING_HINT =
  "Grant Screen Recording to the app running the runner (usually Terminal/iTerm): System Settings > Privacy & Security > Screen Recording, then restart the runner.";

/** Exec seam (mirrors the Linux driver's) — resolves stdout, rejects on a non-zero exit. */
export type DarwinExec = (cmd: string, args: readonly string[]) => Promise<string>;

const defaultExec: DarwinExec = (cmd, args) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      cmd,
      [...args],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err !== null) {
          const detail = stderr.trim() || err.message;
          reject(new Error(`${cmd} failed: ${detail}`));
          return;
        }
        resolve(stdout);
      },
    );
  });

/** Run a JXA snippet and resolve its trimmed result. */
function jxa(exec: DarwinExec, script: string): Promise<string> {
  return exec("osascript", ["-l", "JavaScript", "-e", script]).then((out) => out.trim());
}

/** SDK chord tokens → macOS virtual keycodes. Unmapped single characters are typed as text. */
const KEYCODES: Readonly<Record<string, number>> = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  escape: 53,
  esc: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
  a: 0,
  b: 11,
  c: 8,
  d: 2,
  e: 14,
  f: 3,
  g: 5,
  h: 4,
  i: 34,
  j: 38,
  k: 40,
  l: 37,
  m: 46,
  n: 45,
  o: 31,
  p: 35,
  q: 12,
  r: 15,
  s: 1,
  t: 17,
  u: 32,
  v: 9,
  w: 13,
  x: 7,
  y: 16,
  z: 6,
  "0": 29,
  "1": 18,
  "2": 19,
  "3": 20,
  "4": 21,
  "5": 23,
  "6": 22,
  "7": 26,
  "8": 28,
  "9": 25,
};

/** CGEventFlags bits for the modifier tokens. */
const MODIFIER_FLAGS: Readonly<Record<string, number>> = {
  shift: 0x00020000,
  control: 0x00040000,
  ctrl: 0x00040000,
  alt: 0x00080000,
  option: 0x00080000,
  meta: 0x00100000,
  cmd: 0x00100000,
  command: 0x00100000,
  super: 0x00100000,
};

/** A parsed chord: the modifier flag mask + the target key's virtual keycode. */
export function parseDarwinChord(chord: string): { flags: number; keyCode: number } {
  const tokens = chord
    .split("+")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  let flags = 0;
  let keyCode: number | null = null;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    const modifier = MODIFIER_FLAGS[lower];
    if (modifier !== undefined) {
      flags |= modifier;
      continue;
    }
    const code = KEYCODES[lower];
    if (code === undefined) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `key "${chord}": "${token}" is not a key this driver can press on macOS`,
        { kind: "desktop_key_unmapped", chord },
        "Use a named key (Enter, Escape, Tab, arrows, F1-F12) or a single letter/digit, optionally with Command/Control/Option/Shift.",
      );
    }
    keyCode = code;
  }
  if (keyCode === null) {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      `key "${chord}" names only modifiers — add the key to press`,
      { kind: "desktop_key_unmapped", chord },
    );
  }
  return { flags, keyCode };
}

/** Which macOS permissions the runner currently holds. Each is probed the way it actually fails. */
export interface DarwinPermissions {
  /** CGEvent input. Without it, posts SUCCEED and the system silently swallows them. */
  accessibility: boolean;
  /** Screen capture. Without it, `screencapture` exits non-zero. */
  screenRecording: boolean;
}

/** Probe both permissions without throwing — the startup report needs the full picture, not the
 *  first gap. `preflightDarwinDesktop` is the fail-at-open wrapper over this. */
export async function checkDarwinPermissions(
  exec: DarwinExec = defaultExec,
): Promise<DarwinPermissions> {
  const trusted = await jxa(
    exec,
    "ObjC.import('ApplicationServices'); String($.AXIsProcessTrusted())",
  ).catch(() => "false");
  let screenRecording = true;
  const dir = await mkdtemp(join(tmpdir(), "bw-desktop-permcheck-"));
  try {
    await exec("screencapture", ["-x", "-C", "-R", "0,0,1,1", "-t", "png", join(dir, "probe.png")]);
    await readFile(join(dir, "probe.png"));
  } catch {
    screenRecording = false;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  return { accessibility: trusted === "true", screenRecording };
}

/** The grant instructions for a missing permission, in the words System Settings uses. */
export function darwinPermissionHint(permission: keyof DarwinPermissions): string {
  return permission === "accessibility" ? ACCESSIBILITY_HINT : SCREEN_RECORDING_HINT;
}

/** Both OS permissions, probed the way each actually fails. Throws with the fix on the first gap. */
export async function preflightDarwinDesktop(exec: DarwinExec = defaultExec): Promise<void> {
  const trusted = await jxa(
    exec,
    "ObjC.import('ApplicationServices'); String($.AXIsProcessTrusted())",
  ).catch(() => "false");
  if (trusted !== "true") {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      "macOS Accessibility permission is not granted, so the desktop session could not send clicks or keystrokes",
      { kind: "desktop_permission_missing", permission: "accessibility" },
      ACCESSIBILITY_HINT,
    );
  }
  // Screen Recording has no bridge-exposed preflight — the honest probe is a real 1px capture.
  const dir = await mkdtemp(join(tmpdir(), "bw-desktop-preflight-"));
  const probe = join(dir, "probe.png");
  try {
    await exec("screencapture", ["-x", "-C", "-R", "0,0,1,1", "-t", "png", probe]);
    await readFile(probe);
  } catch (err) {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      "macOS Screen Recording permission is not granted, so the desktop session could not take screenshots",
      {
        kind: "desktop_permission_missing",
        permission: "screen_recording",
        detail: err instanceof Error ? err.message : String(err),
      },
      SCREEN_RECORDING_HINT,
    );
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  // A second monitor is invisible to the agent: the driver captures and clicks the MAIN display
  // only. Say so once at open, so an operator watching the wrong screen isn't left guessing.
  if (await hasSecondDisplay(exec)) {
    log.warn("desktop_multiple_displays", {
      note: "the agent sees and clicks the MAIN display only; other monitors are not captured",
    });
  }
}

/** Whether a second display is attached — probed with the same `screencapture` we already depend on
 *  (`-D 2` addresses the second display and fails when there isn't one). */
async function hasSecondDisplay(exec: DarwinExec): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), "bw-desktop-displays-"));
  try {
    await exec("screencapture", [
      "-x",
      "-D",
      "2",
      "-R",
      "0,0,1,1",
      "-t",
      "png",
      join(dir, "d2.png"),
    ]);
    await readFile(join(dir, "d2.png"));
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The main display's size in CG POINTS (what CGEvent coordinates are in). */
async function displayPoints(exec: DarwinExec): Promise<{ width: number; height: number }> {
  const out = await jxa(
    exec,
    "ObjC.import('CoreGraphics'); const b = $.CGDisplayBounds($.CGMainDisplayID()); `${b.size.width}x${b.size.height}`",
  );
  const [w, h] = out.split("x").map((n) => Number(n));
  if (w === undefined || h === undefined || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0) {
    throw new AppError(
      ErrorCode.INTERNAL_ERROR,
      `could not read the macOS display size (got "${out}")`,
    );
  }
  return { width: w, height: h };
}

/** The macOS driver. `exec` is injectable for tests. */
export function makeDarwinDriver(exec: DarwinExec = defaultExec): DesktopDriver {
  // Points-per-pixel, learned from the first screenshot (Retina = 0.5). Until then, assume 1:1 —
  // every coordinate call happens after a screenshot in practice (the model must see to click).
  let pointsPerPixel = 1;

  const toPoint = (value: number): number => Math.round(value * pointsPerPixel);

  const post = (script: string): Promise<string> =>
    jxa(exec, `ObjC.import('CoreGraphics');${script}`);

  return {
    async screenshot(): Promise<DesktopScreenshotCapture> {
      const dir = await mkdtemp(join(tmpdir(), "bw-desktop-shot-"));
      const file = join(dir, "shot.png");
      try {
        // -x: no shutter sound. -C: include the cursor, so the model sees where the pointer is.
        await exec("screencapture", ["-x", "-C", "-t", "png", file]);
        const png = await readFile(file);
        const { width, height } = pngSize(png);
        const points = await displayPoints(exec);
        pointsPerPixel = width > 0 ? points.width / width : 1;
        return { png, width, height };
      } catch (err) {
        throw new AppError(
          ErrorCode.INTERNAL_ERROR,
          `macOS screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
          { kind: "desktop_screenshot_failed" },
          SCREEN_RECORDING_HINT,
        );
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },

    async click(input: DesktopClick): Promise<void> {
      const x = toPoint(input.x);
      const y = toPoint(input.y);
      const button = input.button ?? "left";
      // CGEvent button types: left down/up 1/2, right 3/4, other 25/26; button number 0/1/2.
      const [downType, upType, buttonNumber] =
        button === "right" ? [3, 4, 1] : button === "middle" ? [25, 26, 2] : [1, 2, 0];
      const clicks = input.clicks ?? 1;
      await post(
        `const p = {x: ${String(x)}, y: ${String(y)}};` +
          `for (let i = 1; i <= ${String(clicks)}; i++) {` +
          `const d = $.CGEventCreateMouseEvent(null, ${String(downType)}, p, ${String(buttonNumber)});` +
          `$.CGEventSetIntegerValueField(d, 1, i);$.CGEventPost($.kCGHIDEventTap, d);` +
          `const u = $.CGEventCreateMouseEvent(null, ${String(upType)}, p, ${String(buttonNumber)});` +
          `$.CGEventSetIntegerValueField(u, 1, i);$.CGEventPost($.kCGHIDEventTap, u);}` +
          `'ok'`,
      );
    },

    async type(input: { text: string; submit?: boolean }): Promise<void> {
      if (input.text.length > 0) {
        // CGEventKeyboardSetUnicodeString types ANY text without a keycode map (accents, emoji).
        // Chunked: the API takes a bounded UniChar buffer per event.
        for (const part of chunkText(input.text, 20)) {
          await post(
            `const e = $.CGEventCreateKeyboardEvent(null, 0, true);` +
              `$.CGEventKeyboardSetUnicodeString(e, ${String(part.length)}, ${JSON.stringify(part)});` +
              `$.CGEventPost($.kCGHIDEventTap, e);'ok'`,
          );
        }
      }
      if (input.submit === true) await this.key("Return");
    },

    async key(chord: string): Promise<void> {
      const { flags, keyCode } = parseDarwinChord(chord);
      await post(
        `const d = $.CGEventCreateKeyboardEvent(null, ${String(keyCode)}, true);` +
          `$.CGEventSetFlags(d, ${String(flags)});$.CGEventPost($.kCGHIDEventTap, d);` +
          `const u = $.CGEventCreateKeyboardEvent(null, ${String(keyCode)}, false);` +
          `$.CGEventSetFlags(u, ${String(flags)});$.CGEventPost($.kCGHIDEventTap, u);'ok'`,
      );
    },

    async scroll(input: DesktopScroll): Promise<void> {
      if (input.x !== undefined && input.y !== undefined) {
        await post(
          `const m = $.CGEventCreateMouseEvent(null, 5, {x: ${String(toPoint(input.x))}, y: ${String(toPoint(input.y))}}, 0);` +
            `$.CGEventPost($.kCGHIDEventTap, m);'ok'`,
        );
      }
      // Pixel-unit scroll: negative dy scrolls content down, matching the SDK's positive-dy-is-down.
      await post(
        `const e = $.CGEventCreateScrollWheelEvent2(null, $.kCGScrollEventUnitPixel, 2, ${String(-Math.round(input.dy))}, ${String(-Math.round(input.dx))}, 0);` +
          `$.CGEventPost($.kCGHIDEventTap, e);'ok'`,
      );
    },

    async drag(input: {
      from: { x: number; y: number };
      to: { x: number; y: number };
    }): Promise<void> {
      const from = { x: toPoint(input.from.x), y: toPoint(input.from.y) };
      const to = { x: toPoint(input.to.x), y: toPoint(input.to.y) };
      // Press, a few interpolated drag events (apps ignore a teleporting drag), release.
      await post(
        `const a = {x: ${String(from.x)}, y: ${String(from.y)}}, b = {x: ${String(to.x)}, y: ${String(to.y)}};` +
          `const down = $.CGEventCreateMouseEvent(null, 1, a, 0);$.CGEventPost($.kCGHIDEventTap, down);` +
          `for (let i = 1; i <= 10; i++) {` +
          `const p = {x: a.x + (b.x - a.x) * i / 10, y: a.y + (b.y - a.y) * i / 10};` +
          `const m = $.CGEventCreateMouseEvent(null, 6, p, 0);$.CGEventPost($.kCGHIDEventTap, m);}` +
          `const up = $.CGEventCreateMouseEvent(null, 2, b, 0);$.CGEventPost($.kCGHIDEventTap, up);'ok'`,
      );
      log.debug("desktop_drag_posted", { from, to });
    },
  };
}

/** Split a string into chunks of at most `size` UTF-16 units. */
function chunkText(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** Read a PNG's pixel dimensions from its IHDR (bytes 16-24). */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) {
    throw new AppError(ErrorCode.INTERNAL_ERROR, "macOS screenshot was not a PNG");
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
