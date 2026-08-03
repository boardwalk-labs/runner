// SPDX-License-Identifier: Apache-2.0

// The desktop tier's OS driver: screenshot + raw-coordinate input injection, one thin per-OS
// implementation behind DesktopDriver (COMPUTER_USE_SESSION.md §6.2). Linux (hosted microVM +
// self-hosted) drives XTEST via xdotool and grabs frames with the image's ffmpeg; macOS/Windows
// drivers land with self-hosted parity. Selected by platform, gated by BOARDWALK_DESKTOP_TIER=1.

import { execFile } from "node:child_process";
import { createLogger } from "./support/index.js";

const log = createLogger("desktop_driver");

/** True when the runner image declares the desktop tier present (BOARDWALK_DESKTOP_TIER=1). */
export function desktopTierEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.BOARDWALK_DESKTOP_TIER === "1";
}

export interface GuestDesktopConfig {
  display: string;
  screenWidth: number;
  screenHeight: number;
}

/** Read the guest desktop config from env, or null when the tier is disabled or unsupported here. */
export function loadGuestDesktopConfig(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): GuestDesktopConfig | null {
  if (!desktopTierEnabled(env)) return null;
  if (platform !== "linux") {
    // The macOS (CGEvent/ScreenCaptureKit) and Windows (SendInput/DXGI) drivers are not built yet.
    log.warn("desktop_tier_unsupported_platform", { platform });
    return null;
  }
  return {
    display: env.DISPLAY?.trim() || ":0",
    screenWidth: positiveIntFromEnv(env.BOARDWALK_SCREEN_WIDTH, 1280),
    screenHeight: positiveIntFromEnv(env.BOARDWALK_SCREEN_HEIGHT, 800),
  };
}

function positiveIntFromEnv(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export interface DesktopScreenshotCapture {
  png: Buffer;
  width: number;
  height: number;
}

export interface DesktopClick {
  x: number;
  y: number;
  button?: "left" | "right" | "middle";
  clicks?: 1 | 2;
}

export interface DesktopScroll {
  dx: number;
  dy: number;
  x?: number;
  y?: number;
}

/** One screen's input + capture surface. Coordinates are screen pixels, origin top-left; every
 *  implementation clamps into the screen bounds rather than erroring on an off-by-a-few click. */
export interface DesktopDriver {
  screenshot(): Promise<DesktopScreenshotCapture>;
  click(input: DesktopClick): Promise<void>;
  type(input: { text: string; submit?: boolean }): Promise<void>;
  key(chord: string): Promise<void>;
  scroll(input: DesktopScroll): Promise<void>;
  drag(input: { from: { x: number; y: number }; to: { x: number; y: number } }): Promise<void>;
}

/** Exec seam for tests: run a binary to completion, resolve stdout, reject on non-zero exit. */
export type DriverExec = (cmd: string, args: readonly string[]) => Promise<Buffer>;

const SCREENSHOT_MAX_BUFFER = 32 * 1024 * 1024;

function defaultExec(display: string): DriverExec {
  return (cmd, args) =>
    new Promise<Buffer>((resolve, reject) => {
      execFile(
        cmd,
        [...args],
        {
          env: { ...process.env, DISPLAY: display },
          encoding: "buffer",
          maxBuffer: SCREENSHOT_MAX_BUFFER,
        },
        (err, stdout, stderr) => {
          if (err !== null) {
            const detail = stderr.toString("utf8").trim();
            reject(new Error(`${cmd} failed: ${detail.length > 0 ? detail : err.message}`));
            return;
          }
          resolve(stdout);
        },
      );
    });
}

const XDOTOOL_BUTTONS: Record<"left" | "middle" | "right", string> = {
  left: "1",
  middle: "2",
  right: "3",
};

/** SDK chord tokens → xdotool/X keysym names. Unknown tokens pass through verbatim (xdotool
 *  accepts raw keysyms), so authors can always reach an unmapped key. */
const KEY_TOKEN_MAP: Readonly<Record<string, string>> = {
  control: "ctrl",
  ctrl: "ctrl",
  meta: "super",
  cmd: "super",
  command: "super",
  super: "super",
  win: "super",
  alt: "alt",
  option: "alt",
  shift: "shift",
  enter: "Return",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  space: "space",
  backspace: "BackSpace",
  delete: "Delete",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "Prior",
  pagedown: "Next",
};

/** A `+`-joined SDK chord ("Control+Shift+t", "Meta+a") in xdotool syntax ("ctrl+shift+t"). */
export function chordToXdotool(chord: string): string {
  return chord
    .split("+")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => KEY_TOKEN_MAP[token.toLowerCase()] ?? token)
    .join("+");
}

/** Pixels of scroll delta per wheel notch, and the per-call notch ceiling. */
const SCROLL_PX_PER_NOTCH = 60;
const SCROLL_MAX_NOTCHES = 50;

/** A scroll delta in wheel notches: at least 1 for any non-zero delta, capped. */
export function scrollNotches(delta: number): number {
  return Math.min(
    SCROLL_MAX_NOTCHES,
    Math.max(1, Math.round(Math.abs(delta) / SCROLL_PX_PER_NOTCH)),
  );
}

/**
 * The Linux driver: xdotool (XTEST) for input, the image's ffmpeg (one-frame x11grab) for
 * screenshots — both already in the hosted guest image. `exec` is injectable for tests.
 */
export function makeXdotoolDriver(cfg: GuestDesktopConfig, exec?: DriverExec): DesktopDriver {
  const run = exec ?? defaultExec(cfg.display);
  const clampX = (x: number): string =>
    String(Math.min(Math.max(Math.floor(x), 0), cfg.screenWidth - 1));
  const clampY = (y: number): string =>
    String(Math.min(Math.max(Math.floor(y), 0), cfg.screenHeight - 1));

  return {
    async screenshot(): Promise<DesktopScreenshotCapture> {
      const png = await run("ffmpeg", [
        "-loglevel",
        "error",
        "-f",
        "x11grab",
        "-video_size",
        `${String(cfg.screenWidth)}x${String(cfg.screenHeight)}`,
        "-i",
        cfg.display,
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "pipe:1",
      ]);
      return { png, width: cfg.screenWidth, height: cfg.screenHeight };
    },

    async click(input: DesktopClick): Promise<void> {
      const button = XDOTOOL_BUTTONS[input.button ?? "left"];
      const clickArgs =
        input.clicks === 2
          ? ["click", "--repeat", "2", "--delay", "50", button]
          : ["click", button];
      await run("xdotool", ["mousemove", "--sync", clampX(input.x), clampY(input.y), ...clickArgs]);
    },

    async type(input: { text: string; submit?: boolean }): Promise<void> {
      if (input.text.length > 0) {
        await run("xdotool", ["type", "--delay", "12", "--", input.text]);
      }
      if (input.submit === true) {
        await run("xdotool", ["key", "--clearmodifiers", "Return"]);
      }
    },

    async key(chord: string): Promise<void> {
      await run("xdotool", ["key", "--clearmodifiers", chordToXdotool(chord)]);
    },

    async scroll(input: DesktopScroll): Promise<void> {
      const position =
        input.x !== undefined && input.y !== undefined
          ? ["mousemove", "--sync", clampX(input.x), clampY(input.y)]
          : [];
      // Vertical first, then horizontal: wheel down=5 up=4, right=7 left=6.
      const wheels: string[] = [];
      if (input.dy !== 0) {
        wheels.push("click", "--repeat", String(scrollNotches(input.dy)), input.dy > 0 ? "5" : "4");
      }
      if (input.dx !== 0) {
        wheels.push("click", "--repeat", String(scrollNotches(input.dx)), input.dx > 0 ? "7" : "6");
      }
      if (position.length === 0 && wheels.length === 0) return;
      await run("xdotool", [...position, ...wheels]);
    },

    async drag(input: {
      from: { x: number; y: number };
      to: { x: number; y: number };
    }): Promise<void> {
      await run("xdotool", [
        "mousemove",
        "--sync",
        clampX(input.from.x),
        clampY(input.from.y),
        "mousedown",
        "1",
        "mousemove",
        "--sync",
        clampX(input.to.x),
        clampY(input.to.y),
        "mouseup",
        "1",
      ]);
    },
  };
}
