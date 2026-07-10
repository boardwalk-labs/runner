// program_worker — the JS-body worker orchestration (the workflow runtime design).
//
// Replaces the checkpoint-and-resume run_worker. One run, claim to terminal:
//   1. Race-safe claim (pending → running). Lose the race → exit.
//   2. Load the pinned version (manifest + program source). Bad/missing → fail pre-flight (no charge).
//   3. Build the per-run WorkflowHost (agent() leaf, sleep-hold, workflows.call, secrets).
//   4. Run the program to completion (it HOLDS in-process on sleep / child waits — no exit, no
//      checkpoint). A crash restarts the run from the top (Lambda/GHA semantics), handled by the
//      scheduler-sweep, not here.
//   5. Charge the runtime this session consumed, then finalize completed/failed (or, if the run was
//      aborted mid-flight — credit exhaustion — finalize failed with the abort reason).
//
// While the program runs, two per-session loops watch it (both brokered): a UsageFlusher meters token
// deltas and a CreditWatcher polls the org's funding. When credit hits zero the watcher
// aborts the run's AbortSignal, which the WorkflowHost honors at every hook (cooperative
// cancellation, run_abort.ts) — `signal.aborted` is authoritative for the terminal status.
//
// What's gone vs. the old worker: no checkpoint load/pause, no resume, no sleep/wait_for_child
// pause outcomes (the program holds), no per-turn transcript. The agent loop now lives one
// level down, behind the host's agent() leaf.
//
// v0 deferral (a clear seam): run-level outcome validation (needs program output capture).

import { createLogger } from "./support/index.js";
import type { Run } from "./wire/run.js";
import { workflowManifestSchema, type WorkflowManifest } from "./wire/manifest.js";
import type { WorkflowHost } from "@boardwalk-labs/workflow/runtime";
import type { SecretRedactor } from "./agent/secret_redactor.js";
// Import from the pure file (NOT the domain/workflow barrel, which pulls in `typescript`) so the
// worker bundle stays free of the TS compiler — the worker never transpiles.
import { verifyArtifactDigest } from "./wire/artifact_verify.js";
import { runWorkflowProgram, type ProgramResult } from "./program_runner.js";
import { captureConsole, type LogStream } from "./program_log_capture.js";
import { RunAbortedError, abortReason } from "./run_abort.js";
import type { SuspendSignal } from "./suspension.js";

const log = createLogger("ProgramWorker");

/** Default 5-minute lease (matches the engine spec). */
export const DEFAULT_LEASE_MS = 5 * 60 * 1000;

/** Race-safe claim surface — RunRepository satisfies it. */
export interface RunClaimer {
  claimForWorker(
    runId: string,
    workerId: string,
    leaseUntil: number,
    nowMs: number,
  ): Promise<Run | null>;
}

/** The pinned program's download reference (the worker fetches + verifies + extracts it). */
export interface ProgramRef {
  entry: string;
  digest: string;
  sdkVersion: string;
  downloadUrl: string;
}

/** Reads the pinned version's manifest + program artifact reference. */
export interface ProgramVersionReader {
  getById(id: string): Promise<{ manifest: unknown; program: ProgramRef } | null>;
}

/** Books the run's RUNTIME usage as periodic deltas (the worker's RuntimeFlusher). The
 *  orchestrator drives the lifecycle: the timer flushes mid-run, `stop()` halts it at the body's end,
 *  and `flushFinal()` books the tail on a clean terminal (skipped on a `lease_lost` handoff — the new
 *  owner books its own runtime). Replaces the old single terminal runtime charge. */
export interface RuntimeFlushHandle {
  /** Stop the periodic flush timer (does NOT book the tail). */
  stop(): Promise<void>;
  /** Book the remaining runtime since the last flush (the terminal tail). */
  flushFinal(): Promise<void>;
}

/** Starts periodic runtime metering for a claimed run. `startedAtMs` is this session's claim time (the
 *  point runtime begins accruing). Optional: absent disables runtime metering (the local/test path). */
export type RuntimeMeterStarter = (args: { run: Run; startedAtMs: number }) => RuntimeFlushHandle;

/** Marks a run terminal (status + output/error + completedAt + lease release). */
export interface RunFinalizer {
  finalize(runId: string, status: "completed" | "failed", output: unknown): Promise<void>;
}

/** Persists a durable SUSPENSION (the durable-suspension design): the broker records the wake condition (a
 *  pending/suspended journal entry + a human-input request row for HITL, or the wake time for a long
 *  sleep), flips the run to its suspended status, and releases the lease — all transactionally. The
 *  run is NOT finalized; a wake (an answer, a child finalize, or a timer) re-dispatches it. */
export interface RunSuspender {
  suspend(signal: SuspendSignal, workerId: string): Promise<void>;
}

/** Restores/snapshots the workflow's persistent `/workspace`. Best-effort — both no-op when the
 *  run isn't eligible (not opted-in / self-hosted), and neither throws. */
export interface WorkspaceHandle {
  hydrate(): Promise<void>;
  /** Returns the snapshot byte size (0 on no-op) for the orchestrator's logging. */
  persist(): Promise<number>;
}

export interface PhaseLifecycleHandle {
  close(status: "completed" | "failed" | "cancelled"): void;
}

/** The run's engine-native LSP service (the engine's `LspService` satisfies it). Constructed once per
 *  run (not per leaf) so the language server stays warm across the run's edits/leaves; the orchestrator
 *  closes it on teardown so no language-server process leaks. `close()` is idempotent + never throws. */
export interface LspLifecycleHandle {
  close(): Promise<void>;
}

/** Emits the program's declared `output` onto the run's event stream (v1 `output` kind). */
export interface RunOutputHandle {
  output(value: unknown): void;
}

/** Builds the per-run host (leaf + sleep + children + secrets) for a claimed run. Receives the run's
 *  cooperative-cancellation `signal` so every host hook honors it (credit exhaustion / cancel).
 *  Returns the run's `SecretRedactor` alongside the host so the orchestrator can scrub a terminal
 *  error with the SAME instance every resolved secret was recorded into; `readUsage` — a
 *  sampler over the run-level BudgetMeter the token flusher meters from; and an optional `workspace`
 *  handle (when the workflow opted into persistence) the orchestrator hydrates at start + persists at
 *  terminal (the host's `sleep` also persists, wired inside buildHost). */
export type ProgramHostBuilder = (
  run: Run,
  manifest: WorkflowManifest,
  signal: AbortSignal,
) => Promise<{
  host: WorkflowHost;
  redactor: SecretRedactor;
  workspace?: WorkspaceHandle;
  phases?: PhaseLifecycleHandle;
  /** The run's engine-native LSP service (constructed per run; held by the `agent()` leaf). The
   *  orchestrator closes it on terminal — success AND failure — so no language-server process leaks.
   *  Optional — absent on paths with no LSP (the local/test path). */
  lsp?: LspLifecycleHandle;
  /** Emits the program's declared output onto the run's event stream. */
  activity?: RunOutputHandle;
  /** Records the extracted program directory once the runner unpacks the artifact, so the `agent()`
   *  leaf can resolve this run's bundled skill files (`<dir>/skills/<name>.md`). The orchestrator wires
   *  it to the runner's `onExtracted`. Optional — absent on paths that don't surface bundled files. */
  setProgramDir?: (dir: string) => void;
  /** Resolves when a host seam SUSPENDS the run — wired to the host's `onSuspend`, threaded into the
   *  program runner so a suspend short-circuits the body out of band (the durable-suspension design). Absent ⇒
   *  no durable suspension on this path (a suspend then surfaces as a thrown SuspendError). */
  suspendSignal?: Promise<SuspendSignal>;
  /** The run's browser-session manager (browser tier). The orchestrator reaps every still-open session
   *  on EVERY terminal path so no Chromium / Playwright MCP process leaks past the run. `closeAll` is
   *  best-effort + never throws. Absent on images without the browser stack. */
  browserSessions?: { closeAll(): Promise<void> };
  /** Session recording + live-view capture (docs/SCREEN_CAPTURE.md). The orchestrator starts it before
   *  the program runs and flushes it on EVERY terminal path. Best-effort; absent without the desktop
   *  stack. */
  capture?: { start(): Promise<void>; stopAndFlush(): Promise<void> };
}>;

/** Handle to a running per-session loop (metering or credit watch); `stop()` ends + drains it. */
export interface RunSessionHandle {
  stop(): Promise<void>;
}

/** Starts mid-run credit watching for a claimed run (the worker wires it to a CreditWatcher → broker
 *  `/credit`). `onExhausted` fires once when the org runs out of credit — the orchestrator aborts the
 *  run. Optional: absent disables credit watching. */
export type CreditWatchStarter = (args: { run: Run; onExhausted: () => void }) => RunSessionHandle;

/** Starts mid-run user-cancel watching for a claimed run (the worker wires it to a CancelWatcher →
 *  broker `/cancel`). `onCancelled` fires once when the user cancels — the orchestrator aborts the run.
 *  Optional: absent disables cancel watching (e.g. the local/pre-broker path). */
export type CancelWatchStarter = (args: { run: Run; onCancelled: () => void }) => RunSessionHandle;

/** Starts periodic lease renewal for a claimed run (the worker wires it to a LeaseRenewer → broker
 *  `/renew`), so a run longer than the lease isn't reclaimed mid-flight. `onLost` fires once if the
 *  lease is definitively lost (another worker reclaimed it) — the orchestrator aborts `lease_lost`,
 *  and the run stops WITHOUT finalizing. Optional: absent disables renewal (the local/pre-broker path). */
export type LeaseWatchStarter = (args: { run: Run; onLost: () => void }) => RunSessionHandle;

export interface ProgramWorkerDeps {
  runs: RunClaimer;
  versions: ProgramVersionReader;
  /** Download the program artifact bytes from the broker's presigned URL (broker.downloadBytes). */
  fetchProgram: (downloadUrl: string) => Promise<Uint8Array>;
  /** Extract a gzipped tar into a dir (system `tar`); passed through to the program runner. */
  extractArchive: (tgzPath: string, destDir: string) => Promise<void>;
  /** Ensure the run's `/workspace` sandbox dir exists BEFORE the program runs — on EVERY run
   *  (persist or not, snapshot or not). This makes "`/workspace` always exists" a guaranteed
   *  contract a program can rely on, so authors write to `/workspace` WITHOUT a defensive `mkdir`.
   *  Wired by the entrypoint to `mkdir(workspaceRoot, { recursive: true })`. Optional (the
   *  local/test path may omit it); best-effort — a failure is logged, not thrown (the program's
   *  own write would surface the real error, and the image already pre-creates the dir). */
  ensureWorkspace?: () => Promise<void>;
  /** Periodic runtime metering (optional — absent disables it, e.g. the local/test path). */
  startRuntimeFlush?: RuntimeMeterStarter;
  finalizer: RunFinalizer;
  /** Persists a durable suspension (the durable-suspension design). Absent ⇒ no suspension support: a run that
   *  reaches a suspend fails cleanly rather than stranding (the brokered worker always wires it). */
  suspender?: RunSuspender;
  buildHost: ProgramHostBuilder;
  /** Starts mid-run credit watching for the session (optional — absent disables it). */
  startCreditWatch?: CreditWatchStarter;
  /** Starts mid-run user-cancel watching for the session (optional — absent disables it). */
  startCancelWatch?: CancelWatchStarter;
  /** Starts periodic lease renewal for the session, so a long run isn't spuriously reclaimed
   *  (optional — absent disables renewal). */
  startLeaseRenew?: LeaseWatchStarter;
  /** Emit the program's `console.*` output as `log` run-events while the body runs (optional —
   *  absent disables capture). Wired by the entrypoint to the batched telemetry publisher. */
  onProgramLog?: (stream: LogStream, text: string) => void;
  /** Task ARN (or any stable worker identity). */
  workerId: string;
  /** Drain any buffered telemetry before the worker exits (brokered path's BrokerEventPublisher).
   *  Called by the worker entrypoint's cleanup; the orchestrator itself never invokes it. */
  flushTelemetry?: () => Promise<void>;
  now?: () => number;
  leaseMs?: number;
}

export type ProgramWorkerOutcome =
  | { kind: "claim_lost" }
  | { kind: "completed" }
  | { kind: "failed"; reason: string }
  | { kind: "suspended"; reason: string };

export async function runProgramWorker(
  runId: string,
  deps: ProgramWorkerDeps,
): Promise<ProgramWorkerOutcome> {
  const now = deps.now ?? Date.now;
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;

  // Runtime-billing baseline: when THIS worker session began.
  const sessionStartMs = now();
  const claimed = await deps.runs.claimForWorker(
    runId,
    deps.workerId,
    sessionStartMs + leaseMs,
    sessionStartMs,
  );
  if (claimed === null) {
    log.info("worker_claim_lost", { runId, workerId: deps.workerId });
    return { kind: "claim_lost" };
  }
  log.info("worker_claimed", { runId, workerId: deps.workerId });

  const loaded = await loadVersion(deps, claimed);
  if (loaded === null) {
    // Pre-flight integrity failure — no program ran, so no charge.
    await deps.finalizer.finalize(runId, "failed", {
      error: { code: "INTERNAL_ERROR", message: "Run version missing, or manifest invalid" },
    });
    log.error("worker_version_invalid", { runId, workflowVersionId: claimed.workflowVersionId });
    return { kind: "failed", reason: "version_invalid" };
  }

  // Fetch + verify the program ARTIFACT before any work (pre-flight; an integrity failure = no charge,
  // no run). The bytes are the EXACT artifact the manifest was derived from at deploy; verifying the
  // sha256 here means a tampered/corrupted object can never be imported (the workflow runtime design).
  let tarball: Uint8Array;
  try {
    tarball = await deps.fetchProgram(loaded.program.downloadUrl);
  } catch (err) {
    await deps.finalizer.finalize(runId, "failed", {
      error: { code: "PROGRAM_FETCH_FAILED", message: "Could not download the program artifact" },
    });
    log.error("worker_program_fetch_failed", {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: "failed", reason: "program_fetch_failed" };
  }
  if (!verifyArtifactDigest(tarball, loaded.program.digest)) {
    await deps.finalizer.finalize(runId, "failed", {
      error: { code: "PROGRAM_INTEGRITY", message: "Program artifact digest mismatch" },
    });
    log.error("worker_program_integrity", { runId, workflowVersionId: claimed.workflowVersionId });
    return { kind: "failed", reason: "program_integrity" };
  }

  // deadline_seconds: a WALL-CLOCK cap from the run's ORIGINAL start (incl. suspended idle). Enforced
  // HERE, before running — so a run RESUMED past its deadline (e.g. it slept/awaited longer than the
  // cap) fails even when its program has NO agent() turn (the BudgetMeter's per-turn check would never
  // fire for those). Orthogonal to max_duration_seconds (active compute, the BudgetMeter's job).
  const deadlineSeconds = loaded.manifest.budget?.deadline_seconds;
  if (
    deadlineSeconds !== undefined &&
    claimed.startedAt !== null &&
    Date.now() - claimed.startedAt > deadlineSeconds * 1000
  ) {
    await deps.finalizer.finalize(runId, "failed", {
      error: {
        code: "BUDGET_EXCEEDED",
        message: `Run exceeded budget.deadline_seconds (${deadlineSeconds.toString()}s wall-clock) and was terminated.`,
      },
    });
    log.info("worker_deadline_exceeded", { runId, deadlineSeconds });
    return { kind: "failed", reason: "deadline_exceeded" };
  }

  // Cooperative-cancellation signal for the run. The credit watcher (and, later, user-initiated
  // cancel) aborts it; the WorkflowHost honors it at every hook so the program unwinds.
  const controller = new AbortController();
  // buildHost is async (MCP-server tool discovery connects out at run start) and can FAIL — e.g. a
  // granted MCP connection is unreachable. Finalize the run failed rather than crash the task: an
  // escaped throw here would exit the worker → reclaim-crashed sweep → restart → same throw, a loop.
  let built: Awaited<ReturnType<ProgramHostBuilder>>;
  try {
    built = await deps.buildHost(claimed, loaded.manifest, controller.signal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.finalizer.finalize(runId, "failed", {
      error: { code: "HOST_BUILD_FAILED", message },
    });
    log.error("worker_host_build_failed", { runId, error: message });
    return { kind: "failed", reason: "host_build_failed" };
  }
  const { host, redactor, workspace, phases, activity, setProgramDir, lsp, suspendSignal } = built;
  const browserSessions = built.browserSessions;
  const capture = built.capture;
  // Guarantee the /workspace sandbox dir exists for EVERY run (persist or not) so a program can write
  // to /workspace without a defensive mkdir. Runs before hydrate (whose extract targets the dir).
  // Best-effort — the image pre-creates the dir; a failure here would resurface at the program's write.
  if (deps.ensureWorkspace !== undefined) {
    try {
      await deps.ensureWorkspace();
    } catch (err) {
      log.warn("workspace_ensure_failed", {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Restore the workflow's persistent /workspace before the program runs (no-op when not opted-in /
  // self-hosted, or on a first run). Best-effort — never fails the run.
  if (workspace !== undefined) await workspace.hydrate();
  // Start desktop capture (recording + live-view) once the run has identity + a workspace, before the
  // program runs. Best-effort — a capture failure must never fail the run.
  if (capture !== undefined) {
    await capture.start().catch((err: unknown) => {
      log.warn("screen_capture_start_failed", {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  // Token metering is PER-LEAF: each agent() leaf reports its own tokens + model to the broker, which
  // decides `billed_by_boardwalk` per model + meters usage to the platform (see leaf_executor `meterUsage`). A
  // workflow has no run-level model, so there is no run-level token metering here.
  // Mid-run credit watching: when the org runs out of credit, abort the run cooperatively.
  const credit = deps.startCreditWatch?.({
    run: claimed,
    onExhausted: () => {
      controller.abort(new RunAbortedError("credit_exhausted"));
    },
  });
  // Mid-run user-cancel watching: when the user cancels, abort the run cooperatively. The host
  // honors the abort at the next hook boundary (a `sleep` hold wakes immediately); the broker then
  // upgrades the terminal write to `cancelled` because the run was flipped to `cancelling`.
  const cancel = deps.startCancelWatch?.({
    run: claimed,
    onCancelled: () => {
      controller.abort(new RunAbortedError("cancelled"));
    },
  });
  // Lease renewal: heartbeat the lease so a long run isn't reclaimed mid-flight. If the lease is
  // definitively lost (another worker reclaimed it), abort `lease_lost` — the run stops without
  // finalizing (the new owner owns the terminal write; see the lease_lost guard after the body).
  const lease = deps.startLeaseRenew?.({
    run: claimed,
    onLost: () => {
      controller.abort(new RunAbortedError("lease_lost"));
    },
  });
  // Runtime metering: flush runtime as periodic deltas from the claim, so a long/perpetual run
  // bills as it burns (and the credit watcher sees it) instead of only at terminal. The tail is booked
  // by `flushFinal()` after the body (on every path except a lease_lost handoff).
  const runtimeFlush = deps.startRuntimeFlush?.({ run: claimed, startedAtMs: sessionStartMs });
  // Capture the program's console.* as `log` run-events for the duration of the body (best-effort).
  const restoreConsole =
    deps.onProgramLog !== undefined
      ? captureConsole(deps.onProgramLog, (text) => redactor.redactText(text))
      : (): void => undefined;
  let result: ProgramResult;
  try {
    result = await runWorkflowProgram(
      {
        runId,
        tarball,
        entry: loaded.program.entry,
        input: claimed.input ?? claimed.triggerPayload,
        config: claimed.config ?? {},
      },
      // redactText scrubs a thrown error's message before it is logged + finalized into run output.
      // onOutput emits the `output` activity entry into the run's log when the program declared one.
      {
        host,
        redactText: (text) => redactor.redactText(text),
        extract: deps.extractArchive,
        ...(setProgramDir !== undefined ? { onExtracted: setProgramDir } : {}),
        ...(suspendSignal !== undefined ? { suspendSignal } : {}),
        ...(activity !== undefined
          ? {
              onOutput: (value: unknown) => {
                activity.output(value);
              },
            }
          : {}),
      },
    );
  } finally {
    restoreConsole();
    // Stop the per-session watchers, however the program ended (success/failure/throw). Stopping the
    // runtime flusher halts the timer only; the tail is booked by flushFinal() below (post-lease guard).
    if (credit !== undefined) await credit.stop();
    if (cancel !== undefined) await cancel.stop();
    if (lease !== undefined) await lease.stop();
    if (runtimeFlush !== undefined) await runtimeFlush.stop();
    // Shut down the run's language server(s) on EVERY terminal path (success/failure/throw) so no
    // language-server process leaks. `close()` is idempotent + never throws, so this best-effort call
    // is safe (it runs before the workspace snapshot, which is the slowest step).
    if (lsp !== undefined) await lsp.close();
    // Reap every still-open browser session (kill Chromium + its Playwright MCP) on EVERY terminal
    // path, before the workspace snapshot. Best-effort — a dead session must not mask the run's outcome.
    if (browserSessions !== undefined) {
      await browserSessions.closeAll().catch((err: unknown) => {
        log.warn("browser_sessions_close_failed", {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    // Stop capture + flush the final recording segment on EVERY terminal path, before the workspace
    // snapshot. Best-effort — a capture failure must not mask the run's outcome.
    if (capture !== undefined) {
      await capture.stopAndFlush().catch((err: unknown) => {
        log.warn("screen_capture_flush_failed", {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    // Snapshot the final /workspace so the workflow's NEXT run hydrates it. Best-effort.
    if (workspace !== undefined) {
      await workspace.persist();
    }
  }

  // Lease lost: another worker reclaimed this run and now owns it. Do NOT charge or finalize — the
  // new owner books its own runtime and writes the terminal status; our work here was superseded.
  // Exit quietly (like a lost claim), so we can't double-charge or clobber the live run.
  if (abortReason(controller.signal) === "lease_lost") {
    log.info("worker_lease_lost", { runId, workerId: deps.workerId });
    return { kind: "claim_lost" };
  }

  // Book the runtime TAIL since the last periodic flush — every path except the lease_lost handoff
  // above (which returns before this, so the new owner books its own runtime). The periodic flushes
  // already booked the bulk; this captures the final partial interval.
  if (runtimeFlush !== undefined) await runtimeFlush.flushFinal();

  // An abort is AUTHORITATIVE: even if the program swallowed RunAbortedError and returned normally,
  // the run stops here, terminal `failed` — so the crash-sweep never restarts a credit-exhausted run.
  if (controller.signal.aborted) {
    const reason = abortReason(controller.signal) ?? "cancelled";
    phases?.close("failed");
    await deps.finalizer.finalize(runId, "failed", {
      error: { code: "RUN_ABORTED", reason, message: `Run stopped: ${reason}` },
    });
    log.info("worker_run_aborted", { runId, reason });
    return { kind: "failed", reason };
  }

  // Suspended: a host seam released the task (a long `sleep`, a `humanInput()` gate, or the in-leaf
  // `human_input` tool). Persist the wake condition through the broker — NO finalize — and exit
  // cleanly; a wake (an answer or a timer) re-dispatches the run, which restarts from the top and
  // replays the journal past the already-done seams. The runtime tail for THIS session was booked
  // above, so idle time while suspended is not billed. Phases stay open (the run is non-terminal).
  if (result.kind === "suspended") {
    if (deps.suspender === undefined) {
      phases?.close("failed");
      await deps.finalizer.finalize(runId, "failed", {
        error: { code: "SUSPEND_UNSUPPORTED", message: "This runtime cannot suspend a run." },
      });
      log.error("worker_suspend_unsupported", { runId });
      return { kind: "failed", reason: "suspend_unsupported" };
    }
    await deps.suspender.suspend(result.signal, deps.workerId);
    log.info("worker_suspended", { runId, reason: result.signal.reason });
    return { kind: "suspended", reason: result.signal.reason };
  }

  if (result.kind === "completed") {
    phases?.close("completed");
    await deps.finalizer.finalize(runId, "completed", result.output);
    return { kind: "completed" };
  }
  phases?.close("failed");
  await deps.finalizer.finalize(runId, "failed", { error: result.error });
  return { kind: "failed", reason: result.error.code };
}

async function loadVersion(
  deps: ProgramWorkerDeps,
  run: Run,
): Promise<{ manifest: WorkflowManifest; program: ProgramRef } | null> {
  const version = await deps.versions.getById(run.workflowVersionId);
  if (version === null) return null;
  const parsed = workflowManifestSchema.safeParse(version.manifest);
  if (!parsed.success) return null;
  return { manifest: parsed.data, program: version.program };
}
