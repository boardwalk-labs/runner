import { describe, it, expect } from "vitest";
import type { WorkflowHost } from "@boardwalk-labs/workflow/runtime";
import type { Run } from "./wire/run.js";
import { SecretRedactor } from "./agent/secret_redactor.js";
import {
  runProgramWorker,
  type ProgramWorkerDeps,
  type RunClaimer,
  type ProgramVersionReader,
  type ProgramRef,
  type RunFinalizer,
} from "./program_worker.js";
import { buildSingleFileArtifact } from "./testing_artifact_build.js";
import { extract as tarExtract } from "tar";

function fakeRun(over: Partial<Run> = {}): Run {
  return {
    id: "run_1",
    orgId: "org_1",
    workflowId: "wf_1",
    workflowVersionId: "ver_1",
    input: { name: "world" },
    triggerPayload: null,
    ...over,
  } as Run;
}

const VALID_MANIFEST = {
  slug: "demo",
  triggers: [{ kind: "manual" }],
};

// The default program the worker fetches + verifies + extracts + runs (a tiny one-leaf program). Built
// into a real artifact so the worker's download→verify→extract→import path runs end-to-end in the test.
const DEFAULT_PROGRAM_SOURCE = `import { agent } from "@boardwalk-labs/workflow";\nawait agent("go");`;
const DEFAULT_ARTIFACT = buildSingleFileArtifact(DEFAULT_PROGRAM_SOURCE);
const DEFAULT_PROGRAM: ProgramRef = {
  entry: DEFAULT_ARTIFACT.entry,
  digest: DEFAULT_ARTIFACT.digest,
  sdkVersion: "*",
  downloadUrl: "https://broker/program",
};

interface Harness {
  deps: ProgramWorkerDeps;
  /** Runtime-flusher lifecycle capture (start, timer-stop, and terminal-tail flush counts). */
  runtimeFlush: { started: number; stopped: number; flushedFinal: number };
  finalized: { status: string; output: unknown }[];
  hostCalls: { agent: string[]; sleeps: unknown[]; phases: string[] };
  phaseCloses: string[];
  /** The run's redactor — seed it with `record(value)` to assert terminal-error scrubbing. */
  redactor: SecretRedactor;
  /** Credit-watch lifecycle capture (start + stop counts). */
  credit: { started: number; stopped: number };
  /** Cancel-watch lifecycle capture (start + stop counts). */
  cancel: { started: number; stopped: number };
  /** Lease-renew lifecycle capture (start + stop counts). */
  lease: { started: number; stopped: number };
  /** Workspace hydrate/persist capture (only when persistWorkspace is set). */
  workspace: { hydrated: number; persisted: number };
  /** Per-run LSP close capture (only when withLsp is set) — asserts teardown on every terminal path. */
  lsp: { closed: number };
  /** Browser-session reap capture (only when withBrowser is set) — asserts closeAll on every terminal path. */
  browser: { closed: number };
  /** ensureWorkspace (mkdir /workspace) call count — fires on EVERY run, persist or not. */
  ensured: { count: number };
  /** Ordered log of workspace-prep steps ("ensure" then "hydrate") to assert ordering. */
  order: string[];
}

function harness(
  over: {
    claim?: Run | null;
    version?: { manifest: unknown; program: ProgramRef } | null;
    /** Custom program to build + fetch + run (defaults to the one-leaf DEFAULT program). */
    programSource?: string;
    /** When true, the broker download returns bytes that don't match the pinned digest (integrity fail). */
    corruptDownload?: boolean;
    now?: () => number;
    /** When true, the credit watcher reports exhaustion immediately on start (org out of credit). */
    exhaustCredit?: boolean;
    /** When true, the cancel watcher reports a user cancel immediately on start. */
    cancelRun?: boolean;
    /** When true, the lease renewer reports the lease lost immediately on start (another worker
     *  reclaimed the run). */
    loseLease?: boolean;
    /** When true, buildHost returns a workspace handle (the manifest opted into persistence). */
    persistWorkspace?: boolean;
    /** When true, buildHost returns a per-run LSP handle (the worker always wires one on hosted runs). */
    withLsp?: boolean;
    /** When true, buildHost returns a browser-session manager (image ships the browser stack). */
    withBrowser?: boolean;
    /** When true, ensureWorkspace rejects — asserts best-effort (the run still proceeds). */
    ensureWorkspaceThrows?: boolean;
  } = {},
): Harness {
  const runtimeFlush = { started: 0, stopped: 0, flushedFinal: 0 };
  const finalized: { status: string; output: unknown }[] = [];
  const workspace = { hydrated: 0, persisted: 0 };
  const lsp = { closed: 0 };
  const browser = { closed: 0 };
  const ensured = { count: 0 };
  const order: string[] = [];
  const hostCalls = { agent: [] as string[], sleeps: [] as unknown[], phases: [] as string[] };
  const phaseCloses: string[] = [];
  let phaseActive = false;

  const runs: RunClaimer = {
    claimForWorker: () => Promise.resolve(over.claim === undefined ? fakeRun() : over.claim),
  };
  // The program the worker fetches + verifies + runs: a per-test custom one, or the default leaf.
  const artifact =
    over.programSource !== undefined
      ? buildSingleFileArtifact(over.programSource)
      : DEFAULT_ARTIFACT;
  const program: ProgramRef = {
    entry: artifact.entry,
    digest: artifact.digest,
    sdkVersion: "*",
    downloadUrl: "https://broker/program",
  };
  const versions: ProgramVersionReader = {
    getById: () =>
      Promise.resolve(
        over.version === undefined ? { manifest: VALID_MANIFEST, program } : over.version,
      ),
  };
  const finalizer: RunFinalizer = {
    finalize: (_id, status, output) => {
      finalized.push({ status, output });
      return Promise.resolve();
    },
  };
  const host: WorkflowHost = {
    setPhase: (name) => {
      hostCalls.phases.push(name);
      phaseActive = true;
    },
    agent: (prompt) => {
      hostCalls.agent.push(prompt);
      return Promise.resolve("leaf-result");
    },
    callWorkflow: () => Promise.resolve(null),
    sleep: (arg) => {
      hostCalls.sleeps.push(arg);
      return Promise.resolve();
    },
    getSecret: () => Promise.resolve("sek"),
  };

  const redactor = new SecretRedactor();
  const credit = { started: 0, stopped: 0 };
  const cancel = { started: 0, stopped: 0 };
  const lease = { started: 0, stopped: 0 };

  return {
    runtimeFlush,
    finalized,
    hostCalls,
    phaseCloses,
    redactor,
    credit,
    cancel,
    lease,
    workspace,
    lsp,
    browser,
    ensured,
    order,
    deps: {
      runs,
      versions,
      fetchProgram: () =>
        Promise.resolve(over.corruptDownload ? new Uint8Array([0, 1, 2]) : artifact.tarball),
      extractArchive: async (tgzPath, destDir) => {
        await tarExtract({ file: tgzPath, cwd: destDir });
      },
      ensureWorkspace: () => {
        ensured.count += 1;
        order.push("ensure");
        return over.ensureWorkspaceThrows === true
          ? Promise.reject(new Error("mkdir failed"))
          : Promise.resolve();
      },
      finalizer,
      buildHost: () =>
        Promise.resolve({
          host,
          redactor,
          phases: {
            close: (status: "completed" | "failed" | "cancelled") => {
              if (!phaseActive) return;
              phaseCloses.push(status);
              phaseActive = false;
            },
          },
          ...(over.persistWorkspace === true
            ? {
                workspace: {
                  hydrate: () => {
                    order.push("hydrate");
                    workspace.hydrated += 1;
                    return Promise.resolve();
                  },
                  persist: () => {
                    workspace.persisted += 1;
                    return Promise.resolve(0);
                  },
                },
              }
            : {}),
          ...(over.withLsp === true
            ? {
                lsp: {
                  close: () => {
                    lsp.closed += 1;
                    return Promise.resolve();
                  },
                },
              }
            : {}),
          ...(over.withBrowser === true
            ? {
                browserSessions: {
                  closeAll: () => {
                    browser.closed += 1;
                    return Promise.resolve();
                  },
                },
              }
            : {}),
        }),
      startCreditWatch: ({ onExhausted }) => {
        credit.started += 1;
        // Simulate the org being out of credit: fire exhaustion (→ the orchestrator aborts the run).
        if (over.exhaustCredit === true) onExhausted();
        return {
          stop: () => {
            credit.stopped += 1;
            return Promise.resolve();
          },
        };
      },
      startCancelWatch: ({ onCancelled }) => {
        cancel.started += 1;
        // Simulate the user cancelling: fire cancel (→ the orchestrator aborts the run).
        if (over.cancelRun === true) onCancelled();
        return {
          stop: () => {
            cancel.stopped += 1;
            return Promise.resolve();
          },
        };
      },
      startLeaseRenew: ({ onLost }) => {
        lease.started += 1;
        // Simulate another worker reclaiming the run: fire lease-lost (→ the orchestrator aborts).
        if (over.loseLease === true) onLost();
        return {
          stop: () => {
            lease.stopped += 1;
            return Promise.resolve();
          },
        };
      },
      startRuntimeFlush: () => {
        runtimeFlush.started += 1;
        return {
          stop: () => {
            runtimeFlush.stopped += 1;
            return Promise.resolve();
          },
          flushFinal: () => {
            runtimeFlush.flushedFinal += 1;
            return Promise.resolve();
          },
        };
      },
      workerId: "worker-1",
      ...(over.now ? { now: over.now } : {}),
    },
  };
}

describe("runProgramWorker — happy path", () => {
  it("claims, runs the program, charges runtime, and finalizes completed", async () => {
    let t = 1_000_000;
    const now = (): number => {
      const v = t;
      t += 4000; // 4s elapses between the two now() reads (claim baseline → charge)
      return v;
    };
    const h = harness({ now });
    const outcome = await runProgramWorker("run_1", h.deps);

    expect(outcome).toEqual({ kind: "completed" });
    expect(h.hostCalls.agent).toEqual(["go"]); // the program's agent("go") reached the host
    expect(h.runtimeFlush).toEqual({ started: 1, stopped: 1, flushedFinal: 1 });
    expect(h.finalized).toEqual([{ status: "completed", output: null }]);
    // Token metering is now per-leaf (see leaf_executor `meterUsage`), so there is no run-level
    // metering loop here; the credit watcher still ran for the session and was stopped at terminal.
    expect(h.credit).toEqual({ started: 1, stopped: 1 });
  });

  it("injects the trigger input into the program", async () => {
    const h = harness({
      claim: fakeRun({ input: { topic: "payments" } }),
      programSource: `import { agent, input } from "@boardwalk-labs/workflow"; await agent("triage " + JSON.stringify(input));`,
    });
    await runProgramWorker("run_1", h.deps);
    expect(h.hostCalls.agent).toEqual(['triage {"topic":"payments"}']);
  });

  it("runs Phase markers and closes the active phase completed at terminal", async () => {
    const h = harness({
      programSource: `
          import { phase, agent } from "@boardwalk-labs/workflow";
          phase("Install dependencies");
          await agent("go");
        `,
    });
    const outcome = await runProgramWorker("run_1", h.deps);
    expect(outcome).toEqual({ kind: "completed" });
    expect(h.hostCalls.phases).toEqual(["Install dependencies"]);
    expect(h.phaseCloses).toEqual(["completed"]);
  });
});

describe("runProgramWorker — workspace persistence", () => {
  it("hydrates before the program and persists at terminal when opted in", async () => {
    const h = harness({ persistWorkspace: true });
    const outcome = await runProgramWorker("run_1", h.deps);
    expect(outcome).toEqual({ kind: "completed" });
    expect(h.workspace).toEqual({ hydrated: 1, persisted: 1 });
  });

  it("persists even when the program fails", async () => {
    const h = harness({
      persistWorkspace: true,
      programSource: `throw new Error("boom");`,
    });
    await runProgramWorker("run_1", h.deps);
    expect(h.workspace.persisted).toBe(1);
  });

  it("reaps every open browser session at terminal (success)", async () => {
    const h = harness({ withBrowser: true });
    const outcome = await runProgramWorker("run_1", h.deps);
    expect(outcome).toEqual({ kind: "completed" });
    expect(h.browser.closed).toBe(1);
  });

  it("reaps browser sessions even when the program fails", async () => {
    const h = harness({ withBrowser: true, programSource: `throw new Error("boom");` });
    await runProgramWorker("run_1", h.deps);
    expect(h.browser.closed).toBe(1);
  });

  it("does nothing when the workflow didn't opt in (no workspace handle)", async () => {
    const h = harness(); // persistWorkspace not set → buildHost returns no workspace
    await runProgramWorker("run_1", h.deps);
    expect(h.workspace).toEqual({ hydrated: 0, persisted: 0 });
  });
});

describe("runProgramWorker — per-run LSP teardown (no leaked language-server process)", () => {
  it("closes the per-run LSP at run end on the success path", async () => {
    const h = harness({ withLsp: true });
    const outcome = await runProgramWorker("run_1", h.deps);
    expect(outcome).toEqual({ kind: "completed" });
    expect(h.lsp.closed).toBe(1);
  });

  it("closes the per-run LSP even when the program fails", async () => {
    const h = harness({ withLsp: true, programSource: `throw new Error("boom");` });
    const outcome = await runProgramWorker("run_1", h.deps);
    expect(outcome.kind).toBe("failed");
    expect(h.lsp.closed).toBe(1);
  });

  it("closes the per-run LSP even when the lease is lost mid-run (the early-return path)", async () => {
    // Lease lost returns before finalize, but the `finally` still runs — so the LSP must still close.
    const h = harness({ withLsp: true, loseLease: true });
    const outcome = await runProgramWorker("run_1", h.deps);
    expect(outcome).toEqual({ kind: "claim_lost" });
    expect(h.lsp.closed).toBe(1);
  });

  it("does nothing when buildHost returned no LSP handle (the local/test path)", async () => {
    const h = harness(); // withLsp not set → buildHost returns no lsp handle
    await runProgramWorker("run_1", h.deps);
    expect(h.lsp.closed).toBe(0);
  });
});

describe("runProgramWorker — /workspace always exists (no defensive mkdir needed)", () => {
  it("ensures /workspace on EVERY run, even when persistence is NOT opted in", async () => {
    const h = harness(); // no persistence opt-in
    const outcome = await runProgramWorker("run_1", h.deps);
    expect(outcome).toEqual({ kind: "completed" });
    expect(h.ensured.count).toBe(1); // the dir is guaranteed regardless of persist
    expect(h.order).toEqual(["ensure"]); // no hydrate (not opted in), but ensure still ran
  });

  it("ensures /workspace BEFORE hydrating a snapshot (hydrate's extract targets the dir)", async () => {
    const h = harness({ persistWorkspace: true });
    await runProgramWorker("run_1", h.deps);
    expect(h.ensured.count).toBe(1);
    expect(h.order).toEqual(["ensure", "hydrate"]);
  });

  it("is best-effort: a failing ensureWorkspace is swallowed, the run still completes", async () => {
    const h = harness({ ensureWorkspaceThrows: true });
    const outcome = await runProgramWorker("run_1", h.deps);
    expect(outcome).toEqual({ kind: "completed" });
    expect(h.ensured.count).toBe(1);
  });
});

describe("runProgramWorker — pre-flight failures (no charge)", () => {
  it("returns claim_lost without charging or finalizing when the claim is lost", async () => {
    const h = harness({ claim: null });
    const outcome = await runProgramWorker("run_1", h.deps);
    expect(outcome).toEqual({ kind: "claim_lost" });
    expect(h.runtimeFlush.flushedFinal).toBe(0);
    expect(h.finalized).toEqual([]);
    expect(h.credit.started).toBe(0); // no program ran → no credit watcher started
  });

  it("fails (no charge) when the version is missing", async () => {
    const h = harness({ version: null });
    const outcome = await runProgramWorker("run_1", h.deps);
    expect(outcome.kind).toBe("failed");
    expect(h.runtimeFlush.flushedFinal).toBe(0);
    expect(h.finalized[0]?.status).toBe("failed");
  });

  it("fails (no charge) when the downloaded artifact fails the digest check (integrity)", async () => {
    const h = harness({ corruptDownload: true });
    const outcome = await runProgramWorker("run_1", h.deps);
    expect(outcome).toEqual({ kind: "failed", reason: "program_integrity" });
    expect(h.runtimeFlush.flushedFinal).toBe(0); // never ran → no charge
    expect(h.finalized[0]?.status).toBe("failed");
  });

  it("fails (no charge) when the manifest is invalid", async () => {
    const h = harness({
      version: { manifest: { name: "x" }, program: DEFAULT_PROGRAM }, // missing triggers
    });
    const outcome = await runProgramWorker("run_1", h.deps);
    expect(outcome.kind).toBe("failed");
    expect(h.runtimeFlush.flushedFinal).toBe(0);
  });

  it("fails BEFORE running when resumed past budget.deadline_seconds (no agent turn needed)", async () => {
    const h = harness({
      // The run first started 60s ago (it suspended in between); the 25s wall-clock deadline is blown.
      // The program has an agent() call, but the deadline is enforced PRE-RUN so it never executes —
      // this is the no-agent-turn gap the BudgetMeter (per-turn) can't catch.
      claim: fakeRun({ startedAt: Date.now() - 60_000 }),
      version: {
        manifest: { ...VALID_MANIFEST, budget: { deadline_seconds: 25 } },
        program: DEFAULT_PROGRAM,
      },
    });
    const outcome = await runProgramWorker("run_1", h.deps);
    expect(outcome).toEqual({ kind: "failed", reason: "deadline_exceeded" });
    expect(h.runtimeFlush.flushedFinal).toBe(0); // never ran → no charge
    expect(h.hostCalls.agent).toEqual([]); // the program never executed
    expect(h.finalized[0]?.status).toBe("failed");
    expect(JSON.stringify(h.finalized[0]?.output)).toContain("deadline_seconds");
  });

  it("does NOT trip the deadline on a fresh run whose deadline hasn't elapsed", async () => {
    const h = harness({
      claim: fakeRun({ startedAt: Date.now() }), // just started — well within a 25s deadline
      version: {
        manifest: { ...VALID_MANIFEST, budget: { deadline_seconds: 25 } },
        program: DEFAULT_PROGRAM,
      },
    });
    const outcome = await runProgramWorker("run_1", h.deps);
    expect(outcome).toEqual({ kind: "completed" }); // runs to completion normally
    expect(h.hostCalls.agent).toEqual(["go"]);
  });
});

describe("runProgramWorker — program failure (charges, then fails)", () => {
  it("charges runtime then finalizes failed when the program throws", async () => {
    const h = harness({
      programSource: `import { phase } from "@boardwalk-labs/workflow"; phase("Build"); throw new Error("kaboom");`,
    });
    const outcome = await runProgramWorker("run_1", h.deps);
    expect(outcome.kind).toBe("failed");
    expect(h.runtimeFlush.flushedFinal).toBe(1); // the program ran, so runtime IS charged
    expect(h.credit.stopped).toBe(1); // the credit watcher is stopped even on program failure
    expect(h.finalized[0]?.status).toBe("failed");
    expect(JSON.stringify(h.finalized[0]?.output)).toContain("kaboom");
    expect(h.phaseCloses).toEqual(["failed"]);
  });

  it("aborts (terminal failed, credit_exhausted) when the org runs out of credit mid-run", async () => {
    // The credit watcher fires exhaustion → the orchestrator aborts. Even though THIS harness host
    // ignores the signal and the program completes, the abort is authoritative → the run fails.
    // (Host-level honoring of the signal is covered in workflow_host / leaf_executor tests.)
    const h = harness({ exhaustCredit: true });
    const outcome = await runProgramWorker("run_1", h.deps);
    expect(outcome).toEqual({ kind: "failed", reason: "credit_exhausted" });
    // Runtime is still charged (the program ran), and the credit watcher was stopped.
    expect(h.runtimeFlush.flushedFinal).toBe(1);
    expect(h.credit.stopped).toBe(1);
    // The terminal output records the abort reason, not a generic program error.
    expect(h.finalized).toHaveLength(1);
    expect(h.finalized[0]?.status).toBe("failed");
    expect(h.finalized[0]?.output).toMatchObject({
      error: { code: "RUN_ABORTED", reason: "credit_exhausted" },
    });
  });

  it("aborts (terminal failed, cancelled) when the user cancels mid-run", async () => {
    // The cancel watcher fires → the orchestrator aborts with reason `cancelled`. As with credit,
    // the abort is authoritative even though this harness host ignores the signal and the program
    // completes. The worker reports `failed` + reason `cancelled`; the BROKER upgrades the terminal
    // status to `cancelled` (covered in runner_control finalize tests), so it isn't the worker's job.
    const h = harness({ cancelRun: true });
    const outcome = await runProgramWorker("run_1", h.deps);
    expect(outcome).toEqual({ kind: "failed", reason: "cancelled" });
    // Runtime is still charged (the program ran), and both watchers were stopped.
    expect(h.runtimeFlush.flushedFinal).toBe(1);
    expect(h.credit.stopped).toBe(1);
    expect(h.cancel.stopped).toBe(1);
    expect(h.finalized).toHaveLength(1);
    expect(h.finalized[0]?.status).toBe("failed");
    expect(h.finalized[0]?.output).toMatchObject({
      error: { code: "RUN_ABORTED", reason: "cancelled" },
    });
  });

  it("on a lost lease: stops WITHOUT charging or finalizing (the new owner does that)", async () => {
    // The lease renewer reports the lease lost (another worker reclaimed the run) → the orchestrator
    // aborts `lease_lost`. Unlike credit/cancel, this worker must NOT charge runtime or write a
    // terminal status — the reclaiming worker now owns the run; a finalize here would clobber it.
    const h = harness({ loseLease: true });
    const outcome = await runProgramWorker("run_1", h.deps);
    expect(outcome).toEqual({ kind: "claim_lost" });
    expect(h.runtimeFlush.flushedFinal).toBe(0); // no double-charge
    expect(h.finalized).toEqual([]); // no clobbering the new owner's terminal write
    expect(h.lease.started).toBe(1);
    expect(h.lease.stopped).toBe(1); // the renewer is still drained
  });

  it("redacts a resolved secret from a thrown error before finalizing", async () => {
    const secret = "sk-live-supersecret-value-1234";
    const h = harness({
      programSource: `throw new Error("upstream rejected key ${secret}");`,
    });
    // Simulate the program having resolved the secret earlier in the run (secrets.get records it).
    h.redactor.record(secret);

    const outcome = await runProgramWorker("run_1", h.deps);

    expect(outcome.kind).toBe("failed");
    const serialized = JSON.stringify(h.finalized[0]?.output);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
  });
});
