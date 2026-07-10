// Worker composition root (the workflow runtime design). The hosted worker container runs the
// compiled worker entrypoint; the dispatcher launches it per run with
// RUN_ID + the per-run control-plane handle. This file assembles real implementations behind every
// seam `runProgramWorker(runId, deps)` injects, then runs the one workflow program to terminal.
//
// BROKERED-ONLY (security): the runner is UNTRUSTED and holds NO platform credential — only
// its short-lived run token. EVERY privileged seam goes through the Runner Control API (the broker):
//   - agent()         → EngineLeafExecutor: the OSS engine's loop (runAgentLeaf) over a broker-backed
//                       LeafIo — the model turn streams through /inference (invoked server-side).
//   - sleep()         → WorkerWorkflowHost in-process hold (hold-and-pay; no checkpoint/exit).
//   - secrets.get()   → broker /secrets/resolve (allowlist enforced server-side).
//   - workflows.call()→ broker /children (durable child run, hold + poll).
//   - events.emit()   → broker /events (fan-out server-side).
//   - artifacts / web_search → broker /artifacts + /tools/web_search (no storage or search-provider creds here).
//   - lifecycle / usage / telemetry → broker /claim,/version,/finalize,/usage,/telemetry.
// There is no database, cache, billing, or model-provider client on the runner — so its task role is
// near-zero and the metadata-endpoint escape has nothing to steal. The legacy direct (pre-broker) path is removed.
//
// Split: `assembleWorkerDeps(runtime)` is pure wiring (unit-tested with a fake fetch); `main()` is the
// bootstrap shell (read the control-plane env, install signal handlers).
//
// Per-session loops wired here (all brokered): a UsageFlusher meters token deltas (→ /usage/tokens), a
// CreditWatcher polls funding (→ /credit, aborting the run on exhaustion), and a CancelWatcher polls
// for a user cancel (→ /cancel, aborting the run when the user cancels — the brokered worker holds no
// cache client, so it can't receive the platform's cancel publish directly).
//
// Documented v0 deferral (a clear seam): durable events — a no-op AgentEventStore (live fan-out
// via the broker only) until durable event storage lands.

import { createLogger, newId, AppError, ErrorCode, DEFAULT_LEASE_MS } from "./support/index.js";
import { LspService } from "@boardwalk-labs/engine/core";
import { BudgetMeter } from "./agent/budget.js";
import { WorkerRunEventEmitter } from "./run_event_emitter.js";
import { BUDGET_GUARDRAIL_RATE } from "./agent/model_rates.js";
import { SecretRedactor } from "./agent/secret_redactor.js";
import type { AuthContext } from "./support/index.js";
import type { Run } from "./wire/run.js";
import type { WorkflowManifest } from "./wire/manifest.js";
import { RecordingSecretResolver } from "./recording_secret_resolver.js";
import { EngineLeafExecutor } from "./leaf_executor.js";
import { parseByoProviders } from "./direct_inference.js";
import {
  applyIdentityToEnv,
  connectIdentityRelayFd,
  relayFdFromEnv,
  workerDiagnostics,
  type IdentityRelay,
} from "./identity_relay.js";
import { FreezeCoordinator } from "./freeze_coordinator.js";
import { reseedUserspaceCsprng } from "./uniqueness_reseed.js";
import type { ByoInferenceProvider } from "../contract.js";
import { WorkerWorkflowHost, type RuntimeContext } from "./workflow_host.js";
import { BrowserSessionManager, type BrowserBackend } from "./browser_session.js";
import {
  loadGuestBrowserConfig,
  makeGuestBrowserBackend,
  connectSessionMcp,
} from "./browser_session_backend.js";
import { ScreenCapture, type CaptureBackend } from "./screen_capture.js";
import { loadCaptureConfig, makeCaptureBackend } from "./screen_capture_backend.js";
import {
  runProgramWorker,
  type ProgramWorkerDeps,
  type ProgramHostBuilder,
} from "./program_worker.js";
import { RunnerControlClient } from "./runner_control_client.js";
import type { SuspendSignal } from "./suspension.js";
import { BrokerChildDispatcher } from "./broker_child_dispatcher.js";
import { BrokerEventPublisher } from "./broker_event_publisher.js";
import { createProgramLogSink } from "./program_log_capture.js";
import { BrokerArtifactStore } from "./broker_artifact_store.js";
import { buildBrokerToolHost } from "./broker_tool_host.js";
import { CreditWatcher } from "./credit_watcher.js";
import { CancelWatcher } from "./cancel_watcher.js";
import { LeaseRenewer } from "./lease_renewer.js";
import { RuntimeFlusher } from "./runtime_flusher.js";

import { WorkspaceStore, TarWorkspaceArchiver, NodeWorkspaceFs } from "./workspace_store.js";
import { PhaseTracker } from "./phase_tracker.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const log = createLogger("worker_entrypoint");

/** Constructed primitives the pure assembly consumes (real ones in main(), fakes in tests). The
 *  runner holds NO platform credential — only the per-run control-plane handle (run token + broker
 *  URL); everything else is reached through the Runner Control API (the Runner Credential Broker model). */
export interface WorkerRuntime {
  /** Stable worker identity stamped onto the lease (task ARN / hostname / run-derived). */
  workerId: string;
  /** Sandbox workspace root for filesystem/shell/git tools. */
  workspaceRoot: string;
  /** The run this worker task is executing (RUN_ID) — binds the Runner Control API client. */
  runId: string;
  /** The org's BYO inference providers (claim-delivered, BOARDWALK_BYO_PROVIDERS) for the
   *  runner-direct model path (D7). Empty/omitted ⇒ every model call goes through the broker. */
  byoProviders?: readonly ByoInferenceProvider[];
  /** Broker control-plane handle (run token + base URL), injected by the dispatcher as
   *  BOARDWALK_CONTROL_PLANE_URL + BOARDWALK_RUN_TOKEN. The runner's ONLY broker credential.
   *  `apiToken` is the run's separate public-API bearer (was BOARDWALK_API_KEY) — served to the
   *  program on demand via `runtime.apiToken()`, never placed back into process.env. */
  controlPlane: { baseUrl: string; runToken: string; apiToken?: string };
  /** vCPUs provisioned for this task (the dispatcher's resolved machine size ÷ 1024 cpu units). Runtime
   *  is billed per vCPU-SECOND, so the RuntimeFlusher scales wall-clock by this. Defaults to 1. */
  vcpus: number;
  /** The in-guest identity relay, present ONLY on the snapshot-based microVM substrate (relay-mode
   *  boot). When set, the worker suspends by FREEZING — the FreezeCoordinator parks seams over this
   *  relay's suspend/wake channel — instead of the exit-and-replay path. */
  freezeRelay?: IdentityRelay;
  /** The browser tier's process backend, present ONLY when the runner IMAGE ships the browser stack
   *  (Chromium + a pre-installed Playwright MCP + an X display; gated by BOARDWALK_BROWSER_TIER).
   *  When absent, `computer.openBrowser()` fails with a clear "not available on this runner image". */
  browserBackend?: BrowserBackend;
  /** Screen-capture backend (session recording + live-view frames), present ONLY when the runner IMAGE
   *  ships the desktop stack (ffmpeg + an X display) and recording isn't disabled. Absent ⇒ no capture. */
  captureBackend?: CaptureBackend;
}

/** Durable events are deferred (durable event storage) — live fan-out via the broker only. */

/** Synthesize the run's AuthContext. The run was already authorized at trigger time; the
 *  worker acts on the org's behalf, so it carries the org + an owner role. Tool-level
 *  boundaries (the broker's server-side manifest allowlist) are the real guard.
 *
 *  source='workflow' (NOT 'session_jwt'): the program must never perform SESSION_JWT_ONLY
 *  credential mutations, so a tool that ever exposed such a service is denied by
 *  construction regardless of the owner role. */
export function workerAuthContext(run: Run): AuthContext {
  const userId = run.actor.type === "user" ? run.actor.user_id : `workflow:${run.workflowId}`;
  return { userId, orgId: run.orgId, role: "owner", source: "workflow" };
}

/**
 * Sequencer for per-call token-metering identifiers, `<runId>:<sessionId>:<leafIndex>:<turnSeq>`.
 *
 * The worker's `meterUsage` hook fires once per model TURN (the engine's leaf loop reports usage
 * after every model call), but the display aggregate is idempotent on this identifier
 * (UsageEventRepository.recordAndAggregate → `onConflictDoNothing`). A key that didn't vary per call
 * (it was `<runId>:<sessionId>:<leafIndex>`) collapsed every turn after a leaf's first into a dropped
 * duplicate — so `runs.tokens_in/out` reflected only each leaf's FIRST turn and under-reported
 * multi-turn leaves by orders of magnitude, even as the BudgetMeter (which accumulates every turn)
 * still tripped on the real spend. Bumping a per-session counter gives every turn its own idempotent
 * event. Restart safety rides the session id (a fresh `meteringSessionId` per worker session) — a
 * restart genuinely re-spends inference, so it must re-meter rather than dedupe against a prior run.
 */
export function tokenMeterIdentifiers(
  runId: string,
  sessionId: string,
): (leafIndex: number) => string {
  let seq = 0;
  return (leafIndex: number): string =>
    `${runId}:${sessionId}:${String(leafIndex)}:${String(seq++)}`;
}

/** Pure wiring: build the full ProgramWorkerDeps from the control-plane handle. The runner reaches
 *  every privileged seam through the broker over its run token — no database, cache, billing, or model creds. */
export function assembleWorkerDeps(runtime: WorkerRuntime): ProgramWorkerDeps {
  const broker = new RunnerControlClient({
    baseUrl: runtime.controlPlane.baseUrl,
    runToken: runtime.controlPlane.runToken,
    runId: runtime.runId,
  });
  log.info("runner_control_enabled", { runId: runtime.runId });

  // The replay frontier (the highest journaled seq at claim) drives SILENT REPLAY (the durable-suspension design):
  // a resumed run suppresses observability for seams it already ran. Captured at claim, read by
  // buildHost (which runs right after claim) when constructing the per-run host.
  let replayFrontier = 0;

  // Snapshot-substrate suspension (relay-mode boot only): one coordinator for the process, wired to
  // the relay's suspend/wake channel now; its per-run hooks (token swap, meter rebase, workspace
  // persist) late-bind in buildHost/startRuntimeFlush once those objects exist. The circular
  // channel↔handler reference resolves through the thunks.
  let freeze: FreezeCoordinator | undefined;
  let activeFlusher: RuntimeFlusher | null = null;
  if (runtime.freezeRelay !== undefined) {
    const channel = runtime.freezeRelay.openChannel({
      onWake: (payload) => {
        freeze?.onWake(payload);
      },
      onSuspendAbort: (payload) => {
        freeze?.onSuspendAbort(payload);
      },
    });
    freeze = new FreezeCoordinator({ channel });
    log.info("freeze_mode_enabled", { runId: runtime.runId });
  }

  // Live agent-event stream → /telemetry (broker fans out server-side). Inference,
  // web_search, artifacts, and the model call are all brokered — no cache client, model creds,
  // search-provider creds, or object-storage creds here.
  const eventPublisher = new BrokerEventPublisher({
    send: (frames) => broker.publishTelemetry(frames),
  });
  // The run's ONE event envelope counter (v1 wire format, engine parity): phases, program logs,
  // declared output, and every agent turn stamp through this emitter, so cursors are run-globally
  // monotonic with no separate program band. Frames publish as `{cursor, event}` rows via the
  // broker telemetry path. The claim wrapper below bumps it past a previous session's frames.
  const runEvents = new WorkerRunEventEmitter({ runId: runtime.runId, publisher: eventPublisher });
  const phaseTracker = new PhaseTracker({ sink: runEvents });
  // The run's public-API credential (was BOARDWALK_API_KEY). It is NO LONGER in process.env — the
  // bootstrap captured + scrubbed it (capturePlatformContext) so the agent's bash / subprocesses
  // can't read it. The program reaches it ONLY via `runtime.apiToken()` (built below); we still
  // record it in each run's redactor so a value the program threads into a tool can't echo back out
  // of a tool result. Absent in the dev no-signing-key path.
  // MUTABLE: on the snapshot substrate a wake carries a fresh token (the frozen one expired).
  let runApiKey = runtime.controlPlane.apiToken;
  // The broker (Runner Control API) shares an origin with the public API;
  // `runtime.apiUrl` exposes it and the program appends `/v1` or `/mcp/v1`.
  const apiUrl = publicApiOrigin(runtime.controlPlane.baseUrl);

  // Per-run host: agent() leaf + sleep-hold + secrets + children + events, all brokered. `signal`
  // carries cooperative cancellation (credit exhaustion) into every host hook.
  const buildHost: ProgramHostBuilder = (
    run: Run,
    manifest: WorkflowManifest,
    signal: AbortSignal,
  ) => {
    const budget = new BudgetMeter({
      ...(manifest.budget !== undefined ? { budget: manifest.budget } : {}),
      // Fallback budget-cap rate. A managed turn caps on the broker's EXACT upstream cost (forwarded on
      // the inference result frame → BudgetMeter `realCostUsd`); this representative sonnet-class rate
      // applies only to a turn with no upstream cost (BYO / unavailable). `max_usd` is a guardrail, not
      // the bill — the platform meters the actual per-leaf usage.
      rate: BUDGET_GUARDRAIL_RATE,
      startedAt: Date.now(),
      // deadline_seconds is WALL-CLOCK from the run's ORIGINAL start (incl. suspended idle), so a run
      // resumed past its deadline trips on its first cap check. Falls back to now on the first session
      // (startedAt is being set this session anyway).
      deadlineStartedAt: run.startedAt ?? Date.now(),
    });
    // Per-session id for per-turn metering identifiers (`<runId>:<sessionId>:<leafIndex>:<turnSeq>`) —
    // a fresh value per worker session keeps a resumed run's events from colliding with a prior
    // session's (a restart genuinely re-spends, so it must re-meter).
    const meteringSessionId = newId();
    // Mint a unique identifier per metering call. `meterUsage` fires once per model TURN, so the key
    // must vary per call: the display aggregate is idempotent on it (see {@link tokenMeterIdentifiers}).
    const nextMeterIdentifier = tokenMeterIdentifiers(run.id, meteringSessionId);
    // Per-run secret boundary: every value resolved (program `secrets.get` OR a tool's
    // ctx.secrets.resolve) is recorded into one shared redactor; the leaf seeds a fresh engine
    // Redactor from it so the loop scrubs those values out of all model-bound content.
    const redactor = new SecretRedactor();
    // Record the run's own API key so a prompt-injected agent can't echo it back to the model.
    if (runApiKey !== undefined && runApiKey !== "") redactor.record(runApiKey);
    const secretResolver = new RecordingSecretResolver(
      { resolve: (ref) => broker.resolveSecret(ref.name) },
      redactor,
    );
    // The extracted program dir isn't known until the runner unpacks the artifact (mid-run); the leaf
    // reads it through this holder, which `setProgramDir` (returned below → runner `onExtracted`) fills.
    let programDir: string | null = null;
    // Broker-backed artifact store (shared by the program's artifacts.write hook AND the engine's
    // host-backed `artifacts` tool). Presigned for large bodies; the runner holds no S3 creds.
    const artifactStore = new BrokerArtifactStore(broker);
    // Browser tier (browser-session computer use): a per-run manager over the image's process backend.
    // Only present when the runner image ships the browser stack (runtime.browserBackend set); else
    // `computer.openBrowser()` throws "not available". A captured screenshot is stored as a run artifact
    // through the SAME broker store — decoded from the MCP image block's base64 as binary bytes.
    const browserSessions =
      runtime.browserBackend !== undefined
        ? new BrowserSessionManager({
            backend: runtime.browserBackend,
            connect: connectSessionMcp,
            writeArtifact: (name, contentType, base64, metadata) =>
              artifactStore
                .write({
                  name,
                  contentType,
                  body: base64,
                  encoding: "base64",
                  ...(metadata !== undefined ? { metadata } : {}),
                })
                .then((res) => ({ id: res.id, name: res.name, url: res.signedUrl })),
            nextId: () => newId(),
          })
        : undefined;
    // Screen capture (session recording + live-view). Present only when the image ships the desktop
    // stack (runtime.captureBackend set) AND the workflow hasn't opted out (`recording: false` in the
    // manifest — SCREEN_CAPTURE §4.5; default on). Segments upload through the SAME broker artifact store
    // as a `recording-segment` artifact (quota-exempt, 30-day retention — the broker applies that
    // server-side off the metadata kind); live frames push up the broker's live-view channel while a
    // viewer watches. (Live-view rides the same capture, so opting out of recording also stops live-view.)
    const capture =
      runtime.captureBackend !== undefined && manifest.recording !== false
        ? new ScreenCapture({
            backend: runtime.captureBackend,
            writeArtifact: (name, contentType, base64, metadata) =>
              artifactStore
                .write({ name, contentType, body: base64, encoding: "base64", metadata })
                .then((res) => ({ id: res.id })),
            publishLiveFrames: (frames) => broker.publishLiveView(frames),
            liveViewWanted: () => broker.liveViewWanted(),
            now: () => Date.now(),
          })
        : undefined;
    // Backend for the engine's host-backed built-in tools (webfetch/web_search/artifacts): web_search
    // + artifact read-back go through the broker (no Tavily/S3 creds here); webfetch is an in-process
    // fetch already gated by the worker's egress proxy.
    const toolHost = buildBrokerToolHost({ broker, artifacts: artifactStore });
    // ONE engine-native LSP per RUN (not per leaf): the language server must persist across the run's
    // edits/leaves so it stays warm. The engine reads `capabilities.lspService` to light up the
    // `diagnostics` tool + diagnostics-after-edit; it spawns `typescript-language-server` in the worker
    // and degrades gracefully when that binary isn't in the image (a separate runner-image change adds
    // it). Workspace-rooted at the same `/workspace` the leaf + tools use. Closed on the run's teardown
    // (returned below as `lsp` → program_worker's finally) so no language-server process leaks.
    const lspService = new LspService({ workspaceDir: runtime.workspaceRoot });
    const leaf = new EngineLeafExecutor({
      inference: broker,
      // Direct BYO (D7): the claim's registry + the run's RECORDING resolver, so a provider key
      // registers with the redactor the moment it resolves.
      ...(runtime.byoProviders !== undefined && runtime.byoProviders.length > 0
        ? {
            byo: {
              registry: runtime.byoProviders,
              resolveSecret: (name: string) => secretResolver.resolve({ name }),
            },
          }
        : {}),
      budget,
      redactor,
      toolHost,
      lspService,
      workspaceRoot: runtime.workspaceRoot,
      // Resolve this run's deployed `skills/` dir for `agent({ skills })` — the engine reads
      // `<skillsDir>/<name>.md`, so it's the `skills` subdir of the extracted program tree (filled
      // once the artifact extracts). Null until then / when no program dir is known.
      skillsDir: () => (programDir === null ? null : join(programDir, "skills")),
      // The extracted program tree IS the workflow PACKAGE root on hosted runs: the deploy artifact
      // ships the bundled `AGENTS.md` at its root (and `skills/` beside it), so the engine reads
      // `<programDir>/AGENTS.md` for the bundled tier. Same holder the `skillsDir` thunk reads — null
      // until the artifact extracts. The empty `/workspace` and this dir are SEPARATE dirs on hosted,
      // exactly the two-tier case the engine's AGENTS.md loader is built for.
      programDir: () => programDir,
      // Per-leaf, per-model token metering — reported THROUGH the broker (the worker holds no billing
      // credential); the broker decides `billed_by_boardwalk` per model + meters usage to the platform
      // (BYO models no-op there). Fire-and-forget: a metering hiccup must never fail the run.
      meterUsage: ({
        model,
        inputTokens,
        outputTokens,
        cachedReadTokens,
        cachedWriteTokens,
        leafIndex,
      }) => {
        void broker
          .meterTokens({
            inputTokens,
            outputTokens,
            model,
            identifier: nextMeterIdentifier(leafIndex),
            ...(cachedReadTokens === undefined ? {} : { cachedReadTokens }),
            ...(cachedWriteTokens === undefined ? {} : { cachedWriteTokens }),
          })
          .catch((err: unknown) => {
            log.warn("leaf_usage_meter_failed", {
              runId: run.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      },
      // Turn numbering is owned by the shared emitter (beginTurn opens the stride block); the leaf
      // index stays only in metering identifiers. `identity` names the leaf on its turn frames.
      makeEventSink: (_leafIndex, _identity) => runEvents,
      // Broker an OAuth bearer for an `agent({ mcp })` server (called reactively on a 401). The token
      // comes from the org's connection vault via the Runner Control API — never stored on the worker.
      brokerMcpToken: (serverUrl, invalidateToken) => broker.mcpToken(serverUrl, invalidateToken),
    });
    // Per-workflow persistent /workspace: only when the manifest opts in. The BROKER additionally
    // gates on hosted (self-hosted runs get null URLs), and snapshots are keyed per-workflow + scoped
    // by the run token — so even the untrusted in-process program can't reach another tenant's data.
    const workspaceStore =
      manifest.workspace?.persist === true
        ? new WorkspaceStore({
            broker,
            archiver: new TarWorkspaceArchiver(),
            fs: new NodeWorkspaceFs(),
            workspaceRoot: runtime.workspaceRoot,
          })
        : undefined;
    // Durable suspension (the durable-suspension design): the host raises a suspend OUT OF BAND (onSuspend +
    // a never-resolving seam), so a program's own try/catch can't swallow it; the program runner
    // races `suspendSignal` against the body. One deferred per run — the first seam to suspend wins.
    let resolveSuspend: (signal: SuspendSignal) => void = () => undefined;
    const suspendSignal = new Promise<SuspendSignal>((resolve) => {
      resolveSuspend = resolve;
    });
    // The run's identity + on-demand public-API bearer, surfaced to the program via `import { runtime }`.
    // ids come from the claimed run; the bearer is the captured (scrubbed-from-env) api token, already
    // recorded in this run's redactor above — so threading it into an MCP header keeps it out of LLM
    // context. Throws clearly when a run was provisioned no api token (dev no-signing-key path).
    const runtimeContext: RuntimeContext = {
      runId: run.id,
      workflowId: run.workflowId,
      orgId: run.orgId,
      apiUrl,
      apiToken: () => {
        if (runApiKey === undefined || runApiKey === "") {
          return Promise.reject(
            new AppError(
              ErrorCode.FORBIDDEN,
              "runtime.apiToken() is unavailable: this run was not provisioned a public-API token",
            ),
          );
        }
        return Promise.resolve(runApiKey);
      },
    };
    const host = new WorkerWorkflowHost({
      leaf,
      runtime: runtimeContext,
      // workflows.call → broker /children (resolve + callable_by gate server-side), bound to THIS run.
      children: new BrokerChildDispatcher({ client: broker }),
      // The durable-seam journal (memoization + replay) over the broker; the replay frontier drives
      // silent replay; onSuspend resolves the deferred the program runner races.
      journal: broker.journalSeam(),
      replayFrontier,
      onSuspend: (signal) => {
        resolveSuspend(signal);
      },
      // The program's secrets.get(name) → the run's fail-closed RECORDING resolver.
      secrets: { get: (name: string) => secretResolver.resolve({ name }) },
      // events.emit → broker /events (fan-out server-side).
      // artifacts.write → broker artifact store (presigned; the runner holds no S3 creds). Text ships
      // as utf8, raw bytes as base64; the stored artifact's signed URL surfaces as ArtifactRef.url.
      writeArtifact: (name, contentType, body, metadata) =>
        artifactStore
          .write({
            name,
            contentType,
            body: typeof body === "string" ? body : Buffer.from(body).toString("base64"),
            encoding: typeof body === "string" ? "utf8" : "base64",
            ...(metadata !== undefined ? { metadata } : {}),
          })
          .then((res) => ({ id: res.id, name: res.name, url: res.signedUrl })),
      // Cooperative cancellation: every host hook honors this (credit exhaustion aborts it).
      signal,
      // Snapshot the workspace before a long sleep (crash-during-hold recovery). The byte count
      // is only logged by the store itself.
      ...(workspaceStore !== undefined
        ? {
            onBeforeSleep: async (): Promise<void> => {
              await workspaceStore.persist();
            },
          }
        : {}),
      // Snapshot-substrate suspension: seams freeze in place under the quiescence gate instead of
      // raising onSuspend (which stays wired as the transitional/local path's fallback).
      ...(freeze !== undefined ? { freeze } : {}),
      // Register-without-release for held HITL gates — only on the
      // freeze substrate, backed by the broker's inputs endpoints.
      ...(freeze !== undefined
        ? {
            heldInput: {
              register: (seq: number, gate: unknown) => broker.registerInput(seq, gate),
              poll: (seq: number) => broker.pollInputAnswers(seq),
            },
          }
        : {}),
      // Browser tier: `computer.openBrowser()` + `agent({ session })` resolve through this manager
      // (absent ⇒ the host throws "not available on this runner image").
      ...(browserSessions !== undefined ? { browserSessions } : {}),
      phases: phaseTracker,
    });
    // Late-bind the coordinator's per-run hooks now that the run-scoped objects exist.
    if (freeze !== undefined) {
      const coordinator = freeze;
      let freezeWallMs = 0;
      coordinator.setHooks({
        // At quiescence, immediately before the freeze: book the runtime tail (suspended time must
        // never appear billed) and persist the workspace (crash-during-suspension
        // recovery parity with the sleep-hold path). The wall stamp anchors the idle rebase below.
        onBeforeFreeze: async (): Promise<void> => {
          freezeWallMs = Date.now();
          await activeFlusher?.flushNow();
          await workspaceStore?.persist();
          // The recorder never spans a snapshot: finalize + upload the in-flight segment before the
          // freeze (SCREEN_CAPTURE §4.3). Bounded internally, so a slow upload delays, not blocks, it.
          await capture?.stopAndFlush();
        },
        // On wake: reseed the userspace CSPRNG (clause 3 — a suspend snapshot restored more than
        // once, e.g. a re-dispatch retry, would otherwise repeat its post-wake `crypto.*` draws),
        // swap the fresh tokens onto the broker client + the program-facing apiToken() (recording
        // the new values in the run's redactor, same discipline as boot), and exclude the frozen
        // window from billed runtime using the wake's authoritative wall clock. The reseed runs
        // BEFORE the seam resolves, so no woken author code draws from the stale (pre-suspend) DRBG.
        onAfterWake: (wake): void => {
          reseedUserspaceCsprng();
          broker.swapRunToken(wake.run_token);
          redactor.record(wake.run_token);
          if (wake.api_token !== undefined && wake.api_token !== "") {
            runApiKey = wake.api_token;
            redactor.record(wake.api_token);
          }
          activeFlusher?.excludeIdle(wake.wall_clock_ms - freezeWallMs);
          // Resume capture in a fresh segment epoch (a suspend/resume boundary is a segment boundary).
          void capture?.startFresh();
        },
      });
    }
    // Hand the redactor back too: the worker scrubs a terminal error's message with it;
    // workspace (when opted in) hydrates at start + persists at terminal.
    return Promise.resolve({
      host,
      redactor,
      phases: phaseTracker,
      // The orchestrator closes the per-run LSP on every terminal path (close() is idempotent + never
      // throws) so no language-server process leaks past the run.
      lsp: lspService,
      // The orchestrator emits the program's declared output onto the wire (`output` kind).
      // Redact the declared-output EVENT (observability): a secret the program put in output()
      // must not surface in the run's event stream. The FUNCTIONAL output program_runner returns
      // for `workflows.call` is a separate path and stays raw, so cross-workflow data flow is intact.
      activity: {
        output: (value: unknown) =>
          void runEvents.emit({ kind: "output", value: redactor.redactValue(value) }),
      },
      // Filled by the runner once the artifact extracts; the leaf's `skillsDir` thunk reads it.
      setProgramDir: (dir: string) => {
        programDir = dir;
      },
      // Resolves when a host seam suspends the run; the program runner races it against the body.
      suspendSignal,
      ...(workspaceStore !== undefined ? { workspace: workspaceStore } : {}),
      // The orchestrator reaps every still-open browser session on terminal (kill Chromium + its
      // Playwright MCP) so no browser process leaks past the run.
      ...(browserSessions !== undefined ? { browserSessions } : {}),
      // The orchestrator starts capture before the program runs and flushes it on terminal.
      ...(capture !== undefined ? { capture } : {}),
    });
  };

  return {
    runs: {
      // The broker owns the lease duration server-side; convert the absolute lease back to seconds.
      claimForWorker: async (_runId, workerId, leaseUntil, nowMs) => {
        const claimed = await broker.claim(
          workerId,
          Math.max(1, Math.round((leaseUntil - nowMs) / 1000)),
        );
        if (claimed === null) return null;
        // Order this session's frames after a previous (crashed) session's, then announce the
        // lifecycle transition the claim IS — the wire's `running` frame.
        runEvents.resumeAfter(claimed.lastEventCursor);
        // The replay frontier for a resumed run (0 on a fresh run); buildHost reads it next.
        replayFrontier = claimed.lastJournalSeq;
        runEvents.emit({ kind: "run_status", status: "running" });
        return claimed.run;
      },
    },
    versions: {
      getById: async () => {
        const v = await broker.getVersion();
        return v === null ? null : { manifest: v.manifest, program: v.program };
      },
    },
    // Download the pinned program artifact from the broker's presigned URL; the worker verifies its
    // digest (program_worker) before extracting + importing it.
    fetchProgram: async (downloadUrl) => {
      const bytes = await broker.downloadBytes(downloadUrl);
      if (bytes === null) throw new Error("program artifact download returned no body");
      return bytes;
    },
    // Extract the verified artifact tarball via system `tar` (same impl as workspace snapshots).
    extractArchive: (tgzPath, destDir) => new TarWorkspaceArchiver().extract(tgzPath, destDir),
    // Guarantee /workspace exists before the program runs (override-safe; the image also pre-creates
    // it). Lets authors write to /workspace without a defensive mkdir — see WorkflowMeta.workspace.
    ensureWorkspace: async () => {
      await mkdir(runtime.workspaceRoot, { recursive: true });
    },
    finalizer: {
      finalize: (_id, status, output) => broker.finalize(status, output, runtime.workerId),
    },
    // Durable suspension (the durable-suspension design): persist the wake condition through the broker (journal
    // entry + a HITL request row, or the wake time for a long sleep) and release the lease — no
    // finalize. A wake (an answer or a timer) re-dispatches the run.
    suspender: {
      suspend: (signal, workerId) => broker.suspend(signal, workerId),
    },
    // Runtime metering: flush runtime as periodic deltas (+ a terminal tail) through the broker,
    // idempotent per flush, so a long/perpetual run bills as it burns and the credit watcher sees it —
    // not a single charge at terminal (which a never-terminating run never reached). A fresh per-session
    // id keeps a restarted run's sessions distinct in the idempotency key (distinct ids sum).
    startRuntimeFlush: ({ run, startedAtMs }) => {
      const flusher = new RuntimeFlusher({
        runId: run.id,
        sessionId: newId(),
        startedAtMs,
        // Bill per vCPU-second: scale wall-clock by the task's vCPUs ($0.05/vCPU-min). At the 1-vCPU
        // default this is a no-op; a 4-vCPU `large` run books 4× the seconds it holds the task for.
        vcpus: runtime.vcpus,
        now: Date.now,
        report: (deltaSeconds, identifier) => broker.reportUsage(deltaSeconds, identifier),
      });
      // The freeze coordinator's hooks flush this before a snapshot + rebase it past the frozen
      // window on wake (suspended time must never appear as billed runtime).
      activeFlusher = flusher;
      flusher.start();
      return { stop: () => flusher.stop(), flushFinal: () => flusher.flushFinal() };
    },
    buildHost,
    // Mid-run credit watching: a CreditWatcher polls the broker's GET /credit on a timer; when
    // the org runs out, onExhausted aborts the run (the orchestrator wires it to AbortController).
    startCreditWatch: ({ run, onExhausted }) => {
      const watcher = new CreditWatcher({
        runId: run.id,
        isFunded: () => broker.checkCredit(),
        onExhausted,
      });
      watcher.start();
      return { stop: () => watcher.stop() };
    },
    // Mid-run user-cancel watching: a CancelWatcher polls the broker's GET /cancel on a timer;
    // when the user cancels (the run is flipped to `cancelling`), onCancelled aborts the run. This is
    // how the brokered (cache-less) worker learns of a cancel — the platform's cancel publish can't
    // reach it directly.
    startCancelWatch: ({ run, onCancelled }) => {
      const watcher = new CancelWatcher({
        runId: run.id,
        isCancelled: () => broker.checkCancelled(),
        onCancelled,
      });
      watcher.start();
      return { stop: () => watcher.stop() };
    },
    // Lease renewal: a LeaseRenewer extends the lease through the broker's POST /renew on a timer
    // (well under the lease), so a run longer than the 5-min lease isn't reclaimed mid-flight by the
    // recovery sweep. `renew` re-extends with the SAME workerId that claimed it; a null result (the
    // run is no longer ours) fires onLost → the run aborts `lease_lost` without finalizing.
    startLeaseRenew: ({ run, onLost }) => {
      const watcher = new LeaseRenewer({
        runId: run.id,
        renew: async () =>
          (await broker.renewLease(runtime.workerId, Math.round(DEFAULT_LEASE_MS / 1000))) !== null,
        onLost,
      });
      watcher.start();
      return { stop: () => watcher.stop() };
    },
    // Surface the program's console.* output as `program_output` run-events (the log channel),
    // so a plain console.log program shows up in the run's live tail.
    onProgramLog: createProgramLogSink({ sink: runEvents }),
    workerId: runtime.workerId,
    // Drain the live-tail telemetry buffer before the worker exits (it batches frames).
    flushTelemetry: () => eventPublisher.close(),
  };
}

// ---- Bootstrap (real container only) -------------------------------------------------

/**
 * The per-run platform values the dispatcher injects as container env. They
 * are captured into private worker state at bootstrap and DELETED from `process.env` before any user
 * program / agent leaf / subprocess can run — the run token + API token are credentials, and nothing
 * untrusted run code touches should inherit them (the run env/credential rules). The user owns the rest
 * of `process.env` outright.
 */
export const PLATFORM_ENV_KEYS = [
  "RUN_ID",
  "BOARDWALK_CONTROL_PLANE_URL",
  "BOARDWALK_RUN_TOKEN",
  "BOARDWALK_API_KEY",
  "BOARDWALK_TASK_CPU_UNITS",
] as const;

/** The captured platform context, shaped to feed {@link assembleWorkerDeps}. */
export interface PlatformContext {
  runId: string;
  controlPlane: { baseUrl: string; runToken: string; apiToken?: string };
  vcpus: number;
}

/** The public-API origin a run uses for raw API / MCP / CLI calls. The broker (Runner Control API)
 *  shares an origin with the public API, so the program appends `/v1` or
 *  `/mcp/v1`. Falls back to the broker URL unchanged if it can't be parsed. */
export function publicApiOrigin(controlPlaneBaseUrl: string): string {
  try {
    return new URL(controlPlaneBaseUrl).origin;
  } catch {
    return controlPlaneBaseUrl;
  }
}

/**
 * Read the dispatcher-injected platform context from `env`, then DELETE every {@link PLATFORM_ENV_KEYS}
 * key from it so the user program, the agent leaf, and any subprocess inherit none of them. Mutates
 * `env` (called once on `process.env` at the very top of `main`, before any run code can read it).
 */
export function capturePlatformContext(env: NodeJS.ProcessEnv): PlatformContext {
  const read = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.trim().length === 0) {
      throw new Error(`Worker missing required env var ${name}`);
    }
    return value.trim();
  };
  // The dispatcher always injects the control-plane handle (the Runner Credential Broker model). The runner is
  // brokered-only — there is no database, cache, or billing fallback — so a missing handle is a hard config error.
  const runId = read("RUN_ID");
  const apiToken = env.BOARDWALK_API_KEY?.trim();
  const controlPlane = {
    baseUrl: read("BOARDWALK_CONTROL_PLANE_URL"),
    runToken: read("BOARDWALK_RUN_TOKEN"),
    ...(apiToken !== undefined && apiToken.length > 0 ? { apiToken } : {}),
  };
  // The dispatcher injects the resolved Fargate size as BOARDWALK_TASK_CPU_UNITS (1024 = 1 vCPU). Fall
  // back to 1 vCPU when absent (legacy task / self-hosted) so runtime bills at least wall-clock.
  const cpuUnits = Number(env.BOARDWALK_TASK_CPU_UNITS);
  const vcpus = Number.isFinite(cpuUnits) && cpuUnits > 0 ? cpuUnits / 1024 : 1;
  // Scrub LAST — after every read — so the credentials live only in the returned (private) object.
  // (`delete` via Reflect, not `env[key] = undefined`: assigning undefined to process.env coerces to
  // the string "undefined", leaving the key readable; deletion actually removes it.)
  for (const key of PLATFORM_ENV_KEYS) Reflect.deleteProperty(env, key);
  return { runId, controlPlane, vcpus };
}

export async function main(): Promise<void> {
  // Relay-mode bootstrap (the snapshot-based microVM substrate): when the guest init handed
  // us an identity relay fd, park here — warm, generic, pre-identity; this await is what the
  // base snapshot freezes — until the run's identity arrives, then map it onto process.env
  // so the capture below is transport-agnostic. Everywhere else (Fargate, self-hosted
  // daemon) the fd is absent and the worker env-boots exactly as before. The post-restore
  // uniqueness reseed will hook in at this boundary, before any run code executes.
  const relayFd = relayFdFromEnv(process.env);
  let freezeRelay: IdentityRelay | undefined;
  if (relayFd !== null) {
    const relay = connectIdentityRelayFd(relayFd);
    relay.announceReady(workerDiagnostics());
    const identity = await relay.awaitIdentity();
    applyIdentityToEnv(identity, process.env);
    // Clause 3 (SNAPSHOT_UNIQUENESS_CONTRACT): this run was restored from the SHARED base
    // snapshot, so its OpenSSL DRBG is identical to every other run's. Reseed it from the
    // (VMGenID-diverged) OS entropy BEFORE `acceptIdentity` releases the worker into the brokered
    // lifecycle — so no `crypto.*` draw by the SDK, the agent, or author code can collide across
    // clones. Every wake reseeds again (the after-wake hook).
    reseedUserspaceCsprng();
    relay.acceptIdentity();
    // The relay now becomes the suspend/wake channel: assembleWorkerDeps opens it into the
    // FreezeCoordinator, and the host's suspending seams freeze in place instead of exiting.
    freezeRelay = relay;
  }

  // Capture the platform context into private state and remove it from process.env BEFORE anything
  // else — so no user program / agent tool / subprocess we later spawn can read the run token or
  // API token (the run env/credential rules). WORKER_ID / WORKSPACE_ROOT are non-secret infra knobs.
  const platform = capturePlatformContext(process.env);
  const runId = platform.runId;

  const byoProviders = parseByoProviders(process.env.BOARDWALK_BYO_PROVIDERS);
  Reflect.deleteProperty(process.env, "BOARDWALK_BYO_PROVIDERS");

  // Browser tier: only when the runner IMAGE declares the browser stack (BOARDWALK_BROWSER_TIER=1 +
  // a Chrome path). The backend is run-independent (buildHost builds the per-run manager over it);
  // absent ⇒ `computer.openBrowser()` fails clearly. Read here so env-reading stays out of the pure wiring.
  const guestBrowserConfig = loadGuestBrowserConfig(process.env);
  const browserBackend =
    guestBrowserConfig !== null ? makeGuestBrowserBackend(guestBrowserConfig) : undefined;
  // Screen capture (recording + live-view): present only when the image ships the desktop stack
  // (ffmpeg + a display) and recording isn't disabled. Read here so env-reading stays out of the wiring.
  const captureConfig = loadCaptureConfig(process.env);
  const captureBackend = captureConfig !== null ? makeCaptureBackend(captureConfig) : undefined;

  const deps = assembleWorkerDeps({
    workerId: process.env.WORKER_ID ?? `worker-${runId}`,
    workspaceRoot: process.env.WORKSPACE_ROOT ?? "/workspace",
    runId,
    controlPlane: platform.controlPlane,
    vcpus: platform.vcpus,
    ...(byoProviders.length > 0 ? { byoProviders } : {}),
    ...(freezeRelay !== undefined ? { freezeRelay } : {}),
    ...(browserBackend !== undefined ? { browserBackend } : {}),
    ...(captureBackend !== undefined ? { captureBackend } : {}),
  });

  // The only thing to drain is the batched telemetry buffer — the runner opens no database, cache, or queue.
  const cleanup = async (): Promise<void> => {
    await deps.flushTelemetry?.().catch(() => undefined);
  };

  // SIGTERM: the orchestrator is stopping the task. Hold-and-pay has no mid-run checkpoint; we exit and let the
  // lease expire → the scheduler-sweep reclaims it and a fresh worker RESTARTS the run from the
  // top (Lambda/GHA semantics; durable children re-attach via idempotency). Crash-safe by design.
  let shuttingDown = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.warn("worker_signal_exit", { runId, signal });
      void cleanup().finally(() => process.exit(0));
    });
  }

  try {
    const outcome = await runProgramWorker(runId, deps);
    log.info("worker_finished", { runId, outcome: outcome.kind });
  } catch (err) {
    log.error("worker_crashed", { runId, error: err instanceof Error ? err.message : String(err) });
    await cleanup();
    process.exit(1);
  }
  await cleanup();
  process.exit(0);
}
