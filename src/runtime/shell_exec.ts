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

import { exec } from "node:child_process";
import { isAbsolute, join } from "node:path";
import type { ShellResult } from "@boardwalk-labs/workflow/runtime";
import { throwIfAborted } from "./run_abort.js";

/** Default cap on captured stdout/stderr bytes (matches the SDK's documented 16 MiB). */
export const SHELL_DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

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
    const child = exec(
      cmd,
      {
        cwd,
        env: opts?.env === undefined ? process.env : { ...process.env, ...opts.env },
        encoding: "utf8",
        ...(opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
        maxBuffer: opts?.maxBuffer ?? SHELL_DEFAULT_MAX_BUFFER,
        // Kill with SIGTERM first (the Node default is SIGTERM; make it explicit for the
        // 128+signum mapping below).
        killSignal: "SIGTERM",
      },
      (err, stdout, stderr) => {
        if (deps.signal !== undefined) deps.signal.removeEventListener("abort", onAbort);
        if (aborted) {
          try {
            throwIfAborted(deps.signal);
            reject(new Error("shell command aborted"));
          } catch (abortErr) {
            reject(abortErr instanceof Error ? abortErr : new Error(String(abortErr)));
          }
          return;
        }
        if (err === null) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        // A numeric code is the command's own non-zero exit — resolved, never thrown.
        // (`ExecException.code` is typed number, but Node also reuses the field for string
        // error codes like ERR_CHILD_PROCESS_STDIO_MAXBUFFER — hence the runtime check.)
        const code: unknown = err.code;
        if (typeof code === "number") {
          resolve({ exitCode: code, stdout, stderr });
          return;
        }
        // Killed by the timeout (or an external signal): resolve with the shell's 128+signum
        // convention so a timed-out command is still data to branch on.
        const signal: unknown = err.signal;
        if (typeof signal === "string" && signal.length > 0) {
          resolve({ exitCode: SIGNAL_EXIT_CODES[signal] ?? 128, stdout, stderr });
          return;
        }
        // Could not run at all (spawn failure, exceeded maxBuffer, …) — the one reject lane.
        reject(err);
      },
    );
    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      child.kill("SIGTERM");
    };
    if (deps.signal !== undefined) deps.signal.addEventListener("abort", onAbort, { once: true });
  });
}
