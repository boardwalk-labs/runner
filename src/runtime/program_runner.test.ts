// Real-execution tests for the workflow program runner. These build actual program sources into
// artifacts and extract + dynamic-import them (no mocking of the build or import), with a recording
// host installed — the component-level proof of the first-slice gate: input → agent() → sleep, end to
// end. The runner takes the VERIFIED tarball + entry (digest verification happens one level up in the
// worker); here we build a real artifact and extract it with `tar`.

import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { join } from "node:path";
import { agent as sdkAgent } from "@boardwalk-labs/workflow";
import type { WorkflowHost } from "@boardwalk-labs/workflow/runtime";
import { extract as tarExtract } from "tar";
import {
  resolveEntryPath,
  ensureSdkLink,
  runWorkflowProgram,
  type ProgramResult,
  type ProgramRunnerDeps,
} from "./program_runner.js";
import { buildSingleFileArtifact } from "./testing_artifact_build.js";

interface Recorder {
  host: WorkflowHost;
  agentCalls: { prompt: string; opts: unknown }[];
  sleeps: unknown[];
  calls: { slug: string; input: unknown }[];
  secretGets: string[];
  phases: { name: string; opts: unknown }[];
}

/** Narrow a {@link ProgramResult} to its `completed` output / `failed` error (the result is now a
 *  discriminated union that also includes `suspended`). */
const outputOf = (r: ProgramResult): unknown => (r.kind === "completed" ? r.output : undefined);
const errorOf = (r: ProgramResult): { code: string; message: string; hint?: string } | undefined =>
  r.kind === "failed" ? r.error : undefined;

function recordingHost(overrides: Partial<WorkflowHost> = {}): Recorder {
  const rec: Recorder = {
    agentCalls: [],
    sleeps: [],
    calls: [],
    secretGets: [],
    phases: [],
    host: {} as WorkflowHost,
  };
  rec.host = {
    setPhase: (name, opts) => {
      rec.phases.push({ name, opts });
    },
    agent: (prompt, opts) => {
      rec.agentCalls.push({ prompt, opts });
      return overrides.agent ? overrides.agent(prompt, opts) : Promise.resolve(`leaf:${prompt}`);
    },
    callWorkflow: (slug, input, opts) => {
      rec.calls.push({ slug, input });
      return overrides.callWorkflow
        ? overrides.callWorkflow(slug, input, opts)
        : Promise.resolve({ child: slug });
    },
    sleep: (arg) => {
      rec.sleeps.push(arg);
      return overrides.sleep ? overrides.sleep(arg) : Promise.resolve();
    },
    getSecret: (name) => {
      rec.secretGets.push(name);
      return overrides.getSecret ? overrides.getSecret(name) : Promise.resolve(`sek:${name}`);
    },
  };
  return rec;
}

/** Temp dirs made by {@link runSource}, removed after each test. */
const tmpDirs: string[] = [];
async function mkTmp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  // macOS `os.tmpdir()` is a symlink (/var → /private/var) and `process.cwd()` reports the REAL
  // path, so resolve here or every cwd assertion compares a symlink to its target.
  return fs.realpath(dir);
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

/** Build `source` into a real artifact, then run it through the runner with a real `tar` extractor.
 *  A real workspace + program root are created per run unless the test pins its own — so EVERY test
 *  here exercises the real chdir contract (WORKSPACE_PERSISTENCE.md I1), not just the ones asserting it. */
async function runSource(
  runId: string,
  source: string,
  input: unknown,
  deps: Omit<ProgramRunnerDeps, "extract" | "workspaceRoot" | "programRoot"> &
    Partial<Pick<ProgramRunnerDeps, "workspaceRoot" | "programRoot">>,
) {
  const built = buildSingleFileArtifact(source);
  const workspaceRoot = deps.workspaceRoot ?? (await mkTmp("bw-ws-"));
  const programRoot = deps.programRoot ?? (await mkTmp("bw-prog-"));
  return runWorkflowProgram(
    { runId, tarball: built.tarball, entry: built.entry, input, config: {} },
    {
      ...deps,
      workspaceRoot,
      programRoot,
      extract: async (tgzPath, destDir) => {
        await tarExtract({ file: tgzPath, cwd: destDir });
      },
    },
  );
}

// The contract that had to exist and didn't: `/workspace` is the working directory for author code,
// and the program bundle lives OUTSIDE it. Nothing asserted either, which is how the hosted lanes
// silently drifted (fleet cwd `/`, Fargate cwd `/app`) while dev + self-hosted stayed correct, and how
// a documented contract turned into silent data loss. See docs/WORKSPACE_PERSISTENCE.md §2 + §8.
describe("runWorkflowProgram — the workspace IS the working directory (WORKSPACE_PERSISTENCE.md I1/I2)", () => {
  it("runs author code with cwd === workspaceRoot", async () => {
    const workspaceRoot = await mkTmp("bw-ws-");
    const source = `
      import { output } from "@boardwalk-labs/workflow";
      output(process.cwd());
    `;
    const res = await runSource("run_cwd", source, null, {
      host: recordingHost().host,
      workspaceRoot,
    });
    expect(outputOf(res)).toBe(workspaceRoot);
  });

  it("lands a program's RELATIVE write in the workspace (the silent-data-loss path)", async () => {
    const workspaceRoot = await mkTmp("bw-ws-");
    const source = `
      import { writeFileSync, mkdirSync } from "node:fs";
      mkdirSync("state", { recursive: true });
      writeFileSync("state/x.json", JSON.stringify({ ok: true }));
    `;
    const res = await runSource("run_rel", source, null, {
      host: recordingHost().host,
      workspaceRoot,
    });

    expect(res.kind).toBe("completed");
    // The whole bug in one assertion: this file used to land at `/state/x.json` on the fleet and
    // `/app/state/x.json` on Fargate, so `workspace.persist` archived nothing and the write was lost.
    expect(existsSync(join(workspaceRoot, "state", "x.json"))).toBe(true);
  });

  it("keeps the extracted program OUT of the workspace, so no snapshot can capture it (I2)", async () => {
    const workspaceRoot = await mkTmp("bw-ws-");
    const source = `
      import { writeFileSync } from "node:fs";
      writeFileSync("only.txt", "x");
    `;
    await runSource("run_iso", source, null, { host: recordingHost().host, workspaceRoot });

    // Only the program's own write. No `.bw-runs`, no `node_modules` SDK link. A workspace that
    // contained the bundle would tar it into every pre-sleep snapshot and accumulate it forever.
    expect(await fs.readdir(workspaceRoot)).toEqual(["only.txt"]);
  });

  it("restores the caller's cwd after the run, whatever the outcome", async () => {
    const before = process.cwd();
    await runSource("run_restore", `throw new Error("boom");`, null, {
      host: recordingHost().host,
    });
    expect(process.cwd()).toBe(before);
  });

  it("refuses a program root inside the workspace (I2 is enforced, not incidental)", async () => {
    const workspaceRoot = await mkTmp("bw-ws-");
    const res = await runSource("run_nested", `const x = 1; void x;`, null, {
      host: recordingHost().host,
      workspaceRoot,
      programRoot: join(workspaceRoot, "programs"),
    });
    expect(errorOf(res)?.message).toMatch(/program root .* inside the workspace/i);
  });

  it("fails loudly when the workspace does not exist rather than running from elsewhere", async () => {
    const res = await runSource("run_nows", `const x = 1; void x;`, null, {
      host: recordingHost().host,
      workspaceRoot: join(os.tmpdir(), "bw-definitely-absent-workspace"),
    });
    expect(errorOf(res)?.message).toMatch(/workspace/i);
  });
});

describe("runWorkflowProgram — the gate: input → agent() → sleep", () => {
  it("runs a program, injecting input and delegating to the host", async () => {
    const rec = recordingHost();
    const source = `
      import { agent, sleep, input } from "@boardwalk-labs/workflow";
      const payload = input;
      await agent("triage " + JSON.stringify(payload));
      await sleep(5000);
    `;
    const res = await runSource("run_1", source, { name: "world" }, { host: rec.host });

    expect(res.kind).toBe("completed");
    expect(outputOf(res)).toBeNull();
    expect(rec.agentCalls).toEqual([{ prompt: 'triage {"name":"world"}', opts: undefined }]);
    expect(rec.sleeps).toEqual([5000]);
  });

  it("calls onExtracted with the program dir holding the bundled files (for agent({skills}))", async () => {
    const rec = recordingHost();
    const built = buildSingleFileArtifact(`console.log("ok");`, [
      { name: "skills/triage.md", data: Buffer.from("# triage", "utf8") },
    ]);
    let extractedDir: string | null = null;
    let skillPresent = false;
    await runWorkflowProgram(
      { runId: "run_extract", tarball: built.tarball, entry: built.entry, input: null, config: {} },
      {
        host: rec.host,
        workspaceRoot: await mkTmp("bw-ws-"),
        programRoot: await mkTmp("bw-prog-"),
        extract: async (tgzPath, destDir) => {
          await tarExtract({ file: tgzPath, cwd: destDir });
        },
        // The dir is torn down after the run, so probe the bundled file from inside the callback.
        onExtracted: (dir) => {
          extractedDir = dir;
          skillPresent = existsSync(join(dir, "skills", "triage.md"));
        },
      },
    );
    expect(extractedDir).not.toBeNull();
    expect(skillPresent).toBe(true);
  });

  it("captures the program's declared output() as the run output", async () => {
    const rec = recordingHost();
    const source = `
      import { output, input } from "@boardwalk-labs/workflow";
      output({ echoed: input, label: "done" });
    `;
    const res = await runSource("run_out", source, { n: 7 }, { host: rec.host });
    expect(res.kind).toBe("completed");
    expect(outputOf(res)).toEqual({ echoed: { n: 7 }, label: "done" });
  });

  it("returns null output when the program never declares one", async () => {
    const rec = recordingHost();
    const res = await runSource("run_noout", `console.log("no output");`, {}, { host: rec.host });
    expect(res.kind).toBe("completed");
    expect(outputOf(res)).toBeNull();
  });

  it("passes agent options through (schema/model)", async () => {
    const rec = recordingHost({ agent: () => Promise.resolve({ count: 2 }) });
    const source = `
      import { agent } from "@boardwalk-labs/workflow";
      const groups = await agent("group", { schema: { type: "object" }, model: "bedrock/x" });
      void groups;
    `;
    const res = await runSource("run_2", source, null, { host: rec.host });
    expect(res.kind).toBe("completed");
    expect(rec.agentCalls[0]?.opts).toEqual({ schema: { type: "object" }, model: "bedrock/x" });
  });

  it("delegates workflows.call and secrets.get", async () => {
    const rec = recordingHost();
    const source = `
      import { workflows, secrets } from "@boardwalk-labs/workflow";
      const tok = await secrets.get("LINEAR_TOKEN");
      await workflows.call("file-issue", { tok });
    `;
    const res = await runSource("run_3", source, null, { host: rec.host });
    expect(res.kind).toBe("completed");
    expect(rec.secretGets).toEqual(["LINEAR_TOKEN"]);
    expect(rec.calls).toEqual([{ slug: "file-issue", input: { tok: "sek:LINEAR_TOKEN" } }]);
  });

  it("delegates Phase markers synchronously", async () => {
    const rec = recordingHost();
    const source = `
      import { phase, agent } from "@boardwalk-labs/workflow";
      phase("Install dependencies", { id: "install" });
      await agent("go");
    `;
    const res = await runSource("run_phase", source, null, { host: rec.host });
    expect(res.kind).toBe("completed");
    expect(rec.phases).toEqual([{ name: "Install dependencies", opts: { id: "install" } }]);
    expect(rec.agentCalls.map((c) => c.prompt)).toEqual(["go"]);
  });

  it("supports parallel fan-out of agent leaves", async () => {
    const rec = recordingHost();
    const source = `
      import { agent, parallel } from "@boardwalk-labs/workflow";
      await parallel([() => agent("a"), () => agent("b"), () => agent("c")]);
    `;
    const res = await runSource("run_4", source, null, { host: rec.host });
    expect(res.kind).toBe("completed");
    expect(rec.agentCalls.map((c) => c.prompt).sort()).toEqual(["a", "b", "c"]);
  });

  it("runs a body with no SDK imports (console.log-style program)", async () => {
    const rec = recordingHost();
    const source = `const total = 1 + 1; if (total !== 2) throw new Error("math");`;
    const res = await runSource("run_5", source, null, { host: rec.host });
    expect(res.kind).toBe("completed");
    expect(rec.agentCalls).toEqual([]);
  });
});

describe("runWorkflowProgram — failures", () => {
  it("maps a top-level throw to a failed result", async () => {
    const rec = recordingHost();
    const source = `throw new Error("boom in program");`;
    const res = await runSource("run_6", source, null, { host: rec.host });
    expect(res.kind).toBe("failed");
    expect(errorOf(res)?.message).toContain("boom in program");
  });

  it("maps a rejected top-level await (a failing leaf) to a failed result", async () => {
    const rec = recordingHost({ agent: () => Promise.reject(new Error("leaf exploded")) });
    const source = `
      import { agent } from "@boardwalk-labs/workflow";
      await agent("will reject");
    `;
    const res = await runSource("run_7", source, null, { host: rec.host });
    expect(res.kind).toBe("failed");
    expect(errorOf(res)?.message).toContain("leaf exploded");
  });

  it("surfaces a malformed program (syntax error) as a failed result", async () => {
    const rec = recordingHost();
    const source = `const x = ;`; // syntax error → invalid built JS → import throws
    const res = await runSource("run_8", source, null, { host: rec.host });
    expect(res.kind).toBe("failed");
  });

  it("applies redactText to a thrown error message", async () => {
    const rec = recordingHost();
    const source = `throw new Error("boom token-abc123xyz789 here");`;
    const res = await runSource("run_10", source, null, {
      host: rec.host,
      redactText: (s) => s.split("token-abc123xyz789").join("[REDACTED]"),
    });
    expect(res.kind).toBe("failed");
    expect(errorOf(res)?.message).toBe("boom [REDACTED] here");
  });

  it("surfaces a thrown error's `hint` (an engine EngineError, duck-typed) on the failed result", async () => {
    // A leaf rejects with an EngineError-shaped value: message + a one-line actionable hint. The
    // runner has no other place to preserve the hint — on a hosted run the broker persists exactly
    // the { code, message, hint } this returns.
    const engineError = Object.assign(new Error("agent() got a string in `tools`."), {
      hint: 'Built-in tools are on by default — write `builtins: ["bash"]`.',
    });
    const rec = recordingHost({ agent: () => Promise.reject(engineError) });
    const source = `
      import { agent } from "@boardwalk-labs/workflow";
      await agent("boom");
    `;
    const res = await runSource("run_hint", source, null, { host: rec.host });
    expect(res.kind).toBe("failed");
    expect(errorOf(res)?.message).toContain("got a string");
    expect(errorOf(res)?.hint).toBe(
      'Built-in tools are on by default — write `builtins: ["bash"]`.',
    );
  });

  it("leaves `hint` absent for an ordinary error that carries none", async () => {
    const rec = recordingHost();
    const res = await runSource("run_nohint", `throw new Error("plain boom");`, null, {
      host: rec.host,
    });
    expect(res.kind).toBe("failed");
    expect(errorOf(res)?.hint).toBeUndefined();
  });

  it("redacts the hint too (it is built from the same untrusted inputs as the message)", async () => {
    const leaked = Object.assign(new Error("failed"), { hint: "use token-abc123xyz789 next time" });
    const rec = recordingHost({ agent: () => Promise.reject(leaked) });
    const source = `
      import { agent } from "@boardwalk-labs/workflow";
      await agent("boom");
    `;
    const res = await runSource("run_hint_redact", source, null, {
      host: rec.host,
      redactText: (s) => s.split("token-abc123xyz789").join("[REDACTED]"),
    });
    expect(errorOf(res)?.hint).toBe("use [REDACTED] next time");
  });
});

describe("runWorkflowProgram — runtime teardown", () => {
  afterEach(async () => {
    // Ensure the global host is reset even if an assertion left it installed.
    await sdkAgent("noop", { model: "anthropic/claude-sonnet-4.5" }).catch(() => undefined);
  });

  it("resets the host after a run (hooks fail loud again)", async () => {
    const rec = recordingHost();
    await runSource("run_9", `const x = 1; void x;`, null, { host: rec.host });
    // After the run the singleton host is cleared, so calling a hook directly fails loud.
    await expect(sdkAgent("after", { model: "anthropic/claude-sonnet-4.5" })).rejects.toThrow(
      /no host installed/,
    );
  });
});

describe("ensureSdkLink", () => {
  it("links the runtime's own @boardwalk-labs/workflow into the exec dir", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bw-sdklink-"));
    await ensureSdkLink(dir);
    const link = path.join(dir, "node_modules", "@boardwalk-labs", "workflow");
    const real = await fs.realpath(link);
    // Same package instance the runtime imported: realpath of the link == realpath of our dep.
    const require = createRequire(import.meta.url);
    // Same package instance the runtime imported: the link's realpath is the package root the
    // main entry lives under (the export map exposes no "./package.json" subpath).
    const expected = await fs.realpath(
      path.dirname(path.dirname(require.resolve("@boardwalk-labs/workflow"))),
    );
    expect(real).toBe(expected);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("is idempotent (second call is a no-op, not an error)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bw-sdklink-"));
    await ensureSdkLink(dir);
    await ensureSdkLink(dir);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rejects a program that vendored its own real SDK dir (shadowing)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bw-sdklink-"));
    await fs.mkdir(path.join(dir, "node_modules", "@boardwalk-labs", "workflow"), {
      recursive: true,
    });
    await expect(ensureSdkLink(dir)).rejects.toThrow(/bundles its own/);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("resolveEntryPath", () => {
  const dir = "/work/.bw-runs/run-abc";
  it("resolves a normal relative entry inside the dir", () => {
    expect(resolveEntryPath(dir, "index.mjs")).toBe(path.join(dir, "index.mjs"));
    expect(resolveEntryPath(dir, "dist/index.js")).toBe(path.join(dir, "dist", "index.js"));
  });
  it("rejects a `..` escape", () => {
    expect(() => resolveEntryPath(dir, "../../../etc/passwd")).toThrow(/escapes/);
    expect(() => resolveEntryPath(dir, "a/../../b")).toThrow(/escapes/);
  });
  it("rejects an absolute path", () => {
    expect(() => resolveEntryPath(dir, "/etc/passwd")).toThrow(/escapes/);
  });
  it("rejects an entry that resolves to the dir itself", () => {
    expect(() => resolveEntryPath(dir, "")).toThrow(/escapes/);
  });
});
