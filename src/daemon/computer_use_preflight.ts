// SPDX-License-Identifier: Apache-2.0

// Startup check for computer use on a `--host` macOS runner (COMPUTER_USE_SESSION.md §6.2).
//
// Both macOS permissions fail SILENTLY at the OS level — Accessibility lets input posts "succeed"
// while the system swallows them, and without Screen Recording `screencapture` simply refuses — so
// an operator who enabled a tier learns nothing until a run is already mid-flight. This reports the
// gaps at `runner start`, when they are still cheap to fix.
//
// It does NOT exit: the machine still serves every workflow that doesn't open a computer-use
// session, and a runner that refuses to start would be a worse failure than the one it is warning
// about. Container mode is exempt (the run gets its own in-container display, never the Mac's).

import { browserTierEnabled } from "../runtime/browser_session_backend.js";
import { desktopTierEnabled } from "../runtime/desktop_driver.js";
import {
  checkDarwinPermissions,
  type DarwinPermissions,
} from "../runtime/desktop_driver_darwin.js";

/** What the enabled tiers actually need from the OS. */
export interface RequiredPermissions {
  accessibility: boolean;
  screenRecording: boolean;
}

/**
 * Which permissions the enabled tiers need. The desktop tier needs both (it injects input and takes
 * screenshots). The browser tier drives Chrome over CDP, so it needs neither by itself — but session
 * recording captures the screen, so any enabled tier needs Screen Recording unless recording is off.
 */
export function requiredPermissions(env: NodeJS.ProcessEnv): RequiredPermissions | null {
  const desktop = desktopTierEnabled(env);
  const browser = browserTierEnabled(env);
  if (!desktop && !browser) return null;
  const recording = env.BOARDWALK_RECORDING_ENABLED !== "0";
  return { accessibility: desktop, screenRecording: desktop || recording };
}

/** The report lines for a startup check: empty when nothing is missing. */
export function permissionReport(required: RequiredPermissions, held: DarwinPermissions): string[] {
  const missing: string[] = [];
  if (required.accessibility && !held.accessibility) {
    missing.push(
      "  Accessibility     clicks and keystrokes will be silently swallowed by macOS\n" +
        "                    System Settings > Privacy & Security > Accessibility",
    );
  }
  if (required.screenRecording && !held.screenRecording) {
    missing.push(
      "  Screen Recording  screenshots and session recording will fail\n" +
        "                    System Settings > Privacy & Security > Screen Recording",
    );
  }
  if (missing.length === 0) return [];
  return [
    "Computer use is enabled on this runner, but macOS has not granted it:\n",
    ...missing.map((m) => `${m}\n`),
    "\nGrant these to the app that launched this runner (Terminal, iTerm, ...), then restart it.\n" +
      "Runs that do not open a computer-use session are unaffected.\n",
  ];
}

/**
 * Report missing macOS permissions at `runner start`. No-op off darwin, in container mode, or when
 * no computer-use tier is enabled. Never throws and never exits — a probe failure just stays quiet.
 */
export async function reportComputerUsePermissions(opts: {
  mode: "container" | "host";
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  platform?: NodeJS.Platform;
  check?: typeof checkDarwinPermissions;
}): Promise<void> {
  if ((opts.platform ?? process.platform) !== "darwin") return;
  if (opts.mode !== "host") return;
  const required = requiredPermissions(opts.env);
  if (required === null) return;
  try {
    const held = await (opts.check ?? checkDarwinPermissions)();
    for (const line of permissionReport(required, held)) opts.log(line);
  } catch {
    // A probe that cannot run is not worth blocking a start over; the session-open preflight
    // remains the authoritative gate.
  }
}
