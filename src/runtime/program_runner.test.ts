// Real-execution tests for the workflow program runner (the redesign's P3 invocation path).
// These build actual program sources into artifacts, extract them with real `tar`, start a REAL
// host-protocol server on a real Unix socket, and drive the REAL SDK loader + client against it
// (no mocking of the build, the import, or the wire) — the component-level proof of
// bootstrap → import entry → run(input, context) → report_return, end to end.

import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { join } from "node:path";
import { agent as sdkAgent } from "@boardwalk-labs/workflow";
import type { ContextData } from "@boardwalk-labs/workflow/runtime";
import { extract as tarExtract } from "tar";
import {
  resolveEntryPath,
  ensureSdkLink,
  runWorkflowProgram,
  type ProgramResult,
  type ProgramRunnerDeps,
  type RunProgramArgs,
} from "./program_runner.js";
import type { HostCapabilities } from "./host_server.js";
import { buildSingleFileArtifact } from "./testing_artifact_build.js";

const TEST_CONTEXT: ContextData = {
  runId: "01TESTRUN00000000000000000",
  workflowId: "01TESTWORKFLOW000000000000",
  workflowVersion: 1,
  orgId: "01TESTORG00000000000000000",
  environment: null,
  actor: { type: "user", user_id: "01TESTUSER0000000000000000" },
  attempt: 1,
  trigger: { kind: "manual", firedAt: 1_700_000_000_000 },
  workspaceDir: "/workspace",
};

interface Recorder {
  capabilities: HostCapabilities;
  agentCalls: { prompt: string; opts: unknown }[];
  sleeps: unknown[];
  calls: { slug: string; input: unknown }[];
  secretGets: string[];
  phases: { name: string; opts: unknown }[];
  shells: string[];
}

function notStubbed(what: string): never {
  throw new Error(`${what} is not stubbed in this test`);
}

function recordingCapabilities(overrides: Partial<HostCapabilities> = {}): Recorder {
  const rec: Recorder = {
    agentCalls: [],
    sleeps: [],
    calls: [],
    secretGets: [],
    phases: [],
    shells: [],
    capabilities: {} as HostCapabilities,
  };
  rec.capabilities = {
    agent: (prompt, opts) => {
      rec.agentCalls.push({ prompt, opts });
      return overrides.agent !== undefined
        ? overrides.agent(prompt, opts)
        : Promise.resolve(`leaf:${prompt}`);
    },
    callWorkflow: (slug, input, opts) => {
      rec.calls.push({ slug, input });
      return overrides.callWorkflow !== undefined
        ? overrides.callWorkflow(slug, input, opts)
        : Promise.resolve({ output: { child: slug }, outputSchema: null });
    },
    runWorkflow: overrides.runWorkflow ?? (() => Promise.resolve("run_child")),
    scheduleWorkflow: overrides.scheduleWorkflow ?? (() => Promise.resolve("sched_1")),
    sleep: (arg) => {
      rec.sleeps.push(arg);
      return overrides.sleep !== undefined ? overrides.sleep(arg) : Promise.resolve();
    },
    humanInput: overrides.humanInput ?? (() => notStubbed("humanInput")),
    getSecret: (name) => {
      rec.secretGets.push(name);
      return overrides.getSecret !== undefined
        ? overrides.getSecret(name)
        : Promise.resolve(`sek:${name}`);
    },
    writeArtifact: overrides.writeArtifact ?? (() => notStubbed("writeArtifact")),
    openBrowser: overrides.openBrowser ?? (() => notStubbed("openBrowser")),
    shell: (cmd, opts) => {
      rec.shells.push(cmd);
      return overrides.shell !== undefined
        ? overrides.shell(cmd, opts)
        : Promise.resolve({ exitCode: 0, stdout: `ran:${cmd}`, stderr: "" });
    },
    phase: (name, opts) => {
      rec.phases.push({ name, opts });
      overrides.phase?.(name, opts);
    },
    idToken: overrides.idToken ?? ((audience) => Promise.resolve(`jwt-for-${audience}`)),
    apiToken: overrides.apiToken ?? (() => Promise.resolve("api-token-1")),
    usage:
      overrides.usage ??
      (() =>
        Promise.resolve({
          usd: { spent: 0.5, cap: 2, remaining: 1.5 },
          tokens: { spent: 100, cap: null, remaining: null },
          compute_seconds: { spent: 3, cap: null, remaining: null },
        })),
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

/** Build `source` into a real artifact, then run it through the runner with a real `tar`
 *  extractor and a real host-protocol server. A real workspace + program root are created per
 *  run unless the test pins its own. */
async function runSource(
  runId: string,
  source: string,
  input: unknown,
  deps: Omit<ProgramRunnerDeps, "extract" | "workspaceRoot" | "programRoot"> &
    Partial<Pick<ProgramRunnerDeps, "workspaceRoot" | "programRoot">>,
  schemas: Partial<Pick<RunProgramArgs, "inputSchema" | "outputSchema" | "context">> = {},
) {
  const built = buildSingleFileArtifact(source);
  const workspaceRoot = deps.workspaceRoot ?? (await mkTmp("bw-ws-"));
  const programRoot = deps.programRoot ?? (await mkTmp("bw-prog-"));
  return runWorkflowProgram(
    {
      runId,
      tarball: built.tarball,
      entry: built.entry,
      input,
      inputSchema: schemas.inputSchema ?? null,
      outputSchema: schemas.outputSchema ?? null,
      context: schemas.context ?? TEST_CONTEXT,
    },
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

const outputOf = (r: ProgramResult): unknown => (r.kind === "completed" ? r.output : undefined);
const errorOf = (r: ProgramResult): { code: string; message: string; hint?: string } | undefined =>
  r.kind === "failed" ? r.error : undefined;

// The contract that had to exist and didn't: `/workspace` is the working directory for author code,
// and the program bundle lives OUTSIDE it. See docs/WORKSPACE_PERSISTENCE.md §2 + §8.
describe("runWorkflowProgram — the workspace IS the working directory (WORKSPACE_PERSISTENCE.md I1/I2)", () => {
  it("runs author code with cwd === workspaceRoot", async () => {
    const workspaceRoot = await mkTmp("bw-ws-");
    const source = `
      export default async function run() { return process.cwd(); }
    `;
    const res = await runSource("run_cwd", source, null, {
      capabilities: recordingCapabilities().capabilities,
      workspaceRoot,
    });
    expect(outputOf(res)).toBe(workspaceRoot);
  });

  it("lands a program's RELATIVE write in the workspace (the silent-data-loss path)", async () => {
    const workspaceRoot = await mkTmp("bw-ws-");
    const source = `
      import { writeFileSync, mkdirSync } from "node:fs";
      export default async function run() {
        mkdirSync("state", { recursive: true });
        writeFileSync("state/x.json", JSON.stringify({ ok: true }));
      }
    `;
    const res = await runSource("run_rel", source, null, {
      capabilities: recordingCapabilities().capabilities,
      workspaceRoot,
    });

    expect(res.kind).toBe("completed");
    expect(existsSync(join(workspaceRoot, "state", "x.json"))).toBe(true);
  });

  it("keeps the extracted program OUT of the workspace, so no snapshot can capture it (I2)", async () => {
    const workspaceRoot = await mkTmp("bw-ws-");
    const source = `
      import { writeFileSync } from "node:fs";
      export default async function run() { writeFileSync("only.txt", "x"); }
    `;
    await runSource("run_iso", source, null, {
      capabilities: recordingCapabilities().capabilities,
      workspaceRoot,
    });

    // Only the program's own write. No `.bw-runs`, no `node_modules` SDK link, no socket file.
    expect(await fs.readdir(workspaceRoot)).toEqual(["only.txt"]);
  });

  it("restores the caller's cwd after the run, whatever the outcome", async () => {
    const before = process.cwd();
    await runSource(
      "run_restore",
      `export default function run() { throw new Error("boom"); }`,
      null,
      { capabilities: recordingCapabilities().capabilities },
    );
    expect(process.cwd()).toBe(before);
  });

  it("refuses a program root inside the workspace (I2 is enforced, not incidental)", async () => {
    const workspaceRoot = await mkTmp("bw-ws-");
    const res = await runSource("run_nested", `export default function run() {}`, null, {
      capabilities: recordingCapabilities().capabilities,
      workspaceRoot,
      programRoot: join(workspaceRoot, "programs"),
    });
    expect(errorOf(res)?.message).toMatch(/program root .* inside the workspace/i);
  });

  it("fails loudly when the workspace does not exist rather than running from elsewhere", async () => {
    const res = await runSource("run_nows", `export default function run() {}`, null, {
      capabilities: recordingCapabilities().capabilities,
      workspaceRoot: join(os.tmpdir(), "bw-definitely-absent-workspace"),
    });
    expect(errorOf(res)?.message).toMatch(/workspace/i);
  });
});

describe("runWorkflowProgram — run(input, context) invocation (P3)", () => {
  it("passes the input positionally and delegates capabilities to the seam", async () => {
    const rec = recordingCapabilities();
    const source = `
      import { agent, sleep } from "@boardwalk-labs/workflow";
      export default async function run(input) {
        await agent("triage " + JSON.stringify(input));
        await sleep(5000);
      }
    `;
    const res = await runSource(
      "run_1",
      source,
      { name: "world" },
      {
        capabilities: rec.capabilities,
      },
    );

    expect(res.kind).toBe("completed");
    expect(outputOf(res)).toBeNull();
    expect(rec.agentCalls).toEqual([{ prompt: 'triage {"name":"world"}', opts: undefined }]);
    expect(rec.sleeps).toEqual([5000]);
  });

  it("REVIVES a typed input before run() sees it (a date-time field arrives as a Date)", async () => {
    const source = `
      export default async function run(input) {
        return {
          isDate: input.when instanceof Date,
          ms: input.when instanceof Date ? input.when.getTime() : null,
          plain: input.label,
        };
      }
    `;
    const res = await runSource(
      "run_revive",
      source,
      { when: "2026-01-02T03:04:05.000Z", label: "x" },
      { capabilities: recordingCapabilities().capabilities },
      {
        inputSchema: {
          type: "object",
          properties: {
            when: { type: "string", format: "date-time" },
            label: { type: "string" },
          },
        },
      },
    );
    expect(res.kind).toBe("completed");
    expect(outputOf(res)).toEqual({
      isDate: true,
      ms: Date.parse("2026-01-02T03:04:05.000Z"),
      plain: "x",
    });
  });

  it("passes an untyped input through as plain JSON, honestly", async () => {
    const source = `
      export default async function run(input) {
        return { isDate: input.when instanceof Date, raw: input.when };
      }
    `;
    const res = await runSource(
      "run_untyped",
      source,
      { when: "2026-01-02T03:04:05.000Z" },
      {
        capabilities: recordingCapabilities().capabilities,
      },
    );
    expect(outputOf(res)).toEqual({ isDate: false, raw: "2026-01-02T03:04:05.000Z" });
  });

  it("builds the live Context from the bootstrap data (frozen, with a signal)", async () => {
    const source = `
      export default async function run(input, context) {
        let frozen = false;
        try { context.runId = "hacked"; } catch { frozen = true; }
        return {
          runId: context.runId,
          workflowVersion: context.workflowVersion,
          actorType: context.actor.type,
          triggerKind: context.trigger.kind,
          hasSignal: context.signal instanceof AbortSignal,
          frozen,
        };
      }
    `;
    const res = await runSource("run_ctx", source, null, {
      capabilities: recordingCapabilities().capabilities,
    });
    expect(outputOf(res)).toEqual({
      runId: TEST_CONTEXT.runId,
      workflowVersion: 1,
      actorType: "user",
      triggerKind: "manual",
      hasSignal: true,
      frozen: true,
    });
  });

  it("accepts a run() declaring fewer params (Lambda-style, optional from the right)", async () => {
    const res = await runSource(
      "run_zeroary",
      `export default function run() { return 7; }`,
      null,
      {
        capabilities: recordingCapabilities().capabilities,
      },
    );
    expect(outputOf(res)).toBe(7);
  });

  it("captures the returned value as the run output and fires onOutput", async () => {
    const outputs: unknown[] = [];
    const source = `
      export default async function run(input) { return { echoed: input, label: "done" }; }
    `;
    const res = await runSource(
      "run_out",
      source,
      { n: 7 },
      {
        capabilities: recordingCapabilities().capabilities,
        onOutput: (value) => {
          outputs.push(value);
        },
      },
    );
    expect(res.kind).toBe("completed");
    expect(outputOf(res)).toEqual({ echoed: { n: 7 }, label: "done" });
    expect(outputs).toEqual([{ echoed: { n: 7 }, label: "done" }]);
  });

  it("persists null (and fires no onOutput) for a void return", async () => {
    const outputs: unknown[] = [];
    const res = await runSource(
      "run_void",
      `export default async function run() {}`,
      {},
      {
        capabilities: recordingCapabilities().capabilities,
        onOutput: (value) => {
          outputs.push(value);
        },
      },
    );
    expect(res.kind).toBe("completed");
    expect(outputOf(res)).toBeNull();
    expect(outputs).toEqual([]);
  });

  it("ENCODES a rich return outward (a Date crosses as its ISO string) and validates it", async () => {
    const source = `
      export default async function run() {
        return { when: new Date("2026-01-02T03:04:05.000Z") };
      }
    `;
    const res = await runSource(
      "run_encode",
      source,
      null,
      {
        capabilities: recordingCapabilities().capabilities,
      },
      {
        outputSchema: {
          type: "object",
          required: ["when"],
          properties: { when: { type: "string", format: "date-time" } },
        },
      },
    );
    expect(res.kind).toBe("completed");
    expect(outputOf(res)).toEqual({ when: "2026-01-02T03:04:05.000Z" });
  });

  it("fails the run (VALIDATION_FAILED + a hint) when the return does not match output_schema", async () => {
    const source = `export default async function run() { return { n: "not-a-number" }; }`;
    const res = await runSource(
      "run_badout",
      source,
      null,
      {
        capabilities: recordingCapabilities().capabilities,
      },
      {
        outputSchema: {
          type: "object",
          required: ["n"],
          properties: { n: { type: "number" } },
        },
      },
    );
    expect(res.kind).toBe("failed");
    expect(errorOf(res)?.code).toBe("VALIDATION_FAILED");
    expect(errorOf(res)?.message).toMatch(/does not match the workflow's declared output_schema/);
    expect(errorOf(res)?.hint).toMatch(/Return a value matching/);
  });

  it("fails clearly (with a hint) when the entry has no run default export", async () => {
    const res = await runSource("run_noentry", `export const notRun = 1;`, null, {
      capabilities: recordingCapabilities().capabilities,
    });
    expect(res.kind).toBe("failed");
    expect(errorOf(res)?.code).toBe("VALIDATION");
    expect(errorOf(res)?.message).toMatch(/no `run` function default export/);
    expect(errorOf(res)?.hint).toMatch(/export default async function run/);
  });

  it("passes agent options through the wire (schema/model)", async () => {
    const rec = recordingCapabilities({ agent: () => Promise.resolve({ count: 2 }) });
    const source = `
      import { agent } from "@boardwalk-labs/workflow";
      export default async function run() {
        return agent("group", { schema: { type: "object" }, model: "bedrock/x" });
      }
    `;
    const res = await runSource("run_2", source, null, { capabilities: rec.capabilities });
    expect(res.kind).toBe("completed");
    expect(rec.agentCalls[0]?.opts).toMatchObject({
      schema: { type: "object" },
      model: "bedrock/x",
    });
    expect(outputOf(res)).toEqual({ count: 2 });
  });

  it("round-trips an inline agent() tool via tool_invoke (handler runs in the program)", async () => {
    // The fake leaf invokes the (server-reconstructed) ToolDef, whose execute() crosses the wire
    // back into the program's handler — the full P0 callback lane, over a real socket.
    const rec = recordingCapabilities({
      agent: async (_prompt, opts) => {
        const tool = opts?.tools?.[0];
        if (tool === undefined) return "no-tool";
        return await tool.execute({ n: 21 });
      },
    });
    const source = `
      import { agent } from "@boardwalk-labs/workflow";
      let sawInput = null;
      export default async function run() {
        const result = await agent("use the tool", {
          tools: [{
            name: "double",
            description: "doubles n",
            inputSchema: { type: "object", properties: { n: { type: "number" } } },
            execute: async ({ n }) => { sawInput = n; return n * 2; },
          }],
        });
        return { result, sawInput };
      }
    `;
    const res = await runSource("run_tool", source, null, { capabilities: rec.capabilities });
    expect(res.kind).toBe("completed");
    expect(outputOf(res)).toEqual({ result: 42, sawInput: 21 });
  });

  it("runs two concurrent tool_invoke round-trips (parallel tool calls in a turn)", async () => {
    const rec = recordingCapabilities({
      agent: async (_prompt, opts) => {
        const tool = opts?.tools?.[0];
        if (tool === undefined) return "no-tool";
        const [a, b] = await Promise.all([tool.execute({ n: 1 }), tool.execute({ n: 2 })]);
        return [a, b];
      },
    });
    const source = `
      import { agent } from "@boardwalk-labs/workflow";
      export default async function run() {
        return agent("fan out", {
          tools: [{
            name: "id",
            description: "returns n",
            inputSchema: { type: "object" },
            execute: async ({ n }) => n,
          }],
        });
      }
    `;
    const res = await runSource("run_tool2", source, null, { capabilities: rec.capabilities });
    expect(outputOf(res)).toEqual([1, 2]);
  });

  it("surfaces a tool handler throw as an ordinary error to the leaf — never run-fatal", async () => {
    const rec = recordingCapabilities({
      agent: async (_prompt, opts) => {
        const tool = opts?.tools?.[0];
        if (tool === undefined) return "no-tool";
        try {
          await tool.execute({});
          return "unexpected-success";
        } catch (err) {
          // The engine would feed this to the model as a tool-error result; the run continues.
          return `tool-error:${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });
    const source = `
      import { agent } from "@boardwalk-labs/workflow";
      export default async function run() {
        return agent("boom tool", {
          tools: [{
            name: "boom",
            description: "always throws",
            inputSchema: { type: "object" },
            execute: async () => { throw new Error("handler exploded"); },
          }],
        });
      }
    `;
    const res = await runSource("run_toolerr", source, null, { capabilities: rec.capabilities });
    expect(res.kind).toBe("completed");
    expect(outputOf(res)).toBe("tool-error:handler exploded");
  });

  it("delegates workflows.call + secrets.get, and revives a typed child output", async () => {
    const rec = recordingCapabilities({
      callWorkflow: () =>
        Promise.resolve({
          output: { finishedAt: "2026-03-04T05:06:07.000Z" },
          outputSchema: {
            type: "object",
            properties: { finishedAt: { type: "string", format: "date-time" } },
          },
        }),
    });
    const source = `
      import { workflows, secrets } from "@boardwalk-labs/workflow";
      export default async function run() {
        const tok = await secrets.get("LINEAR_TOKEN");
        const child = await workflows.call("file-issue", { tok });
        return { childIsDate: child.finishedAt instanceof Date, tok };
      }
    `;
    const res = await runSource("run_3", source, null, { capabilities: rec.capabilities });
    expect(res.kind).toBe("completed");
    expect(rec.secretGets).toEqual(["LINEAR_TOKEN"]);
    expect(rec.calls).toEqual([{ slug: "file-issue", input: { tok: "sek:LINEAR_TOKEN" } }]);
    expect(outputOf(res)).toEqual({ childIsDate: true, tok: "sek:LINEAR_TOKEN" });
  });

  it("delivers phase markers (fire-and-forget notifications, in order)", async () => {
    const rec = recordingCapabilities();
    const source = `
      import { phase, agent } from "@boardwalk-labs/workflow";
      export default async function run() {
        phase("Install dependencies", { id: "install" });
        await agent("go");
      }
    `;
    const res = await runSource("run_phase", source, null, { capabilities: rec.capabilities });
    expect(res.kind).toBe("completed");
    expect(rec.phases).toEqual([{ name: "Install dependencies", opts: { id: "install" } }]);
    expect(rec.agentCalls.map((c) => c.prompt)).toEqual(["go"]);
  });

  it("serves shell / usage.get / auth over the protocol", async () => {
    const rec = recordingCapabilities();
    const source = `
      import { shell, usage, auth } from "@boardwalk-labs/workflow";
      export default async function run() {
        const sh = await shell("echo hi");
        const u = await usage.get();
        const id = await auth.idToken("sts.amazonaws.com");
        const api = await auth.apiToken();
        return { sh, usd: u.usd, id, api };
      }
    `;
    const res = await runSource("run_caps", source, null, { capabilities: rec.capabilities });
    expect(res.kind).toBe("completed");
    expect(rec.shells).toEqual(["echo hi"]);
    expect(outputOf(res)).toEqual({
      sh: { exitCode: 0, stdout: "ran:echo hi", stderr: "" },
      usd: { spent: 0.5, cap: 2, remaining: 1.5 },
      id: "jwt-for-sts.amazonaws.com",
      api: "api-token-1",
    });
  });

  it("supports parallel fan-out of agent leaves", async () => {
    const rec = recordingCapabilities();
    const source = `
      import { agent, parallel } from "@boardwalk-labs/workflow";
      export default async function run() {
        await parallel([() => agent("a"), () => agent("b"), () => agent("c")]);
      }
    `;
    const res = await runSource("run_4", source, null, { capabilities: rec.capabilities });
    expect(res.kind).toBe("completed");
    expect(rec.agentCalls.map((c) => c.prompt).sort()).toEqual(["a", "b", "c"]);
  });

  it("aborts context.signal when the run's signal fires (the cancel notification)", async () => {
    const controller = new AbortController();
    const rec = recordingCapabilities({
      agent: () => {
        // Mid-leaf, the run is cancelled: the server pushes `cancel`, the SDK aborts the signal.
        controller.abort();
        return Promise.resolve("leaf-done");
      },
    });
    const source = `
      import { agent } from "@boardwalk-labs/workflow";
      export default async function run(input, context) {
        const aborted = new Promise((resolve) => {
          context.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
        });
        await agent("trigger cancel");
        return await aborted;
      }
    `;
    const res = await runSource("run_cancel", source, null, {
      capabilities: rec.capabilities,
      signal: controller.signal,
    });
    expect(outputOf(res)).toBe("aborted");
  });
});

describe("runWorkflowProgram — failures", () => {
  it("maps a run() throw to a failed result", async () => {
    const res = await runSource(
      "run_6",
      `export default function run() { throw new Error("boom in program"); }`,
      null,
      { capabilities: recordingCapabilities().capabilities },
    );
    expect(res.kind).toBe("failed");
    expect(errorOf(res)?.message).toContain("boom in program");
  });

  it("maps a rejected await (a failing leaf) to a failed result", async () => {
    const rec = recordingCapabilities({
      agent: () => Promise.reject(new Error("leaf exploded")),
    });
    const source = `
      import { agent } from "@boardwalk-labs/workflow";
      export default async function run() { await agent("will reject"); }
    `;
    const res = await runSource("run_7", source, null, { capabilities: rec.capabilities });
    expect(res.kind).toBe("failed");
    expect(errorOf(res)?.message).toContain("leaf exploded");
  });

  it("surfaces a malformed program (syntax error) as a failed result", async () => {
    const res = await runSource("run_8", `const x = ;`, null, {
      capabilities: recordingCapabilities().capabilities,
    });
    expect(res.kind).toBe("failed");
  });

  it("fails a module body that throws at import time (import is no longer running)", async () => {
    const res = await runSource(
      "run_importthrow",
      `throw new Error("top-level boom");\nexport default function run() {}`,
      null,
      { capabilities: recordingCapabilities().capabilities },
    );
    expect(res.kind).toBe("failed");
    expect(errorOf(res)?.message).toContain("top-level boom");
  });

  it("applies redactText to a thrown error message", async () => {
    const res = await runSource(
      "run_10",
      `export default function run() { throw new Error("boom token-abc123xyz789 here"); }`,
      null,
      {
        capabilities: recordingCapabilities().capabilities,
        redactText: (s) => s.split("token-abc123xyz789").join("[REDACTED]"),
      },
    );
    expect(res.kind).toBe("failed");
    expect(errorOf(res)?.message).toBe("boom [REDACTED] here");
  });

  it("surfaces a thrown error's `hint` (an engine EngineError, duck-typed) on the failed result", async () => {
    const engineError = Object.assign(new Error("agent() got a string in `tools`."), {
      hint: 'Built-in tools are on by default — write `builtins: ["bash"]`.',
    });
    const rec = recordingCapabilities({ agent: () => Promise.reject(engineError) });
    const source = `
      import { agent } from "@boardwalk-labs/workflow";
      export default async function run() { await agent("boom"); }
    `;
    const res = await runSource("run_hint", source, null, { capabilities: rec.capabilities });
    expect(res.kind).toBe("failed");
    expect(errorOf(res)?.message).toContain("got a string");
    // The hint SURVIVES the wire: protocolErrorOf carries it on data.hint, and the failure
    // curation reads it back — the hint-reaches-hosted-authors contract.
    expect(errorOf(res)?.hint).toBe(
      'Built-in tools are on by default — write `builtins: ["bash"]`.',
    );
  });

  it("keeps the SEMANTIC code of a capability error thrown host-side", async () => {
    const engineError = Object.assign(new Error("bad tools"), { code: "VALIDATION" });
    const rec = recordingCapabilities({ agent: () => Promise.reject(engineError) });
    const source = `
      import { agent } from "@boardwalk-labs/workflow";
      export default async function run() { await agent("boom"); }
    `;
    const res = await runSource("run_code", source, null, { capabilities: rec.capabilities });
    expect(errorOf(res)?.code).toBe("VALIDATION");
  });

  it("falls back to the class name when the error carries no code", async () => {
    const res = await runSource(
      "run_code_plain",
      `export default function run() { throw new TypeError("plain"); }`,
      null,
      { capabilities: recordingCapabilities().capabilities },
    );
    expect(errorOf(res)?.code).toBe("TypeError");
  });

  it("keeps a Node syscall code (it is code-shaped and more useful than `Error`)", async () => {
    const res = await runSource(
      "run_code_enoent",
      `import { readFileSync } from "node:fs";
       export default function run() { readFileSync("/definitely/not/here"); }`,
      null,
      { capabilities: recordingCapabilities().capabilities },
    );
    expect(errorOf(res)?.code).toBe("ENOENT");
  });

  it("redacts the code too (it is read off an author-controlled throw)", async () => {
    const res = await runSource(
      "run_code_redact",
      `export default function run() {
         throw Object.assign(new Error("boom"), { code: "TOKEN_ABC123XYZ789" });
       }`,
      null,
      {
        capabilities: recordingCapabilities().capabilities,
        redactText: (s) => s.split("TOKEN_ABC123XYZ789").join("[REDACTED]"),
      },
    );
    expect(errorOf(res)?.code).toBe("[REDACTED]");
  });

  it("redacts the hint too (it is built from the same untrusted inputs as the message)", async () => {
    const res = await runSource(
      "run_hint_redact",
      `export default function run() {
         throw Object.assign(new Error("failed"), { hint: "use token-abc123xyz789 next time" });
       }`,
      null,
      {
        capabilities: recordingCapabilities().capabilities,
        redactText: (s) => s.split("token-abc123xyz789").join("[REDACTED]"),
      },
    );
    expect(errorOf(res)?.hint).toBe("use [REDACTED] next time");
  });
});

describe("runWorkflowProgram — runtime teardown", () => {
  it("resets the SDK's active host after a run (capabilities fail loud again)", async () => {
    await runSource("run_9", `export default function run() {}`, null, {
      capabilities: recordingCapabilities().capabilities,
    });
    // After the run, the active host is cleared AND the socket env is gone, so a stray capability
    // call cannot silently reach a dead server.
    await expect(sdkAgent("after", { model: "anthropic/claude-sonnet-4.5" })).rejects.toThrow(
      /no host available/,
    );
  });
});

describe("ensureSdkLink", () => {
  it("links the runtime's own @boardwalk-labs/workflow into the exec dir", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bw-sdklink-"));
    await ensureSdkLink(dir);
    const link = path.join(dir, "node_modules", "@boardwalk-labs", "workflow");
    const real = await fs.realpath(link);
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
