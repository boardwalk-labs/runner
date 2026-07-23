// SPDX-License-Identifier: Apache-2.0

// invokePythonProgram — the runner side of the Python program path (the workflow-format
// redesign, P5.5). A `.py` entry runs as a SUBPROCESS speaking the same host protocol the
// in-process TS loader speaks:
//
//     <python3> -m boardwalk._loader <absolute entry path>
//
// with cwd = the run's workspace and env = the worker's env plus `BOARDWALK_HOST_SOCK`
// (already set process-wide by the runner, re-stamped here explicitly), `HOME` = the workspace
// (the I1 convention the TS path lives under: the workspace IS cwd + HOME for author code), and
// `PYTHONUNBUFFERED=1` so the child's prints stream line-by-line instead of arriving in one
// buffered burst at exit. The loader module + the `boardwalk` package come from the runner
// IMAGE (P5.3: CPython in the base image, the SDK importable) — the runner installs nothing.
//
// LIFECYCLE + FAILURE CURATION (the module's real job — the loader deliberately reports no
// failure over the wire; see sdk-python's `_loader.py` docstring):
//   - The run COMPLETES when `report_return` landed — the host server already validated the
//     value against `output_schema` and holds it; the child's subsequent disconnect + exit is a
//     clean shutdown.
//   - A non-zero exit WITHOUT a reported return is a program failure. Preferred curation source:
//     the host server's recorded `report_return` failure (the schema-mismatch AppError with its
//     real VALIDATION_FAILED code — richer than the traceback the child printed for it). Else
//     the captured stderr TAIL: the Python traceback's final line (e.g. `ValueError: boom`) is
//     the message, code `PROGRAM_ERROR`. The caller (`runWorkflowProgram`'s catch) secret-redacts
//     message/code/hint through the run's redactor, same as every other failure.
//   - Exit 0 without a reported return is a loader-contract violation → a clear INTERNAL error.
//   - Run abort (cancel / credit) kills the child: SIGTERM, then SIGKILL after a grace — the
//     same cooperative-signal plumbing the shell executor uses, plus the escalation a whole
//     program process warrants.
//   - A missing interpreter fails CLOSED with an UNSUPPORTED-class message naming the image
//     expectation — never a cryptic ENOENT.
//
// The child's stdout/stderr ride the SAME program log capture the TS path uses: each complete
// line is re-emitted through the global `console` (`log` for stdout, `error` for stderr — the
// method-to-stream mapping program_log_capture.ts owns), which the worker patched via
// `captureConsole` for the program's duration. That one hop buys redaction, the CloudWatch
// print, the frame cap/truncation, and the `program_output` run-event — with zero new seams.

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { HOST_SOCK_ENV } from "@boardwalk-labs/workflow/runtime";
import { OUTPUT_MISMATCH_HINT, type WorkflowHostServer } from "./host_server.js";
import type { ProgramResult, ProgramRunnerDeps } from "./program_runner.js";
import { AppError, ErrorCode } from "./support/index.js";
import { throwIfAborted } from "./run_abort.js";

/** Default interpreter, resolved on PATH — the base image bakes one CPython (P5.3). */
export const DEFAULT_PYTHON_INTERPRETER = "python3";

/** The loader module the guest image's `boardwalk` package provides (`python -m <module> <entry>`). */
export const PYTHON_LOADER_MODULE = "boardwalk._loader";

/** How long after SIGTERM an aborted child gets before SIGKILL. */
export const DEFAULT_PYTHON_KILL_GRACE_MS = 5_000;

/** How many trailing stderr lines are kept for failure curation (the traceback tail). */
export const STDERR_TAIL_LINES = 20;

/** The language dispatch decision (P5.5): `.py` takes the subprocess path; everything else
 *  (`.ts`/`.js`/`.mjs`) keeps the in-process TS loader. Case-insensitive on the extension. */
export function isPythonEntry(entry: string): boolean {
  return entry.toLowerCase().endsWith(".py");
}

/** Split a piped stream into complete lines (LF or CRLF). `flush()` emits a trailing partial
 *  line (a crash mid-line must not swallow the last words of the traceback). */
export function lineSplitter(onLine: (line: string) => void): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let buffer = "";
  const emit = (line: string): void => {
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  };
  return {
    push(chunk: string): void {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        emit(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    },
    flush(): void {
      if (buffer !== "") emit(buffer);
      buffer = "";
    },
  };
}

/** What the child process ended as, for failure curation. */
export interface PythonExitFacts {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** The last {@link STDERR_TAIL_LINES} stderr lines, oldest first. */
  stderrTail: readonly string[];
}

/**
 * Curate a child that ended WITHOUT completing the loader contract (no `report_return`) into a
 * throwable the runner's failure path understands (`{code, message, hint}`, duck-typed). The
 * caller redacts — nothing here needs to.
 */
export function curatePythonFailure(facts: PythonExitFacts): Error {
  if (facts.exitCode === 0) {
    // Clean exit, no report: the loader contract was violated (an `os._exit(0)`/`sys.exit(0)`
    // before run() returned, or a program bypassing the loader). INTERNAL-class, but the hint
    // still tells an author what they most likely did.
    return Object.assign(
      new Error(
        "The Python program exited without reporting a result — the loader contract was not completed.",
      ),
      {
        code: "INTERNAL_ERROR",
        hint: "Return a value from run() (or None) instead of exiting the process early.",
      },
    );
  }
  // Non-zero / killed: the loader let the exception propagate, so the traceback's FINAL line
  // (`ValueError: boom`) names the error — that is the message. The full traceback already
  // streamed to the run log via the stderr capture.
  const lastLine = [...facts.stderrTail].reverse().find((line) => line.trim() !== "");
  if (lastLine !== undefined) {
    return Object.assign(new Error(lastLine), {
      code: "PROGRAM_ERROR",
      hint: "The full Python traceback is in the run log.",
    });
  }
  const ended =
    facts.signal !== null
      ? `was killed by ${facts.signal}`
      : `exited with code ${String(facts.exitCode ?? "unknown")}`;
  return Object.assign(new Error(`The Python program ${ended} without any error output.`), {
    code: "PROGRAM_ERROR",
  });
}

/** Fail CLOSED on a spawn failure: a missing interpreter gets an UNSUPPORTED-class error naming
 *  the image expectation instead of a bare ENOENT; anything else passes through untouched. */
export function curateSpawnFailure(interpreter: string, err: NodeJS.ErrnoException): Error {
  if (err.code !== "ENOENT") return err;
  return Object.assign(
    new Error(
      `This runner image has no "${interpreter}" interpreter, so a Python workflow cannot run on it.`,
    ),
    {
      code: "UNSUPPORTED_RUNTIME",
      hint:
        "Run Python workflows on an image that ships the Python runtime — the hosted " +
        "boardwalk/linux image does; a custom runs_on image must put python3 on PATH with the " +
        "boardwalk package importable.",
    },
  );
}

type SpawnOutcome =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "spawn_error"; error: NodeJS.ErrnoException };

/**
 * Run a Python workflow program to completion: spawn the loader subprocess against the already
 * -listening host server, stream its output into the program log capture, and read the terminal
 * state off the server once the child exits. Resolves `completed` when `report_return` landed;
 * THROWS on failure (the caller curates + redacts, same as the TS path).
 */
export async function invokePythonProgram(
  entryPath: string,
  sockPath: string,
  server: WorkflowHostServer,
  deps: ProgramRunnerDeps,
): Promise<ProgramResult> {
  throwIfAborted(deps.signal);
  // Fail loud on an unusable workspace BEFORE spawning: spawn reports a missing cwd as the same
  // ENOENT a missing interpreter gets, and that must not masquerade as "no Python on this image".
  // (Parity with the TS path's chdir guard, which fails the run with the same message shape.)
  const ws = await stat(deps.workspaceRoot).catch(() => null);
  if (ws === null || !ws.isDirectory()) {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      `The run's workspace "${deps.workspaceRoot}" is not usable as the working directory: not a directory`,
    );
  }

  const interpreter = deps.pythonInterpreter ?? DEFAULT_PYTHON_INTERPRETER;
  const child = spawn(interpreter, ["-m", PYTHON_LOADER_MODULE, entryPath], {
    cwd: deps.workspaceRoot,
    env: {
      ...process.env,
      [HOST_SOCK_ENV]: sockPath,
      HOME: deps.workspaceRoot,
      PYTHONUNBUFFERED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Line-buffered piping into the program log capture (see the module header): stdout lines via
  // console.log, stderr lines via console.error — the patched console redacts, prints, caps, and
  // emits the `program_output` frame. Stderr also feeds the curation tail.
  const stderrTail: string[] = [];
  const stdoutLines = lineSplitter((line) => {
    console.log(line);
  });
  const stderrLines = lineSplitter((line) => {
    stderrTail.push(line);
    if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    console.error(line);
  });
  if (child.stdout !== null) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutLines.push(chunk);
    });
  }
  if (child.stderr !== null) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrLines.push(chunk);
    });
  }

  // Run abort (cancel / credit exhaustion) kills the child: SIGTERM first (Python raises it as a
  // clean KeyboardInterrupt-style teardown), SIGKILL after a grace for a child that ignores it.
  let killTimer: NodeJS.Timeout | null = null;
  const graceMs = deps.pythonKillGraceMs ?? DEFAULT_PYTHON_KILL_GRACE_MS;
  const onAbort = (): void => {
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, graceMs);
    killTimer.unref();
  };
  deps.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    // `close` (not `exit`) so both stdio pipes have drained — the last stderr lines are in the
    // tail before curation reads it. A spawn failure emits `error` and may never emit `close`.
    const outcome = await new Promise<SpawnOutcome>((resolve) => {
      child.once("error", (error: NodeJS.ErrnoException) => {
        resolve({ kind: "spawn_error", error });
      });
      child.once("close", (code, signal) => {
        resolve({ kind: "exit", code, signal });
      });
    });
    stdoutLines.flush();
    stderrLines.flush();

    if (outcome.kind === "spawn_error") throw curateSpawnFailure(interpreter, outcome.error);

    // An aborted run supersedes whatever the child's exit looked like (we killed it): throw the
    // signal's own RunAbortedError so the reason propagates; the orchestrator's post-body
    // `signal.aborted` check is authoritative for the terminal write either way.
    throwIfAborted(deps.signal);

    if (server.hasReturn()) {
      // The run completed when report_return landed — the server validated + persisted the
      // value; the child disconnecting and exiting afterwards is its clean shutdown.
      const output = server.reportedReturn();
      if (output !== null) deps.onOutput?.(output);
      return { kind: "completed", output };
    }

    // No return reported. A recorded report_return failure (the output-schema mismatch) is a
    // richer curation source than the traceback the child printed for it: the real
    // VALIDATION_FAILED code + the server's own detail, with the same hint the TS loader adds.
    const recorded = server.reportReturnFailure();
    if (recorded !== null) {
      const carried = recorded as { code?: unknown; hint?: unknown };
      if (carried.code === ErrorCode.VALIDATION_FAILED.valueOf() && carried.hint === undefined) {
        Object.assign(recorded, { hint: OUTPUT_MISMATCH_HINT });
      }
      throw recorded;
    }
    throw curatePythonFailure({ exitCode: outcome.code, signal: outcome.signal, stderrTail });
  } finally {
    deps.signal?.removeEventListener("abort", onAbort);
    if (killTimer !== null) clearTimeout(killTimer);
    // Never leak the subprocess past the run, whatever path threw above (kill after exit no-ops).
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}
