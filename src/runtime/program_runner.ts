// WorkflowProgramRunner — executes a workflow program (the JS-body model, the workflow runtime design).
//
// A run is the execution of a built program ARTIFACT: the worker is handed the VERIFIED tarball
// (its sha256 already checked against the pinned digest by the orchestrator) plus the entry module
// name. This module is the mechanism: it installs the host adapter + trigger payload onto the
// `@boardwalk-labs/workflow` singleton, extracts the artifact into a unique temp dir under the
// program root, chdirs to the workspace, and dynamic-imports the entry so the program's body runs. The
// program's `import { agent, sleep, … } from "@boardwalk-labs/workflow"` resolves to the SAME package
// instance the host was installed on (one instance per process), so the hooks reach our adapter.
//
// The artifact is already BUILT JS (the CLI esbuild-bundles packages; the api-server type-strips
// single files) — so the worker NEVER transpiles and NEVER installs. It only extracts + imports.
// `@boardwalk-labs/workflow` is left external in the bundle, so the imported program resolves it to the SDK
// package present in the worker image (giving up its own copy would break the dual-adapter).
//
// Two places, both explicit, neither derived from `process.cwd()` (docs/WORKSPACE_PERSISTENCE.md I1/I2):
//   - `workspaceRoot` — the run's `/workspace`. The working directory + HOME for AUTHOR code, so a
//     relative write is the correct write and lands in what `workspace.persist` archives.
//   - `programRoot`   — where the artifact extracts (`<programRoot>/.bw-runs/<runId>-<uuid>`). Must be
//     OUTSIDE the workspace, or the bundle rides into every snapshot and accumulates across runs.
// The extracted tree needs no node_modules-reachable ancestor: `ensureSdkLink` (below) links the SDK
// into the exec dir, so the bare `@boardwalk-labs/workflow` import resolves from any root.
//
// Durability: the body runs once, in-process. `sleep`/`workflows.call` hold in-process via the host
// (no checkpoint, no exit). A crash mid-run restarts the run from the top (handled by the
// worker/scheduler-sweep, not here). Output capture is deferred (v0 returns null).

import { mkdir, writeFile, rm, symlink, lstat } from "node:fs/promises";
import { dirname, join, isAbsolute, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  installHost,
  installInput,
  installConfig,
  takeDeclaredOutput,
  resetRuntime,
} from "@boardwalk-labs/workflow/runtime";
import type { WorkflowHost, JsonValue } from "@boardwalk-labs/workflow/runtime";
import { AppError, ErrorCode, createLogger } from "./support/index.js";

const log = createLogger("ProgramRunner");

/** Subdirectory (under the work root) that holds transient extracted program trees. */
const RUN_DIR = ".bw-runs";

/**
 * Link THIS runtime's `@boardwalk-labs/workflow` into the exec dir's `node_modules` so the program's
 * bare import resolves from ANY program root — this link, not an ancestor `node_modules`, is what
 * makes resolution work. (Worth stating plainly: a stale comment claiming the extraction dir had to
 * sit under `/app` so the import could walk up to `/app/node_modules` outlived this function by
 * several versions and sent a later reader chasing a dependency that no longer exists. The live
 * fleet has no `/app` at all and resolves fine.) A symlink — not a copy — is load-bearing: Node
 * resolves it to the REAL path, so the program gets the same module instance the host adapter was
 * installed on (the singleton contract). `junction` covers Windows without elevation; a failed link
 * is only logged, since a resolvable ancestor may still exist.
 */
export async function ensureSdkLink(execDir: string): Promise<void> {
  // A program tarball that ships its own `node_modules/@boardwalk-labs/workflow` would shadow the
  // runtime's copy — the host adapter is installed on OUR instance, so the program's hooks would
  // silently throw "no host installed". Fail loudly instead of link-then-EEXIST-swallow. Only a
  // REAL entry is a vendored copy; a symlink is our own link (idempotent re-invocation), left be.
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
 * Enforce I2: the extracted program must not live inside the run's workspace. Incidental separation
 * is what broke before — the extraction root used to be `process.cwd()`, so it landed inside the
 * workspace on exactly the lanes whose cwd was already correct. Compares RESOLVED paths, and treats
 * "the workspace itself" as inside.
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
  /** Trigger payload exposed to the program as `import { input } from "@boardwalk-labs/workflow"`. */
  input: unknown;
  /** Experiment config exposed as `import { config } from "@boardwalk-labs/workflow"` ({} for non-eval).
   *  Arbitrary JSON from the run row; narrowed to the SDK's JsonValue at the installConfig boundary. */
  config: Record<string, unknown>;
}

export interface ProgramRunnerDeps {
  /** The host adapter the program's hooks delegate to (agent leaf, sleep hold, child calls, secrets). */
  host: WorkflowHost;
  /**
   * The run's `/workspace` — the working directory AND `HOME` for author code (I1). Must already
   * exist (the orchestrator's `ensureWorkspace` guarantees it); a missing workspace fails the run
   * loudly rather than silently running from wherever the process happened to start.
   */
  workspaceRoot: string;
  /**
   * Root the program artifact extracts under. MUST be outside {@link workspaceRoot} (I2) — enforced,
   * because a bundle inside the workspace is tarred into every pre-sleep snapshot and, since each
   * run's dir name is unique, accumulates there forever.
   */
  programRoot: string;
  /**
   * Extract a gzipped tar file into a directory (created already). System `tar` in production
   * (matches WorkspaceArchiver); injected in tests. The artifact's relative layout is preserved so
   * on-disk assets (markdown skills, templates) sit where the program expects them.
   */
  extract: (tgzPath: string, destDir: string) => Promise<void>;
  /**
   * Called once with the extracted program directory, right after the artifact is unpacked (before the
   * program body runs). The worker uses it to point the `agent()` leaf at the run's bundled files
   * (`<dir>/skills/<name>.md`). Optional — the local/test path may omit it.
   */
  onExtracted?: (programDir: string) => void;
  /**
   * Scrubs known secret values out of a string (the run's `SecretRedactor.redactText`). Applied to a
   * top-level throw's message before it is logged AND before it is returned to the worker — a program
   * that resolves a secret and then throws it in an error message must NOT land that secret raw in the
   * logs or the finalized run output. Defaults to identity (tests/local).
   */
  redactText?: (text: string) => string;
  /**
   * Called once with the program's declared output IFF the program called `output(value)` (so an
   * explicit `output(null)` still fires, but a program that never declared one does NOT). The worker
   * wires this to emit an `output` activity entry into the run's event log. Best-effort: it must not
   * throw (a telemetry hiccup can't change the run's result). Absent ⇒ no output entry.
   */
  onOutput?: (value: unknown) => void;
}

/** Terminal result of running a workflow program. `output` is what the program declared via
 *  `output(value)` (null when it never did); for a failure it's null and `error` is set. A waiting
 *  seam (sleep / humanInput / workflows.call) never surfaces here — it freezes with the VM or
 *  holds the process, and the body simply continues when the wait is over. */
export type ProgramResult =
  | { kind: "completed"; output: unknown }
  | { kind: "failed"; output: null; error: { code: string; message: string; hint?: string } };

/** An engine `EngineError` carries a one-line actionable `hint` alongside its message. It reaches us
 *  as a thrown value across the SDK/engine package boundary, so DUCK-TYPE it rather than `instanceof`
 *  (a dual-package copy of the class would defeat the check) — any thrown error carrying a non-empty
 *  string `hint` is surfaced. Without this the hint is dropped here, and on a hosted run there is no
 *  other place it could survive: the runner reports a failure as `{ code, message, hint? }` and the
 *  broker persists exactly that. */
function errorHint(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const hint: unknown = (err as { hint?: unknown }).hint;
  return typeof hint === "string" && hint !== "" ? hint : undefined;
}

/** A machine-readable error code shaped like one: SCREAMING_SNAKE, as an engine `EngineError.code`
 *  (`VALIDATION`, `PROVIDER_ERROR`, …) and a Node syscall error (`ENOENT`) both are. */
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * The SEMANTIC code of a thrown error, preferred over its class name. An engine `EngineError` carries
 * `code: "VALIDATION"`; reporting `err.name` instead surfaced the useless `"EngineError"` on every
 * hosted failure (and `"Error"` for anything else). Duck-typed for the same reason as {@link errorHint}.
 *
 * Two guards, because a thrown value is author-controlled: the SCREAMING_SNAKE shape keeps prose (or a
 * stray object field) out of a field the UI renders as a code, and the CALLER redacts the result — an
 * uppercase-alnum secret would satisfy the pattern, so the shape check is hygiene, not the boundary.
 */
function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code: unknown = (err as { code?: unknown }).code;
  return typeof code === "string" && ERROR_CODE_RE.test(code) ? code : undefined;
}

/**
 * Run a workflow program to completion. Installs the host + input, extracts the VERIFIED artifact +
 * dynamic-imports its entry (which runs the body), and returns the terminal result. Always tears the
 * runtime state down and removes the temp tree afterward.
 */
export async function runWorkflowProgram(
  args: RunProgramArgs,
  deps: ProgramRunnerDeps,
): Promise<ProgramResult> {
  const dir = join(deps.programRoot, RUN_DIR, `${args.runId}-${randomUUID()}`);

  installHost(deps.host);
  installInput(args.input);
  // The run row's config is arbitrary JSON (jsonb); it IS valid JSON, so narrow to the SDK's JsonValue.
  installConfig(args.config as Record<string, JsonValue>);
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
    // Make the bare `@boardwalk-labs/workflow` import resolve from ANY work root — hosted images
    // provide it via an ancestor node_modules, but a self-hosted daemon's workspace has none.
    await ensureSdkLink(dir);

    // Re-validate the entry here even though the control plane checked it at deploy: a self-hosted
    // runner may point at an arbitrary control plane, so refuse an entry that could escape the
    // extraction dir (absolute path or `..` segment) before importing it.
    const entryPath = resolveEntryPath(dir, args.entry);
    // Run the program body to its natural completion / failure. A waiting seam freezes with the
    // VM (snapshot substrate) or holds the process — either way the body's own await continues.
    return await runProgramBody(entryPath, deps);
  } catch (err) {
    const redactText = deps.redactText ?? ((s: string): string => s);
    // Redact BEFORE both sinks: the message can carry a secret the program resolved then threw.
    const message = redactText(err instanceof Error ? err.message : String(err));
    // The hint is author-facing guidance ("write `builtins: [...]`"); redact it too — it is built from
    // the same untrusted inputs as the message and could echo a resolved secret.
    const rawHint = errorHint(err);
    const hint = rawHint === undefined ? undefined : redactText(rawHint);
    // The error's own code when it has one ("VALIDATION"), else the class name ("Error"). Redacted
    // like the rest: it is read off an author-controlled throw, not trusted to be a literal.
    const rawCode = errorCode(err);
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
    resetRuntime();
    await rm(dir, { recursive: true, force: true }).catch((rmErr: unknown) => {
      log.warn("program_cleanup_failed", {
        runId: args.runId,
        error: rmErr instanceof Error ? rmErr.message : String(rmErr),
      });
    });
  }
}

/**
 * Import (= run) the program entry and capture its declared output. Resolves to a `completed`
 * result; a program failure THROWS and is handled by the caller. A unique dir per run gives a
 * fresh URL so the module cache never returns an already-run program; `@vite-ignore` keeps
 * vitest/vite from statically analyzing the runtime URL.
 *
 * The chdir to the workspace (I1) happens HERE, at the boundary where author code starts, and only
 * after the artifact is extracted from {@link ProgramRunnerDeps.programRoot} — so the program's
 * files land in the workspace while the bundle stays out of it. Module resolution is unaffected:
 * Node resolves file-relative (the entry is imported by absolute URL, the SDK via `ensureSdkLink`),
 * never cwd-relative. The engine's local path has run exactly this shape since dev-on-engine
 * (`boardwalk/src/run/child.ts`), and the self-hosted daemon spawns with the same cwd.
 */
async function runProgramBody(entryPath: string, deps: ProgramRunnerDeps): Promise<ProgramResult> {
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
  try {
    await import(/* @vite-ignore */ pathToFileURL(entryPath).href);
    // The program declares its result via `output(value)` (top-level code can't `return`); null when it
    // never called it. This becomes the run's persisted output + a `workflows.call` parent's value, and
    // (when actually declared) an `output` entry in the run's activity log.
    const declared = takeDeclaredOutput();
    if (declared !== null) deps.onOutput?.(declared.value);
    return { kind: "completed", output: declared !== null ? declared.value : null };
  } finally {
    // One run per process in production, so this matters for tests + the local/dev path — but a
    // function that permanently moves its caller's cwd is a trap either way. Best-effort: the caller's
    // dir may itself be gone, and that must not mask the run's real outcome.
    try {
      process.chdir(callerCwd);
    } catch {
      /* the caller's cwd vanished mid-run; nothing useful to do */
    }
  }
}
