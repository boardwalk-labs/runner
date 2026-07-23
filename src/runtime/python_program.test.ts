// Tests for the Python program path (P5.5): the language dispatch, the spawn contract, the
// failure curation, and the abort kill — end to end where possible.
//
// NO cross-repo dependency: the protocol is plain NDJSON JSON-RPC, so the integration tests run
// a MINIMAL stdlib-only stub of `boardwalk._loader` (src/runtime/testdata/pyloader). The runner
// OWNS the child's PYTHONPATH (the ratified artifact layout: `.bw-src` sources + `.bw-machine/
// site-packages` deps — inherited values are dropped), so the stub cannot ride the test env;
// instead the tests spawn through a tiny wrapper interpreter that appends the stub dir AFTER the
// platform-owned path — the same site-level guarantee the real image gives (`python3` with the
// `boardwalk` package importable). They skip (clearly) when python3 is absent on the test
// machine; the curation + dispatch logic is additionally unit-tested with no Python at all.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { extract as tarExtract } from "tar";
import {
  runWorkflowProgram,
  type ProgramResult,
  type ProgramRunnerDeps,
} from "./program_runner.js";
import {
  curatePythonFailure,
  curateSpawnFailure,
  isPythonEntry,
  lineSplitter,
  pythonModulePath,
} from "./python_program.js";
import { captureConsole, type LogStream } from "./program_log_capture.js";
import { RunAbortedError } from "./run_abort.js";
import type { HostCapabilities } from "./host_server.js";
import { tarFiles } from "./testing_artifact_build.js";
import type { ContextData } from "@boardwalk-labs/workflow/runtime";

const FIXTURE_PYTHONPATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "testdata",
  "pyloader",
);

/** Whether a `python3` exists on this machine; the integration suite skips without it. */
const pythonAvailable = ((): boolean => {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const TEST_CONTEXT: ContextData = {
  runId: "01PYTESTRUN000000000000000",
  workflowId: "01PYTESTWORKFLOW0000000000",
  workflowVersion: 1,
  orgId: "01PYTESTORG000000000000000",
  environment: null,
  actor: { type: "user", user_id: "01PYTESTUSER00000000000000" },
  attempt: 1,
  trigger: { kind: "manual", firedAt: 1_700_000_000_000 },
  workspaceDir: "/workspace",
};

/** The Python fixture only speaks bootstrap/report_return; every capability fails loud. */
function stubCapabilities(): HostCapabilities {
  const notStubbed = (what: string) => (): never => {
    throw new Error(`${what} is not stubbed in this test`);
  };
  return {
    agent: notStubbed("agent"),
    callWorkflow: notStubbed("callWorkflow"),
    runWorkflow: notStubbed("runWorkflow"),
    scheduleWorkflow: notStubbed("scheduleWorkflow"),
    sleep: notStubbed("sleep"),
    humanInput: notStubbed("humanInput"),
    getSecret: notStubbed("getSecret"),
    writeArtifact: notStubbed("writeArtifact"),
    openBrowser: notStubbed("openBrowser"),
    shell: notStubbed("shell"),
    phase: () => undefined,
    idToken: notStubbed("idToken"),
    apiToken: notStubbed("apiToken"),
    usage: notStubbed("usage"),
  };
}

const tmpDirs: string[] = [];
async function mkTmp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  // macOS tmpdir is a symlink (/var → /private/var); the child's os.getcwd() reports the REAL path.
  return fs.realpath(dir);
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

/** Pack a Python program artifact in the RATIFIED layout: sources under `.bw-src/`, frozen deps
 *  under `.bw-machine/site-packages/` (the CLI packer's shape the runner binds to). */
function buildPythonPackage(files: readonly { name: string; text: string }[]): Uint8Array {
  const tar = tarFiles(files.map((f) => ({ name: f.name, data: Buffer.from(f.text, "utf8") })));
  return new Uint8Array(gzipSync(tar, { level: 9 }));
}

/** Pack a one-file Python "program" whose `.bw-src/main.py` CONTENT is the fixture mode word. */
function buildPythonArtifact(mode: string): { tarball: Uint8Array; entry: string } {
  return {
    tarball: buildPythonPackage([{ name: ".bw-src/main.py", text: `${mode}\n` }]),
    entry: "main.py",
  };
}

/** The wrapper interpreter the subprocess suite's beforeAll creates (see the header comment);
 *  `runPyArtifact` defaults to it so every spawn resolves the stub loader like the real image. */
let pythonWrapper: string | undefined;

/** Run a built Python artifact through the REAL runner path (real tar, real socket, real python
 *  subprocess). */
async function runPyArtifact(
  runId: string,
  built: { tarball: Uint8Array; entry: string },
  input: unknown,
  deps: Partial<ProgramRunnerDeps> = {},
  outputSchema: Record<string, unknown> | null = null,
): Promise<ProgramResult> {
  const workspaceRoot = deps.workspaceRoot ?? (await mkTmp("bw-pyws-"));
  const programRoot = deps.programRoot ?? (await mkTmp("bw-pyprog-"));
  return runWorkflowProgram(
    {
      runId,
      tarball: built.tarball,
      entry: built.entry,
      input,
      inputSchema: null,
      outputSchema,
      context: TEST_CONTEXT,
    },
    {
      capabilities: stubCapabilities(),
      extract: async (tgzPath, destDir) => {
        await tarExtract({ file: tgzPath, cwd: destDir });
      },
      ...(pythonWrapper === undefined ? {} : { pythonInterpreter: pythonWrapper }),
      ...deps,
      workspaceRoot,
      programRoot,
    },
  );
}

/** Run a fixture-mode Python program (the one-word `.bw-src/main.py` shape). */
async function runPy(
  runId: string,
  mode: string,
  input: unknown,
  deps: Partial<ProgramRunnerDeps> = {},
  outputSchema: Record<string, unknown> | null = null,
): Promise<ProgramResult> {
  return runPyArtifact(runId, buildPythonArtifact(mode), input, deps, outputSchema);
}

const outputOf = (r: ProgramResult): unknown => (r.kind === "completed" ? r.output : undefined);
const errorOf = (r: ProgramResult): { code: string; message: string; hint?: string } | undefined =>
  r.kind === "failed" ? r.error : undefined;

// ---- unit: the dispatch decision --------------------------------------------------------------

describe("isPythonEntry (the language dispatch decision)", () => {
  it("routes .py entries to the subprocess path", () => {
    expect(isPythonEntry("main.py")).toBe(true);
    expect(isPythonEntry("nested/dir/main.py")).toBe(true);
    expect(isPythonEntry("MAIN.PY")).toBe(true);
  });
  it("keeps every other entry on the in-process TS loader", () => {
    expect(isPythonEntry("index.mjs")).toBe(false);
    expect(isPythonEntry("index.js")).toBe(false);
    expect(isPythonEntry("index.ts")).toBe(false);
    expect(isPythonEntry("module.pyx")).toBe(false);
    expect(isPythonEntry("py")).toBe(false);
  });
});

// ---- unit: the platform-owned module path -----------------------------------------------------

describe("pythonModulePath", () => {
  it("puts the author's .bw-src sources AHEAD of the frozen site-packages deps", () => {
    const programDir = path.join(path.sep, "prog", "run-1");
    expect(pythonModulePath(programDir)).toBe(
      [
        path.join(programDir, ".bw-src"),
        path.join(programDir, ".bw-machine", "site-packages"),
      ].join(path.delimiter),
    );
  });
});

// ---- unit: line splitting ---------------------------------------------------------------------

describe("lineSplitter", () => {
  it("reassembles lines across chunk boundaries and strips CR", () => {
    const lines: string[] = [];
    const s = lineSplitter((l) => lines.push(l));
    s.push("hel");
    s.push("lo\nwor");
    s.push("ld\r\n");
    s.flush();
    expect(lines).toEqual(["hello", "world"]);
  });
  it("flushes a trailing partial line (a crash mid-line keeps its last words)", () => {
    const lines: string[] = [];
    const s = lineSplitter((l) => lines.push(l));
    s.push("no newline at end");
    s.flush();
    expect(lines).toEqual(["no newline at end"]);
  });
  it("forwards empty lines within the stream (parity with console.log(''))", () => {
    const lines: string[] = [];
    const s = lineSplitter((l) => lines.push(l));
    s.push("a\n\nb\n");
    expect(lines).toEqual(["a", "", "b"]);
  });
});

// ---- unit: failure curation -------------------------------------------------------------------

describe("curatePythonFailure", () => {
  it("uses the traceback's final line as the message on a non-zero exit", () => {
    const err = curatePythonFailure({
      exitCode: 1,
      signal: null,
      stderrTail: [
        "Traceback (most recent call last):",
        '  File "main.py", line 3, in run',
        "ValueError: boom from python",
      ],
    }) as Error & { code?: string; hint?: string };
    expect(err.message).toBe("ValueError: boom from python");
    expect(err.code).toBe("PROGRAM_ERROR");
    expect(err.hint).toMatch(/full Python traceback is in the run log/);
  });

  it("skips trailing blank stderr lines when picking the message", () => {
    const err = curatePythonFailure({
      exitCode: 1,
      signal: null,
      stderrTail: ["RuntimeError: real error", "", "   "],
    });
    expect(err.message).toBe("RuntimeError: real error");
  });

  it("describes a silent non-zero exit by its exit code", () => {
    const err = curatePythonFailure({ exitCode: 3, signal: null, stderrTail: [] }) as Error & {
      code?: string;
    };
    expect(err.message).toMatch(/exited with code 3/);
    expect(err.code).toBe("PROGRAM_ERROR");
  });

  it("describes a signal kill by its signal", () => {
    const err = curatePythonFailure({ exitCode: null, signal: "SIGKILL", stderrTail: [] });
    expect(err.message).toMatch(/killed by SIGKILL/);
  });

  it("flags exit 0 without a report as the loader-contract violation (INTERNAL)", () => {
    const err = curatePythonFailure({ exitCode: 0, signal: null, stderrTail: [] }) as Error & {
      code?: string;
      hint?: string;
    };
    expect(err.code).toBe("INTERNAL_ERROR");
    expect(err.message).toMatch(/exited without reporting a result/);
    expect(err.hint).toMatch(/Return a value from run\(\)/);
  });
});

describe("curateSpawnFailure", () => {
  it("turns a missing interpreter (ENOENT) into a clear UNSUPPORTED-class failure", () => {
    const enoent = Object.assign(new Error("spawn python3 ENOENT"), { code: "ENOENT" });
    const err = curateSpawnFailure("python3", enoent) as Error & { code?: string; hint?: string };
    expect(err.code).toBe("UNSUPPORTED_RUNTIME");
    expect(err.message).toMatch(/no "python3" interpreter/);
    expect(err.hint).toMatch(/runs_on image must put python3 on PATH/);
    expect(err.hint).toMatch(/boardwalk package/);
  });
  it("passes any other spawn error through untouched", () => {
    const eacces = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
    expect(curateSpawnFailure("python3", eacces)).toBe(eacces);
  });
});

// ---- integration: a missing interpreter fails CLOSED (no Python needed for this one) ----------

describe("runWorkflowProgram — python interpreter missing", () => {
  it("fails the run with the UNSUPPORTED-class message, never a cryptic ENOENT", async () => {
    const res = await runPy("run_py_noint", "echo", null, {
      pythonInterpreter: "bw-definitely-not-a-python-interpreter",
    });
    expect(res.kind).toBe("failed");
    expect(errorOf(res)?.code).toBe("UNSUPPORTED_RUNTIME");
    expect(errorOf(res)?.message).toMatch(/no "bw-definitely-not-a-python-interpreter"/);
    expect(errorOf(res)?.message).not.toMatch(/ENOENT/);
    expect(errorOf(res)?.hint).toMatch(/boardwalk\/linux/);
  });
});

// ---- integration: the containment guard (fails before any spawn — no Python needed) -----------

describe("runWorkflowProgram — python entry containment", () => {
  it("rejects a .py entry that escapes .bw-src, even into the artifact root", async () => {
    const built = {
      tarball: buildPythonPackage([
        { name: "evil.py", text: "print('never runs')\n" },
        { name: ".bw-src/main.py", text: "echo\n" },
      ]),
      entry: "../evil.py",
    };
    const res = await runPyArtifact("run_py_escape", built, null, {});
    expect(res.kind).toBe("failed");
    expect(errorOf(res)?.code).toBe("VALIDATION_FAILED");
    expect(errorOf(res)?.message).toMatch(/escapes the program directory/);
  });
});

// ---- integration: the real subprocess path (skipped when python3 is absent) -------------------

if (!pythonAvailable) {
  console.warn(
    "python3 not found on PATH — skipping the Python program-path integration tests " +
      "(python_program.test.ts); install Python 3 to run them.",
  );
}

describe.skipIf(!pythonAvailable)("runWorkflowProgram — the Python subprocess path", () => {
  // The runner OWNS the child's PYTHONPATH (inherited values are dropped), so the stub loader
  // can't ride the test env. Stand in for the image guarantee instead: a wrapper interpreter
  // that appends the stub dir AFTER whatever PYTHONPATH the runner set (site-level, exactly
  // where the real image's `boardwalk` package sits relative to the platform-owned path).
  let wrapperDir: string | undefined;
  beforeAll(async () => {
    wrapperDir = await fs.mkdtemp(path.join(os.tmpdir(), "bw-pywrap-"));
    pythonWrapper = path.join(wrapperDir, "python3-with-stub-loader");
    const script = [
      "#!/bin/sh",
      `PYTHONPATH="\${PYTHONPATH:+\${PYTHONPATH}${path.delimiter}}${FIXTURE_PYTHONPATH}"`,
      "export PYTHONPATH",
      'exec python3 "$@"',
      "",
    ].join("\n");
    await fs.writeFile(pythonWrapper, script, { mode: 0o755 });
  });
  afterAll(async () => {
    pythonWrapper = undefined;
    if (wrapperDir !== undefined) await fs.rm(wrapperDir, { recursive: true, force: true });
  });

  it("bootstraps, runs with cwd + HOME = the workspace, and completes on report_return", async () => {
    const workspaceRoot = await mkTmp("bw-pyws-");
    const outputs: unknown[] = [];
    const res = await runPy(
      "run_py_echo",
      "echo",
      { n: 7 },
      {
        workspaceRoot,
        onOutput: (value) => {
          outputs.push(value);
        },
      },
    );
    expect(res.kind).toBe("completed");
    expect(outputOf(res)).toEqual({
      echoed: { n: 7 },
      run_id: TEST_CONTEXT.runId,
      cwd: workspaceRoot,
      home: workspaceRoot,
    });
    // The child disconnected after report_return and exited 0 — the clean-shutdown contract —
    // and the reported value fired onOutput exactly like the TS path.
    expect(outputs).toEqual([outputOf(res)]);
  }, 15_000);

  it("resolves the entry under .bw-src and imports siblings + frozen deps via the module path", async () => {
    const programRoot = await mkTmp("bw-pyprog-");
    const built = {
      tarball: buildPythonPackage([
        {
          name: ".bw-src/main.py",
          text: [
            "# bw-exec",
            "import os",
            "import helper",
            "import fakedep",
            "import dupmod",
            "bw_report({",
            '    "helper": helper.VALUE,',
            '    "fakedep": fakedep.VALUE,',
            '    "dupmod": dupmod.VALUE,',
            '    "pythonpath": os.environ.get("PYTHONPATH", ""),',
            "})",
            "",
          ].join("\n"),
        },
        { name: ".bw-src/helper.py", text: 'VALUE = "from-src-helper"\n' },
        { name: ".bw-src/dupmod.py", text: 'VALUE = "author"\n' },
        {
          name: ".bw-machine/site-packages/fakedep/__init__.py",
          text: 'VALUE = "from-site-packages"\n',
        },
        { name: ".bw-machine/site-packages/dupmod.py", text: 'VALUE = "dependency"\n' },
      ]),
      entry: "main.py",
    };
    // An inherited PYTHONPATH must NOT reach the child — plant a sentinel to prove the drop.
    const savedPythonPath = process.env.PYTHONPATH;
    process.env.PYTHONPATH = "/bw-inherited-sentinel";
    let res: ProgramResult;
    try {
      res = await runPyArtifact("run_py_modpath", built, null, { programRoot });
    } finally {
      if (savedPythonPath === undefined) Reflect.deleteProperty(process.env, "PYTHONPATH");
      else process.env.PYTHONPATH = savedPythonPath;
    }
    expect(res.kind).toBe("completed");
    const out = outputOf(res) as {
      helper: string;
      fakedep: string;
      dupmod: string;
      pythonpath: string;
    };
    expect(out.helper).toBe("from-src-helper");
    expect(out.fakedep).toBe("from-site-packages");
    // .bw-src precedes site-packages: the author's module wins the name collision.
    expect(out.dupmod).toBe("author");
    // The child's PYTHONPATH is platform-owned: sources first, frozen deps second, both under
    // the extract dir; the trailing entry is the wrapper's stub-loader append (the stand-in for
    // the image's site-level `boardwalk`), and the inherited sentinel never crossed.
    const [srcPath = "", depsPath = "", stubPath = "", ...rest] = out.pythonpath.split(
      path.delimiter,
    );
    expect(rest).toEqual([]);
    expect(srcPath.startsWith(path.join(programRoot, ".bw-runs"))).toBe(true);
    expect(srcPath.endsWith(`${path.sep}.bw-src`)).toBe(true);
    expect(depsPath.startsWith(path.join(programRoot, ".bw-runs"))).toBe(true);
    expect(depsPath.endsWith(path.join(".bw-machine", "site-packages"))).toBe(true);
    expect(stubPath).toBe(FIXTURE_PYTHONPATH);
    expect(out.pythonpath).not.toContain("/bw-inherited-sentinel");
  }, 15_000);

  it("runs a no-dep package (no site-packages layer at all) and tolerates a leading ./ entry", async () => {
    const built = {
      tarball: buildPythonPackage([
        {
          name: ".bw-src/main.py",
          text: '# bw-exec\nimport helper\nbw_report({"helper": helper.VALUE})\n',
        },
        { name: ".bw-src/helper.py", text: 'VALUE = "no-deps"\n' },
      ]),
      entry: "./main.py",
    };
    const res = await runPyArtifact("run_py_nodeps", built, null, {});
    expect(res.kind).toBe("completed");
    expect(outputOf(res)).toEqual({ helper: "no-deps" });
  }, 15_000);

  it("pipes the child's stdout/stderr into the program log capture, line-buffered + stream-marked", async () => {
    const lines: { stream: LogStream; text: string }[] = [];
    const restore = captureConsole((stream, text) => lines.push({ stream, text }));
    try {
      const res = await runPy("run_py_logs", "echo", null, {});
      expect(res.kind).toBe("completed");
    } finally {
      restore();
    }
    expect(lines).toContainEqual({ stream: "stdout", text: "echo fixture starting" });
    expect(lines).toContainEqual({ stream: "stderr", text: "a warning line" });
  }, 15_000);

  it("curates a raise: code PROGRAM_ERROR, message = the traceback's final line", async () => {
    const res = await runPy("run_py_raise", "raise", null, {});
    expect(res.kind).toBe("failed");
    expect(errorOf(res)?.code).toBe("PROGRAM_ERROR");
    expect(errorOf(res)?.message).toBe("ValueError: boom from python");
    expect(errorOf(res)?.hint).toMatch(/full Python traceback is in the run log/);
  }, 15_000);

  it("secret-redacts the curated message through the existing redactor path", async () => {
    const res = await runPy("run_py_redact", "raise", null, {
      redactText: (s) => s.split("boom").join("[REDACTED]"),
    });
    expect(errorOf(res)?.message).toBe("ValueError: [REDACTED] from python");
  }, 15_000);

  it("fails a clean exit that never reported (the loader-contract violation)", async () => {
    const res = await runPy("run_py_silent", "silent", null, {});
    expect(res.kind).toBe("failed");
    expect(errorOf(res)?.code).toBe("INTERNAL_ERROR");
    expect(errorOf(res)?.message).toMatch(/exited without reporting a result/);
  }, 15_000);

  it("surfaces an output-schema mismatch as VALIDATION_FAILED with the TS-parity hint", async () => {
    const res = await runPy(
      "run_py_badout",
      "badreturn",
      null,
      {},
      {
        type: "object",
        required: ["n"],
        properties: { n: { type: "number" } },
      },
    );
    expect(res.kind).toBe("failed");
    // The server-side recorded report_return failure wins over the traceback tail: the real
    // code + detail, not "RuntimeError: VALIDATION_FAILED: …".
    expect(errorOf(res)?.code).toBe("VALIDATION_FAILED");
    expect(errorOf(res)?.message).toMatch(/does not match the workflow's declared output_schema/);
    expect(errorOf(res)?.hint).toMatch(/Return a value matching/);
  }, 15_000);

  it("kills a hung child on run abort (SIGTERM) and reports the aborted failure", async () => {
    const controller = new AbortController();
    const pending = runPy("run_py_abort", "hang", null, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 500));
    controller.abort(new RunAbortedError("cancelled"));
    // The promise settling IS the proof the subprocess died — it resolves on the child's close.
    const res = await pending;
    expect(res.kind).toBe("failed");
    expect(errorOf(res)?.message).toMatch(/Run aborted: cancelled/);
  }, 15_000);

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const controller = new AbortController();
    const pending = runPy("run_py_sigkill", "stubborn-hang", null, {
      signal: controller.signal,
      pythonKillGraceMs: 300,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    controller.abort(new RunAbortedError("cancelled"));
    const res = await pending;
    expect(res.kind).toBe("failed");
    expect(errorOf(res)?.message).toMatch(/Run aborted: cancelled/);
  }, 15_000);
});
