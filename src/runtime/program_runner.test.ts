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
  ensureSdkLink,
  runWorkflowProgram,
  type ProgramResult,
  type ProgramRunnerDeps,
} from "./program_runner.js";
import { SuspendError, type SuspendSignal } from "./suspension.js";
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
const errorOf = (r: ProgramResult): { code: string; message: string } | undefined =>
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

/** Build `source` into a real artifact, then run it through the runner with a real `tar` extractor. */
async function runSource(
  runId: string,
  source: string,
  input: unknown,
  deps: Omit<ProgramRunnerDeps, "extract">,
) {
  const built = buildSingleFileArtifact(source);
  return runWorkflowProgram(
    { runId, tarball: built.tarball, entry: built.entry, input, config: {} },
    {
      ...deps,
      extract: async (tgzPath, destDir) => {
        await tarExtract({ file: tgzPath, cwd: destDir });
      },
    },
  );
}

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
});

describe("runWorkflowProgram — durable suspension", () => {
  const sig = (over: Partial<SuspendSignal> = {}): SuspendSignal => ({
    reason: "human_input",
    seq: 1,
    fingerprint: "fp",
    ...over,
  });

  it("maps a thrown SuspendError to a `suspended` result carrying the signal", async () => {
    const rec = recordingHost({ agent: () => Promise.reject(new SuspendError(sig({ seq: 3 }))) });
    const source = `
      import { agent } from "@boardwalk-labs/workflow";
      await agent("ask a person");
    `;
    const res = await runSource("run_susp_throw", source, null, { host: rec.host });
    expect(res.kind).toBe("suspended");
    expect(res.kind === "suspended" ? res.signal.seq : null).toBe(3);
  });

  it("races suspendSignal against the body and suspends even if the body never settles", async () => {
    // The suspending seam returns a never-resolving promise (the real onSuspend path); the out-of-band
    // suspendSignal is what short-circuits the runner — proving a program's own try/catch can't swallow it.
    const rec = recordingHost({ sleep: () => new Promise<void>(() => undefined) });
    const source = `
      import { sleep } from "@boardwalk-labs/workflow";
      try { await sleep(999999); } catch { /* a program can't swallow a suspend */ }
      throw new Error("should never run after a suspend");
    `;
    const built = buildSingleFileArtifact(source);
    const res = await runWorkflowProgram(
      {
        runId: "run_susp_race",
        tarball: built.tarball,
        entry: built.entry,
        input: null,
        config: {},
      },
      {
        host: rec.host,
        extract: async (tgzPath, destDir) => {
          await tarExtract({ file: tgzPath, cwd: destDir });
        },
        suspendSignal: Promise.resolve(sig({ reason: "sleep", durationMs: 999999 })),
      },
    );
    expect(res.kind).toBe("suspended");
    expect(res.kind === "suspended" ? res.signal.reason : null).toBe("sleep");
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
