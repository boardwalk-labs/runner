// WorkflowProgramRunner — executes a workflow program (the workflow-format redesign, P3).
//
// A run is the execution of a built program ARTIFACT: the worker is handed the VERIFIED tarball
// (its sha256 already checked against the pinned digest by the orchestrator) plus the entry module
// name. This module is the mechanism, the runner side of the host protocol (P3.1):
//
//   1. Start the {@link WorkflowHostServer} on a Unix socket and export its path as
//      `BOARDWALK_HOST_SOCK` — the one env key the platform owns for the program's lifetime.
//   2. Extract the artifact into a unique temp dir under the program root, chdir to the workspace.
//   3. LOADER: connect the SDK's protocol client (the same `@boardwalk-labs/workflow` instance the
//      program will import — `ensureSdkLink` guarantees it), `bootstrap()` → `{input, context}`
//      (the client applies the schema-guided revival pass: a `date-time` field arrives as a
//      `Date`), dynamic-import the entry, and call its DEFAULT-EXPORT `run(input, context)` —
//      positional, Lambda-style; a `run()` declaring fewer params is fine.
//   4. Report the return via `reportReturn` — the server validates it against the stored
//      `output_schema` (mismatch ⇒ the run fails VALIDATION_FAILED) and `void` ⇒ `null`.
//
// Importing is no longer running: the entry's module body only DEFINES `run`; execution is the
// explicit call. The old module-body top-to-bottom execution path (ambient `input`, `output()`,
// the installHost singleton) is DELETED with the redesign — there is no other program shape.
//
// The artifact is already BUILT JS (the CLI bundles packages; the api-server type-strips single
// files) — the worker NEVER transpiles and NEVER installs. `@boardwalk-labs/workflow` is left
// external in the bundle and `ensureSdkLink` links THIS runtime's copy into the exec dir, so the
// program's capability imports share the loader's connected client (one module instance).
//
// Two places, both explicit, neither derived from `process.cwd()` (docs/WORKSPACE_PERSISTENCE.md
// I1/I2):
//   - `workspaceRoot` — the run's `/workspace`. The working directory + HOME for AUTHOR code.
//   - `programRoot`   — where the artifact extracts (`<programRoot>/.bw-runs/<runId>-<uuid>`),
//     OUTSIDE the workspace so the bundle never rides into a snapshot.
//
// Durability: `run()` executes once, in-process. Waiting seams (sleep / humanInput /
// workflows.call) hold or freeze inside the capability layer; a crash restarts the run from the
// top (handled by the worker/scheduler-sweep, not here).

import { mkdir, writeFile, rm, symlink, lstat } from "node:fs/promises";
import { dirname, join, isAbsolute, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  HOST_SOCK_ENV,
  HostError,
  connectHost,
  resetHost,
  type ContextData,
  type HostClient,
  type JsonValue,
} from "@boardwalk-labs/workflow/runtime";
import { OUTPUT_MISMATCH_HINT, WorkflowHostServer, type HostCapabilities } from "./host_server.js";
import { invokePythonProgram, isPythonEntry } from "./python_program.js";
import { AppError, ErrorCode, createLogger, errorCodeOf } from "./support/index.js";

const log = createLogger("ProgramRunner");

/** Subdirectory (under the work root) that holds transient extracted program trees. */
const RUN_DIR = ".bw-runs";

/**
 * Link THIS runtime's `@boardwalk-labs/workflow` into the exec dir's `node_modules` so the program's
 * bare import resolves from ANY program root — this link, not an ancestor `node_modules`, is what
 * makes resolution work. A symlink — not a copy — is load-bearing: Node resolves it to the REAL
 * path, so the program gets the same module instance the loader's protocol client was installed
 * on (the active-host singleton in the SDK's host_client). `junction` covers Windows without
 * elevation; a failed link is only logged, since a resolvable ancestor may still exist.
 */
export async function ensureSdkLink(execDir: string): Promise<void> {
  // A program tarball that ships its own `node_modules/@boardwalk-labs/workflow` would shadow the
  // runtime's copy — the loader's connected client lives on OUR instance, so the program's hooks
  // would open a SECOND lazy connection at best and fail at worst. Fail loudly instead of
  // link-then-EEXIST-swallow. Only a REAL entry is a vendored copy; a symlink is our own link
  // (idempotent re-invocation), left be.
  const linkPath = join(execDir, "node_modules", "@boardwalk-labs", "workflow");
  const existing = await lstat(linkPath).catch(() => null);
  if (existing !== null) {
    if (existing.isSymbolicLink()) return;
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      "Program bundles its own @boardwalk-labs/workflow; the runtime provides it (do not vendor it).",
    );
  }
  try {
    // Resolve via the MAIN entry (the SDK's export map exposes no "./package.json") and cut the
    // path back to the package root.
    const entry = createRequire(import.meta.url).resolve("@boardwalk-labs/workflow");
    const marker = join("node_modules", "@boardwalk-labs", "workflow");
    const idx = entry.lastIndexOf(marker);
    const sdkDir = idx === -1 ? dirname(dirname(entry)) : entry.slice(0, idx + marker.length);
    const scopeDir = join(execDir, "node_modules", "@boardwalk-labs");
    await mkdir(scopeDir, { recursive: true });
    await symlink(
      sdkDir,
      join(scopeDir, "workflow"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      log.warn("sdk_link_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
/** Resolve the program's entry module inside the extraction dir, refusing any path that escapes it.
 *  The control plane validates `entry` at deploy, but a self-hosted runner may be pointed at an
 *  arbitrary control plane, so this is defense-in-depth: an absolute path or a `..` that resolves
 *  outside `dir` throws rather than importing code from elsewhere on the machine. */
export function resolveEntryPath(dir: string, entry: string): string {
  const resolved = join(dir, ...entry.split("/"));
  const rel = relative(dir, resolved);
  if (isAbsolute(entry) || rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`)) {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      `Program entry "${entry}" escapes the program directory.`,
    );
  }
  return resolved;
}

/** Scratch filename for the in-flight artifact tarball inside a run's dir. */
const ARTIFACT_FILE = "__program.tgz";

/**
 * Enforce I2: the extracted program must not live inside the run's workspace. Compares RESOLVED
 * paths, and treats "the workspace itself" as inside.
 */
export function assertProgramRootOutsideWorkspace(
  programRoot: string,
  workspaceRoot: string,
): void {
  const rel = relative(resolve(workspaceRoot), resolve(programRoot));
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      `The program root "${programRoot}" is inside the workspace "${workspaceRoot}"; the extracted program must live outside it.`,
    );
  }
}

export interface RunProgramArgs {
  /** Run id — used for the temp dir path + correlation. */
  runId: string;
  /** The VERIFIED program artifact tarball (sha256 already checked against the pinned digest). */
  tarball: Uint8Array;
  /** Entry module to import after extraction (a safe relative POSIX path, e.g. `index.mjs`). */
  entry: string;
  /** The run's RAW JSON input (trigger payload / inline input). The revival pass is CLIENT-side. */
  input: unknown;
  /** The stored derived input schema (`null` for an untyped workflow) — carried on `bootstrap`
   *  so the SDK revives rich fields (`date-time` → `Date`, base64 → `Uint8Array`, …). */
  inputSchema: Record<string, unknown> | null;
  /** The stored derived output schema (`null` ⇒ the return persists unvalidated). */
  outputSchema: Record<string, unknown> | null;
  /** The context DATA for `bootstrap` (P3.3) — the client builds the live `Context` from it. */
  context: ContextData;
}

export interface ProgramRunnerDeps {
  /** The capability seam the host server dispatches onto (agent leaf, sleep hold, child calls,
   *  secrets, shell, usage, auth, browser, phase). */
  capabilities: HostCapabilities;
  /**
   * The run's `/workspace` — the working directory AND `HOME` for author code (I1). Must already
   * exist (the orchestrator's `ensureWorkspace` guarantees it); a missing workspace fails the run
   * loudly rather than silently running from wherever the process happened to start.
   */
  workspaceRoot: string;
  /**
   * Root the program artifact extracts under. MUST be outside {@link workspaceRoot} (I2) —
   * enforced, because a bundle inside the workspace is tarred into every pre-sleep snapshot.
   */
  programRoot: string;
  /**
   * Extract a gzipped tar file into a directory (created already). System `tar` in production
   * (matches WorkspaceArchiver); injected in tests.
   */
  extract: (tgzPath: string, destDir: string) => Promise<void>;
  /**
   * Called once with the extracted program directory, right after the artifact is unpacked
   * (before `run()` is invoked). The worker uses it to point the `agent()` leaf at the run's
   * bundled files (`<dir>/skills/<name>.md`).
   */
  onExtracted?: (programDir: string) => void;
  /**
   * Scrubs known secret values out of a string (the run's `SecretRedactor.redactText`). Applied
   * to a thrown error's message/code/hint before logging + finalize. Defaults to identity.
   */
  redactText?: (text: string) => string;
  /**
   * Called once with the run's reported return IFF it is non-null (a void return sends null,
   * which is not an author-declared output). The worker wires this to emit an `output` activity
   * entry into the run's event log. Best-effort: it must not throw.
   */
  onOutput?: (value: unknown) => void;
  /**
   * The run's cooperative-cancellation signal. The host server pushes the `cancel` notification
   * to the program when it fires (the SDK aborts `context.signal`); the capability layer already
   * honors it server-side at every hook.
   */
  signal?: AbortSignal | undefined;
  /** Override the socket directory (tests). Default `os.tmpdir()` (short paths — sun_path cap). */
  sockDir?: string | undefined;
  /** Interpreter a `.py` entry is launched with (P5.5). Default `python3`, resolved on PATH —
   *  the base image bakes one CPython (P5.3). May be an absolute path. */
  pythonInterpreter?: string | undefined;
  /** How long after SIGTERM an aborted Python child gets before SIGKILL. Default 5s. */
  pythonKillGraceMs?: number | undefined;
}

/** Terminal result of running a workflow program. `output` is the validated value `run()`
 *  returned (`null` for void); for a failure it's null and `error` is set. A waiting seam never
 *  surfaces here — it freezes with the VM or holds the process, and `run()` simply continues. */
export type ProgramResult =
  | { kind: "completed"; output: unknown }
  | { kind: "failed"; output: null; error: { code: string; message: string; hint?: string } };

/** An engine `EngineError` carries a one-line actionable `hint` alongside its message. It reaches us
 *  as a thrown value across the SDK/engine package boundary, so DUCK-TYPE it rather than `instanceof`
 *  (a dual-package copy of the class would defeat the check) — any thrown error carrying a non-empty
 *  string `hint` is surfaced. A capability error that crossed the protocol carries its hint on
 *  `HostError.data.hint` (see host_server's protocolErrorOf), so that lane is read too — without it
 *  a hosted author would lose every engine hint to the wire. */
function errorHint(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const hint: unknown = (err as { hint?: unknown }).hint;
  if (typeof hint === "string" && hint !== "") return hint;
  const data: unknown = (err as { data?: unknown }).data;
  if (typeof data === "object" && data !== null) {
    const dataHint: unknown = (data as { hint?: unknown }).hint;
    if (typeof dataHint === "string" && dataHint !== "") return dataHint;
  }
  return undefined;
}

/**
 * Run a workflow program to completion: start the host-protocol server, extract the VERIFIED
 * artifact, drive the loader (`bootstrap` → import entry → `run(input, context)` →
 * `reportReturn`), and return the terminal result. Always tears the server + temp tree down.
 */
export async function runWorkflowProgram(
  args: RunProgramArgs,
  deps: ProgramRunnerDeps,
): Promise<ProgramResult> {
  const dir = join(deps.programRoot, RUN_DIR, `${args.runId}-${randomUUID()}`);
  const server = new WorkflowHostServer({
    capabilities: deps.capabilities,
    bootstrap: {
      // Boundary cast: the input arrived as JSON (the trigger payload / run row), so it is
      // wire-safe by construction.
      input: (args.input ?? null) as JsonValue,
      inputSchema: args.inputSchema,
      context: args.context,
    },
    outputSchema: args.outputSchema,
    signal: deps.signal,
    sockDir: deps.sockDir,
  });
  try {
    assertProgramRootOutsideWorkspace(deps.programRoot, deps.workspaceRoot);
    await mkdir(dir, { recursive: true });
    const tgzPath = join(dir, ARTIFACT_FILE);
    await writeFile(tgzPath, args.tarball);
    // Extract the built tree (entry + sourcemap + assets) preserving relative layout, then drop the
    // tarball so it isn't visible to the program.
    await deps.extract(tgzPath, dir);
    await rm(tgzPath, { force: true });
    // The bundled tree is now on disk — let the worker point the agent() leaf at `<dir>/skills/*.md`.
    deps.onExtracted?.(dir);
    // Language dispatch by entry extension (P5.5): a `.py` entry runs as a SUBPROCESS speaking
    // the same host protocol (`python -m boardwalk._loader <entry>`, provided by the image's
    // Python SDK — no JS SDK link to make); everything else keeps the in-process TS loader.
    const python = isPythonEntry(args.entry);
    // Make the bare `@boardwalk-labs/workflow` import resolve from ANY work root.
    if (!python) await ensureSdkLink(dir);
    // Re-validate the entry here even though the control plane checked it at deploy (defense-in-depth
    // for a self-hosted runner pointed at an arbitrary control plane).
    const entryPath = resolveEntryPath(dir, args.entry);

    const sockPath = await server.listen();
    // The ONE platform-owned env key a program keeps: how its SDK (and any subprocess speaking
    // the protocol) finds the host — the documented discovery contract. Removed in finally.
    process.env[HOST_SOCK_ENV] = sockPath;

    // Invoke run(input, context) to its natural completion / failure. A waiting seam freezes with
    // the VM (snapshot substrate) or holds the process — either way the await continues.
    return python
      ? await invokePythonProgram(entryPath, sockPath, server, deps)
      : await invokeProgram(entryPath, sockPath, server, deps);
  } catch (err) {
    const redactText = deps.redactText ?? ((s: string): string => s);
    // Redact BEFORE both sinks: the message can carry a secret the program resolved then threw.
    const message = redactText(err instanceof Error ? err.message : String(err));
    // The hint is author-facing guidance; redact it too — it is built from the same untrusted
    // inputs as the message and could echo a resolved secret.
    const rawHint = errorHint(err);
    const hint = rawHint === undefined ? undefined : redactText(rawHint);
    // The error's own code when it has one ("VALIDATION"), else the class name ("Error"). Redacted
    // like the rest: it is read off an author-controlled throw, not trusted to be a literal.
    const rawCode = errorCodeOf(err);
    const code =
      rawCode !== undefined
        ? redactText(rawCode)
        : err instanceof Error
          ? err.name
          : "PROGRAM_ERROR";
    log.error("program_failed", { runId: args.runId, error: message });
    return {
      kind: "failed",
      output: null,
      error: {
        code,
        message,
        ...(hint === undefined ? {} : { hint }),
      },
    };
  } finally {
    Reflect.deleteProperty(process.env, HOST_SOCK_ENV);
    // Clear the SDK's active-host singleton so a later run (tests; the local path) reconnects
    // fresh rather than reusing a client whose server is gone.
    resetHost();
    await server.close();
    await rm(dir, { recursive: true, force: true }).catch((rmErr: unknown) => {
      log.warn("program_cleanup_failed", {
        runId: args.runId,
        error: rmErr instanceof Error ? rmErr.message : String(rmErr),
      });
    });
  }
}

/**
 * The LOADER (P3.1): connect the protocol client, `bootstrap()`, import the entry, call its
 * default-export `run(input, context)`, and report the return. Resolves to a `completed` result;
 * a failure THROWS and is curated by the caller.
 *
 * The chdir to the workspace (I1) happens HERE, at the boundary where author code starts.
 * Module resolution is unaffected: Node resolves file-relative (the entry is imported by
 * absolute URL, the SDK via `ensureSdkLink`), never cwd-relative.
 */
async function invokeProgram(
  entryPath: string,
  sockPath: string,
  server: WorkflowHostServer,
  deps: ProgramRunnerDeps,
): Promise<ProgramResult> {
  const callerCwd = process.cwd();
  try {
    process.chdir(deps.workspaceRoot);
  } catch (err) {
    // Fail loud. Running author code from an arbitrary cwd is what silently threw writes away.
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      `The run's workspace "${deps.workspaceRoot}" is not usable as the working directory: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  let client: HostClient | null = null;
  try {
    // Connect eagerly and install as the SDK's active host: the program's capability imports
    // (same module instance, via ensureSdkLink) then share this client instead of lazily opening
    // a second connection.
    client = await connectHost({ sockPath });
    const { input, context } = await client.bootstrap();

    // A unique dir per run gives a fresh URL so the module cache never returns an already-loaded
    // program; `@vite-ignore` keeps vitest/vite from statically analyzing the runtime URL.
    const mod: unknown = await import(/* @vite-ignore */ pathToFileURL(entryPath).href);
    const runFn = (mod as { default?: unknown }).default;
    if (typeof runFn !== "function") {
      throw Object.assign(new Error("The workflow entry has no `run` function default export."), {
        code: "VALIDATION",
        hint: "Export the entry as `export default async function run(input, context) { … }`.",
      });
    }
    // Positional, Lambda-style: input = param 0, context = param 1; a run() declaring fewer
    // params simply ignores the rest.
    const value: unknown = await (runFn as (input: unknown, context: unknown) => unknown)(
      input,
      context,
    );
    try {
      await client.reportReturn(value);
    } catch (err) {
      if (err instanceof HostError && err.code === "VALIDATION_FAILED") {
        // Curate the schema mismatch: message = what's wrong (the server's detail), hint = what
        // to do. The failure code rides the HostError's own code.
        throw Object.assign(err, { hint: OUTPUT_MISMATCH_HINT });
      }
      throw err;
    }
    const output = server.reportedReturn();
    if (output !== null) deps.onOutput?.(output);
    return { kind: "completed", output };
  } finally {
    client?.close();
    // One run per process in production, so this matters for tests + the local path — but a
    // function that permanently moves its caller's cwd is a trap either way. Best-effort.
    try {
      process.chdir(callerCwd);
    } catch {
      /* the caller's cwd vanished mid-run; nothing useful to do */
    }
  }
}
