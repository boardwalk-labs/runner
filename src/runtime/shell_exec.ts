// SPDX-License-Identifier: Apache-2.0

// runShell — the host-side backing for the protocol's `shell` capability.
//
// The old SDK ran `execSync` inside the program process; under the host protocol the program is
// a protocol client, so the command runs HERE (same VM, same trust domain — the program layer is
// trusted) and the completed result crosses the wire. Contract (sdk shell.ts / protocol.ts):
// resolve `{exitCode, stdout, stderr}` — a non-zero exit RESOLVES (data to branch on, never
// thrown); only a command that could not run at all, an exceeded output buffer, or a cancelled
// run rejects. A command killed by the `timeoutMs` option resolves with the shell convention
// `128 + signal number` (SIGTERM ⇒ 143), the same exit code a shell would report.
//
// cwd defaults to the run's workspace root (the same dir `agent({ cwd })` resolves against);
// `env` merges OVER the process env — the author owns process.env outright, and platform
// credentials were scrubbed from it at bootstrap, so inheriting it leaks nothing.

import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import type { ShellResult } from "@boardwalk-labs/workflow/runtime";
import { throwIfAborted } from "./run_abort.js";

/** Default cap on captured stdout/stderr bytes (matches the SDK's documented 16 MiB). */
export const SHELL_DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

/** SIGKILL follows this long after a kill's SIGTERM if the process ignores it. */
const SHELL_KILL_GRACE_MS = 5_000;

const SIGNAL_EXIT_CODES: Record<string, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGKILL: 137,
  SIGTERM: 143,
};

export interface ShellExecOptions {
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  timeoutMs?: number | undefined;
  maxBuffer?: number | undefined;
}

export interface ShellExecDeps {
  /** The run's workspace root — the default cwd, and the base a relative `cwd` resolves against. */
  workspaceRoot: string;
  /** The run's cooperative-cancellation signal: an abort kills the command and REJECTS. */
  signal?: AbortSignal | undefined;
}

/** Run one shell command to completion (see the module header for the resolve/reject contract). */
export function runShell(
  cmd: string,
  opts: ShellExecOptions | undefined,
  deps: ShellExecDeps,
): Promise<ShellResult> {
  throwIfAborted(deps.signal);
  const cwd =
    opts?.cwd === undefined
      ? deps.workspaceRoot
      : isAbsolute(opts.cwd)
        ? opts.cwd
        : join(deps.workspaceRoot, opts.cwd);
  return new Promise<ShellResult>((resolve, reject) => {
    const child = spawn(cmd, {
      shell: true,
      cwd,
      env: opts?.env === undefined ? process.env : { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      // Own process GROUP: `sh -c` may not exec-optimize, leaving the real command a GRANDCHILD
      // holding the stdio pipes — killing only the shell would leak it and `close` would not
      // fire until the grandchild exits. Group-kill reaches the whole tree. (Lockstep with the
      // engine's src/run/shell_exec.ts.)
      detached: true,
    });
    const maxBuffer = opts?.maxBuffer ?? SHELL_DEFAULT_MAX_BUFFER;

    let stdout = "";
    let stderr = "";
    let settledReason: "timeout" | "maxBuffer" | "abort" | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;

    const killTree = (signal: NodeJS.Signals): void => {
      // Negative pid = the process group (see `detached`); fall back to the direct child when
      // the group is already gone.
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        child.kill(signal);
      }
    };
    const kill = (reason: "timeout" | "maxBuffer" | "abort"): void => {
      if (settledReason === null) settledReason = reason;
      killTree("SIGTERM");
      // A process ignoring SIGTERM still ends: SIGKILL after a short grace.
      graceTimer ??= setTimeout(() => {
        killTree("SIGKILL");
      }, SHELL_KILL_GRACE_MS);
      graceTimer.unref();
    };

    if (opts?.timeoutMs !== undefined) {
      killTimer = setTimeout(() => {
        kill("timeout");
      }, opts.timeoutMs);
    }

    const capture = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (next.length > maxBuffer) kill("maxBuffer"); // cap exceeded — stop the command, then reject
      return next.length > maxBuffer ? next.slice(0, maxBuffer) : next;
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = capture(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = capture(stderr, chunk);
    });

    const onAbort = (): void => {
      kill("abort");
    };
    if (deps.signal !== undefined) deps.signal.addEventListener("abort", onAbort, { once: true });

    const cleanup = (): void => {
      if (killTimer !== null) clearTimeout(killTimer);
      if (graceTimer !== null) clearTimeout(graceTimer);
      if (deps.signal !== undefined) deps.signal.removeEventListener("abort", onAbort);
    };

    child.on("error", (err) => {
      // The command could not run at all (e.g. no shell) — a rejecting case.
      cleanup();
      reject(err);
    });
    child.on("close", (code, signal) => {
      cleanup();
      if (settledReason === "abort") {
        try {
          throwIfAborted(deps.signal);
          reject(new Error("shell command aborted"));
        } catch (abortErr) {
          reject(abortErr instanceof Error ? abortErr : new Error(String(abortErr)));
        }
        return;
      }
      if (settledReason === "maxBuffer") {
        // The ratified contract: an exceeded output cap REJECTS (never a silently truncated
        // success). The message keeps node's conventional wording for greppability.
        reject(new Error(`shell output exceeded maxBuffer (${String(maxBuffer)} bytes)`));
        return;
      }
      if (code !== null) {
        resolve({ exitCode: code, stdout, stderr });
        return;
      }
      // Killed by the timeout (or an external signal): resolve with the shell's 128+signum
      // convention so a timed-out command is still data to branch on.
      if (signal !== null) {
        resolve({ exitCode: SIGNAL_EXIT_CODES[signal] ?? 128, stdout, stderr });
        return;
      }
      resolve({ exitCode: -1, stdout, stderr }); // neither code nor signal — Node says can't happen
    });
  });
}
