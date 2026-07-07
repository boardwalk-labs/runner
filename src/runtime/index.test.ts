import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleWorkerDeps,
  capturePlatformContext,
  publicApiOrigin,
  PLATFORM_ENV_KEYS,
  tokenMeterIdentifiers,
  workerAuthContext,
  type WorkerRuntime,
} from "./index.js";
import { WorkerWorkflowHost } from "./workflow_host.js";
import { workflowManifestSchema } from "./wire/manifest.js";
import type { Run, RunActor } from "./wire/run.js";

function sampleRun(overrides: Partial<Run> = {}): Run {
  const actor: RunActor = { type: "user", user_id: "01H_user" };
  return {
    id: "01H_run",
    orgId: "01H_org",
    workflowId: "01H_agent",
    workflowVersionId: "01H_v1",
    environmentId: null,

    parentRunId: null,
    actor,
    triggerKind: "manual",
    triggerPayload: null,
    status: "pending",
    input: null,
    config: null,
    output: null,
    concurrencyKey: null,
    state: null,
    leaseUntil: null,
    workerId: null,
    nextWakeAt: null,
    waitingOnRunId: null,
    retriedFromRunId: null,
    startedAt: null,
    completedAt: null,
    createdAt: 1_700_000_000_000,
    pendingSince: 1_700_000_000_000,
    outcomeStatus: null,
    outcomeReasoning: null,
    tokensIn: 0,
    tokensOut: 0,
    runtimeSeconds: 0,
    dispatchAttempts: 0,
    ...overrides,
  };
}

function runtime(): WorkerRuntime {
  return {
    workerId: "task-arn-123",
    workspaceRoot: "/workspace",
    runId: "run-test",
    controlPlane: {
      baseUrl: "https://api.boardwalk.sh",
      runToken: "rt_token",
      apiToken: "api_token",
    },
    vcpus: 1,
  };
}

describe("assembleWorkerDeps", () => {
  it("wires a complete, well-formed ProgramWorkerDeps from the control-plane handle", () => {
    const deps = assembleWorkerDeps(runtime());
    expect(deps.workerId).toBe("task-arn-123");
    expect(deps.runs).toBeDefined();
    expect(deps.versions).toBeDefined();
    expect(deps.finalizer).toBeDefined();
    expect(typeof deps.buildHost).toBe("function");
    // The runner is brokered-only: it needs NO platform primitive (db / redis / billing / sqs /
    // Tavily), so the task role grants nothing and the metadata-endpoint escape has nothing to steal
    // (security). The telemetry buffer is drainable on exit (live-tail via /telemetry).
    expect(typeof deps.flushTelemetry).toBe("function");
  });

  it("ensureWorkspace creates the workspace root (so programs never need a defensive mkdir)", async () => {
    const base = await mkdtemp(join(tmpdir(), "bw-ws-ensure-"));
    const ws = join(base, "workspace"); // does not exist yet
    try {
      const deps = assembleWorkerDeps({ ...runtime(), workspaceRoot: ws });
      const ensure = deps.ensureWorkspace;
      expect(ensure).toBeDefined();
      if (ensure) await ensure();
      expect((await stat(ws)).isDirectory()).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("buildHost constructs a per-run WorkflowHost", async () => {
    const deps = assembleWorkerDeps(runtime());
    const manifest = workflowManifestSchema.parse({
      slug: "demo",
      triggers: [{ kind: "manual" }],
    });
    const { host } = await deps.buildHost(sampleRun(), manifest, new AbortController().signal);
    expect(host).toBeInstanceOf(WorkerWorkflowHost);
  });

  it("buildHost returns a per-run LSP handle the orchestrator closes at run end", async () => {
    // The worker wires ONE LspService per run (held warm by the agent() leaf across edits/leaves) and
    // hands it back so program_worker's terminal `finally` closes it — no leaked language-server
    // process. close() is idempotent + never throws, so calling it here is safe.
    const deps = assembleWorkerDeps(runtime());
    const manifest = workflowManifestSchema.parse({
      slug: "demo",
      triggers: [{ kind: "manual" }],
    });
    const built = await deps.buildHost(sampleRun(), manifest, new AbortController().signal);
    expect(built.lsp).toBeDefined();
    await expect(built.lsp?.close()).resolves.toBeUndefined();
  });
});

describe("assembleWorkerDeps — Runner Control API (the Runner Credential Broker model)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes claim / version / finalize through the broker", async () => {
    const seen: { url: string; method: string | undefined; body: string | undefined }[] = [];
    const fetchStub = vi.fn(
      (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        seen.push({ url, method: init?.method, body: init?.body as string | undefined });
        if (url.endsWith("/claim")) {
          return Promise.resolve(
            new Response(JSON.stringify({ run: sampleRun(), leaseUntil: 1 }), {
              status: 201,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        if (url.endsWith("/version")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                manifest: { name: "demo" },
                program: {
                  entry: "index.mjs",
                  digest: "a".repeat(64),
                  sdkVersion: "*",
                  downloadUrl: "https://s3/get?sig",
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(new Response(null, { status: 204 })); // /finalize
      },
    );
    vi.stubGlobal("fetch", fetchStub);

    const deps = assembleWorkerDeps(runtime());

    const claimed = await deps.runs.claimForWorker("run-test", "worker-1", 300_000, 0);
    const version = await deps.versions.getById("any-version-id");
    await deps.finalizer.finalize("run-test", "completed", null);

    expect(claimed?.id).toBe("01H_run");
    expect(version).toEqual({
      manifest: { name: "demo" },
      program: {
        entry: "index.mjs",
        digest: "a".repeat(64),
        sdkVersion: "*",
        downloadUrl: "https://s3/get?sig",
      },
    });
    expect(seen.map((s) => s.url)).toEqual([
      "https://api.boardwalk.sh/runner/v1/runs/run-test/claim",
      "https://api.boardwalk.sh/runner/v1/runs/run-test/version",
      "https://api.boardwalk.sh/runner/v1/runs/run-test/finalize",
    ]);
    // The absolute lease (300s window from now=0) is converted back to seconds for the broker.
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ workerId: "worker-1", leaseSeconds: 300 });
  });

  it("routes usage / secrets / children through the broker (runtime flush + host seams)", async () => {
    const seen: { url: string; body: string | undefined }[] = [];
    const fetchStub = vi.fn(
      (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        seen.push({ url, body: init?.body as string | undefined });
        if (url.endsWith("/usage")) return Promise.resolve(new Response(null, { status: 204 }));
        if (url.endsWith("/secrets/resolve")) {
          return Promise.resolve(
            new Response(JSON.stringify({ value: "sk-secret" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        // /children create → a fresh pending child (run() returns its id, no poll).
        return Promise.resolve(
          new Response(JSON.stringify({ childRunId: "child_1", status: "pending", output: null }), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
        );
      },
    );
    vi.stubGlobal("fetch", fetchStub);

    const deps = assembleWorkerDeps(runtime());
    const manifest = workflowManifestSchema.parse({
      slug: "demo",
      triggers: [{ kind: "manual" }],
    });
    const { host } = await deps.buildHost(sampleRun(), manifest, new AbortController().signal);

    // Runtime is now metered by the flusher; its final flush books the tail through the broker /usage.
    const runtimeFlush = deps.startRuntimeFlush?.({
      run: sampleRun(),
      startedAtMs: Date.now() - 5000,
    });
    await runtimeFlush?.flushFinal();
    await runtimeFlush?.stop();
    const secret = await host.getSecret("LINEAR_TOKEN");
    if (host.runWorkflow === undefined) throw new Error("host.runWorkflow not wired");
    const childId = await host.runWorkflow("child-wf", { x: 1 }, undefined);

    expect(secret).toBe("sk-secret");
    expect(childId).toBe("child_1");
    const urls = seen.map((s) => s.url);
    expect(urls).toContain("https://api.boardwalk.sh/runner/v1/runs/run-test/usage");
    expect(urls).toContain("https://api.boardwalk.sh/runner/v1/runs/run-test/secrets/resolve");
    expect(urls).toContain("https://api.boardwalk.sh/runner/v1/runs/run-test/children");
  });
});

describe("capturePlatformContext (the run env/credential rules)", () => {
  function platformEnv(): NodeJS.ProcessEnv {
    return {
      RUN_ID: "run-test",
      BOARDWALK_CONTROL_PLANE_URL: "https://api.boardwalk.sh/runner/v1",
      BOARDWALK_RUN_TOKEN: "rt_secret",
      BOARDWALK_API_KEY: "api_secret",
      BOARDWALK_TASK_CPU_UNITS: "2048",
      // A user-owned var that happens to share a former-reserved prefix — must survive untouched.
      BOARDWALK_ORG: "acme",
      MY_APP_URL: "https://acme.test",
    };
  }

  it("captures the platform context into private state", () => {
    const ctx = capturePlatformContext(platformEnv());
    expect(ctx.runId).toBe("run-test");
    expect(ctx.controlPlane).toEqual({
      baseUrl: "https://api.boardwalk.sh/runner/v1",
      runToken: "rt_secret",
      apiToken: "api_secret",
    });
    expect(ctx.vcpus).toBe(2); // 2048 cpu units / 1024
  });

  it("DELETES every platform credential/context key from the env it was passed", () => {
    const env = platformEnv();
    capturePlatformContext(env);
    for (const key of PLATFORM_ENV_KEYS) {
      expect(env[key], `${key} must be scrubbed from process.env`).toBeUndefined();
    }
    // The run token + API token are the credentials a prompt-injected `bash` `printenv` must NOT see.
    expect(env.BOARDWALK_RUN_TOKEN).toBeUndefined();
    expect(env.BOARDWALK_API_KEY).toBeUndefined();
  });

  it("leaves user-owned env (incl. former-reserved prefixes) untouched — the program owns process.env", () => {
    const env = platformEnv();
    capturePlatformContext(env);
    expect(env.BOARDWALK_ORG).toBe("acme");
    expect(env.MY_APP_URL).toBe("https://acme.test");
  });

  it("omits apiToken when no API key was provisioned (dev no-signing-key path)", () => {
    const env = platformEnv();
    delete env.BOARDWALK_API_KEY;
    const ctx = capturePlatformContext(env);
    expect(ctx.controlPlane.apiToken).toBeUndefined();
  });

  it("defaults vCPUs to 1 when the cpu-units hint is absent/invalid", () => {
    const env = platformEnv();
    delete env.BOARDWALK_TASK_CPU_UNITS;
    expect(capturePlatformContext(env).vcpus).toBe(1);
  });

  it("throws on a missing required handle (brokered-only: no fallback)", () => {
    const env = platformEnv();
    delete env.BOARDWALK_RUN_TOKEN;
    expect(() => capturePlatformContext(env)).toThrow(/BOARDWALK_RUN_TOKEN/);
  });
});

describe("publicApiOrigin", () => {
  it("derives the public-API origin from the broker base URL (shared api-server origin)", () => {
    expect(publicApiOrigin("https://api.boardwalk.sh/runner/v1")).toBe("https://api.boardwalk.sh");
    expect(publicApiOrigin("https://api.boardwalk.sh")).toBe("https://api.boardwalk.sh");
  });

  it("falls back to the input unchanged when it can't be parsed", () => {
    expect(publicApiOrigin("not-a-url")).toBe("not-a-url");
  });
});

describe("buildHost — the runtime accessor (import { runtime })", () => {
  it("exposes run ids + a redacted on-demand apiToken, never via process.env", async () => {
    const deps = assembleWorkerDeps(runtime());
    const manifest = workflowManifestSchema.parse({ slug: "demo", triggers: [{ kind: "manual" }] });
    const { host } = await deps.buildHost(sampleRun(), manifest, new AbortController().signal);
    // The host carries the runtime context the SDK `runtime` accessor reads off it (instanceof narrows
    // to the concrete worker host, which has the non-optional `runtime`).
    if (!(host instanceof WorkerWorkflowHost)) throw new Error("expected a WorkerWorkflowHost");
    expect(host.runtime.runId).toBe("01H_run");
    expect(host.runtime.workflowId).toBe("01H_agent");
    expect(host.runtime.orgId).toBe("01H_org");
    // apiUrl is the origin of the broker base URL (the public API shares it).
    expect(host.runtime.apiUrl).toBe("https://api.boardwalk.sh");
    await expect(host.runtime.apiToken()).resolves.toBe("api_token");
  });

  it("rejects apiToken() clearly when no run API token was provisioned", async () => {
    const deps = assembleWorkerDeps({
      ...runtime(),
      controlPlane: { baseUrl: "https://api.boardwalk.sh", runToken: "rt_token" },
    });
    const manifest = workflowManifestSchema.parse({ slug: "demo", triggers: [{ kind: "manual" }] });
    const { host } = await deps.buildHost(sampleRun(), manifest, new AbortController().signal);
    if (!(host instanceof WorkerWorkflowHost)) throw new Error("expected a WorkerWorkflowHost");
    await expect(host.runtime.apiToken()).rejects.toThrow(/not provisioned a public-API token/);
  });
});

describe("tokenMeterIdentifiers", () => {
  it("mints a UNIQUE identifier for every call on the SAME leaf (per-turn metering)", () => {
    // The regression: `meterUsage` fires once per model turn, but a per-leaf-only key made every turn
    // after the first a duplicate the display aggregate dropped (onConflictDoNothing) — so a multi-turn
    // leaf's tokens collapsed to its first turn. Three turns on leaf 1 must yield three distinct keys.
    const next = tokenMeterIdentifiers("run_1", "sess_1");
    const ids = [next(1), next(1), next(1)];
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(["run_1:sess_1:1:0", "run_1:sess_1:1:1", "run_1:sess_1:1:2"]);
  });

  it("encodes run, session, leaf, and a monotonic per-session turn sequence", () => {
    const next = tokenMeterIdentifiers("run_1", "sess_1");
    // The sequence is per-session (shared across leaves), so interleaved leaves still never collide.
    expect(next(1)).toBe("run_1:sess_1:1:0");
    expect(next(2)).toBe("run_1:sess_1:2:1");
    expect(next(1)).toBe("run_1:sess_1:1:2");
  });

  it("never collides across sessions, so a restarted run re-meters instead of deduping", () => {
    // A restart genuinely re-spends inference; the fresh meteringSessionId must make its events new
    // (not dedupe against the prior session's at the same leaf/seq).
    const first = tokenMeterIdentifiers("run_1", "sess_A");
    const second = tokenMeterIdentifiers("run_1", "sess_B");
    expect(first(1)).toBe("run_1:sess_A:1:0");
    expect(second(1)).toBe("run_1:sess_B:1:0");
    expect(first(1)).not.toBe(second(1));
  });
});

describe("workerAuthContext", () => {
  it("carries the run's org + owner role for a user-triggered run", () => {
    const ctx = workerAuthContext(sampleRun());
    expect(ctx).toEqual({
      userId: "01H_user",
      orgId: "01H_org",
      role: "owner",
      // 'workflow', not 'session_jwt' — the program can't do SESSION_JWT_ONLY mutations.
      source: "workflow",
    });
  });

  it("uses the non-session 'workflow' source so SESSION_JWT_ONLY actions are denied", () => {
    expect(workerAuthContext(sampleRun()).source).toBe("workflow");
  });

  it("derives a workflow principal for a workflow-triggered run", () => {
    const ctx = workerAuthContext(
      sampleRun({
        actor: {
          type: "workflow",
          parent_run_id: "01H_parent",
          parent_workflow_id: "01H_pagent",
          user_id: "01H_user",
        },
        workflowId: "01H_child",
      }),
    );
    expect(ctx.userId).toBe("workflow:01H_child");
    expect(ctx.orgId).toBe("01H_org");
  });
});
