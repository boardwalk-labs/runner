// WorkerWorkflowHost — the runner's capability layer behind the host protocol (the
// workflow-format redesign). The protocol server's `HostCapabilities` seam delegates here:
//
//   agent(prompt, opts)        → an ephemeral agent leaf (the demoted agent loop)
//   sleep(arg)                 → an IN-PROCESS hold (hold-and-pay; no checkpoint, no exit)
//   workflows.call(slug, in)   → a durable child run (parent holds while it runs)
//   secrets.get(name)          → the run's fail-closed secret resolver
//
// The leaf executor, child dispatcher, and secret accessor are injected seams so each lights
// up independently (agent leaf, composition, secrets are separate plan items) and the host's
// own logic — chiefly the sleep-hold + argument resolution — is unit-tested in isolation.

import { AppError, ErrorCode } from "./support/index.js";
import type {
  AgentOptions,
  ArtifactBody,
  ArtifactRef,
  BrowserSession,
  BrowserSessionOptions,
  CallOptions,
  HumanInputOptions,
  HumanInputResult,
  PhaseOptions,
  ShellResult,
  SleepArg,
  UsageSnapshot,
} from "@boardwalk-labs/workflow/runtime";
import type { ShellOptions } from "@boardwalk-labs/workflow";
import type { BrowserSessionManager } from "./browser_session.js";
import { LeafParked, type LeafResume } from "@boardwalk-labs/engine/core";
import { normalizeHumanInputResult } from "./wire/human_input.js";
import { BUDGET_GATE_KEY } from "./budget_gate.js";
import { SuspensionCounter, SUSPEND_THRESHOLD_MS, type SuspendSignal } from "./suspension.js";
import type { FreezeCoordinator, FreezeOutcome, WakeValue } from "./freeze_coordinator.js";
import { throwIfAborted } from "./run_abort.js";

/** Parse a `humanInput({ timeout })` string (`"48h"`, `"30m"`, `"90s"`, `"7d"`) to milliseconds, or
 *  null when absent/unparseable (the gate then waits indefinitely). */
export function parseTimeoutMs(timeout: string | undefined): number | null {
  if (timeout === undefined) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d)\s*$/i.exec(timeout);
  const amount = m?.[1];
  const unit = m?.[2]?.toLowerCase();
  if (amount === undefined || unit === undefined) return null;
  const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return Math.round(Number(amount) * mult);
}

/** The 7-day ceiling on a single hold (matches the legacy sleep tool). */
export const MAX_SLEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** Runs one ephemeral agent leaf to completion (text, or a schema-validated object). The `signal`
 *  carries cooperative cancellation — the leaf stops its model loop and throws when it fires. A
 *  `resume` (present only on a tool-level human-input resume) re-enters a parked leaf from its
 *  checkpoint + the answers, instead of starting fresh. A leaf that PARKS (the model called the
 *  `human_input` tool with no answer yet) throws {@link LeafParked}, which the host turns into a
 *  suspend — the executor itself never catches it. */
export interface LeafExecutor {
  run(
    prompt: string,
    opts: AgentOptions | undefined,
    signal?: AbortSignal,
    resume?: LeafResume,
  ): Promise<unknown>;
}

/**
 * When + how often a `workflows.schedule` fires (exactly one of cron/rate/at). MIRRORS the SDK's
 * `ScheduleOptions` — defined locally so the host compiles BEFORE the @boardwalk-labs/workflow bump
 * that adds `scheduleWorkflow` to `WorkflowHost`; once that lands, `scheduleWorkflow` below satisfies
 * the (optional) interface member structurally.
 */
export interface ScheduleOptions {
  cron?: string;
  rate?: string;
  at?: string | Date;
  timezone?: string;
  idempotencyKey?: string;
}

/** A child run's terminal-relevant state, as the start/poll seams return it. */
export interface ChildResult {
  childRunId: string;
  status: string;
  output: unknown;
}

/** Dispatches child runs: `call` holds in-process + returns the completed child's output (the
 *  hold path); `start`/`poll` back the snapshot-substrate callWorkflow seam (start once, freeze
 *  `waiting_for_child` on a non-terminal child); `run` is fire-and-forget → run id; `schedule`
 *  provisions a durable future/recurring run → schedule id. The `signal` lets a hold/start abort
 *  promptly when the parent run is cancelled. */
export interface ChildDispatcher {
  call(
    slug: string,
    input: unknown,
    opts: CallOptions | undefined,
    signal?: AbortSignal,
  ): Promise<unknown>;
  /** Start (or idempotently re-attach to) a child run; resolves its current state. */
  start(
    slug: string,
    input: unknown,
    opts: CallOptions | undefined,
    signal?: AbortSignal,
  ): Promise<ChildResult>;
  run(slug: string, input: unknown, opts: CallOptions | undefined): Promise<string>;
  schedule(slug: string, input: unknown, opts: ScheduleOptions): Promise<string>;
}

/** Resolves a granted secret to its plaintext value (audited, fail-closed). */
export interface SecretAccessor {
  get(name: string): Promise<string>;
}

/** Register a HELD HITL gate so it is answerable while the run keeps its process, and poll for
 *  the answer. Backed by the broker's `inputs` endpoints. On the snapshot substrate this is the
 *  register-without-release half of a freeze; on a no-freeze runtime (a self-hosted daemon) it is
 *  the WHOLE mechanism — the seam registers, then holds and polls until answered. */
export interface HeldInputPort {
  register(seq: number, gate: SuspendSignal["humanInput"]): Promise<unknown>;
  poll(seq: number): Promise<Record<string, unknown>>;
}

/** Holds the process for `ms` milliseconds. The seam exists so tests don't wait on real time. An
 *  abort fires the hold REJECT (with the signal's RunAbortedError) and clears the timer — so a
 *  multi-day sleep aborted early doesn't leave a live timer pinning the event loop open. */
export interface SleepController {
  hold(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Phase lifecycle controller injected by the worker's telemetry layer. */
export interface PhaseController {
  set(name: string, opts: PhaseOptions | undefined): void;
  capture(): string | null;
  runInPhase<T>(phaseId: string | null, fn: () => Promise<T>): Promise<T>;
}

/** Default controller: a real timer. `setTimeout`'s ~24.8-day max comfortably covers MAX_SLEEP_MS. */
export class TimerSleepController implements SleepController {
  hold(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(abortError(signal));
    if (ms <= 0) return Promise.resolve();
    // No signal: a plain timer.
    if (signal === undefined) {
      return new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    }
    // With a signal (now narrowed to AbortSignal): race the timer against the abort, clearing the
    // timer on abort so a multi-day hold doesn't pin the event loop open after an early cancel.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/** The RunAbortedError carried on an aborted signal (or a generic abort Error as a fallback). */
function abortError(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  return r instanceof Error ? r : new Error("aborted");
}

/**
 * The run's identity + on-demand public-API token, surfaced to the program as
 * `import { runtime } from "@boardwalk-labs/workflow"`. MIRRORS the SDK's `RuntimeContext` — defined
 * locally so the host compiles BEFORE the @boardwalk-labs/workflow bump that adds the optional
 * `runtime` member to `WorkflowHost`; once that lands, the host's `runtime` satisfies it
 * structurally. Platform credentials are NEVER placed in `process.env` (the run env/credential rules):
 * trusted program code reaches the public-API bearer ONLY through `apiToken()`, which is redacted
 * from all LLM context.
 */
export interface RuntimeContext {
  runId: string;
  workflowId: string;
  orgId: string;
  /** Public API base origin (e.g. `https://api.boardwalk.sh`); the program appends `/v1` or `/mcp/v1`. */
  apiUrl: string;
  /** A short-lived, manifest-scoped bearer for the public API / MCP / CLI. */
  apiToken(): Promise<string>;
  /** A short-lived OIDC id-token asserting this run's identity for `audience`, for federation into
   *  the org's OWN cloud (AWS `AssumeRoleWithWebIdentity` / GCP / Azure). Minted per call by the
   *  broker (gated server-side on `permissions.id_token: "write"`) with the CURRENT run token, so it
   *  needs no swap handling across suspend/resume — unlike the captured `apiToken` bearer. */
  idToken(audience: string): Promise<string>;
}

export interface WorkerWorkflowHostDeps {
  leaf: LeafExecutor;
  children: ChildDispatcher;
  secrets: SecretAccessor;
  /** The run's identity + on-demand public-API bearer (see {@link RuntimeContext}), exposed to the
   *  program via `import { runtime }`. The bearer never sits in env — it's served on demand here. */
  runtime: RuntimeContext;
  /** Persists a file artifact for the run (→ broker artifact store); resolves to its id + signed
   *  download URL. Absent ⇒ artifacts.write is unsupported and the host method rejects clearly. */
  writeArtifact?: (
    name: string,
    contentType: string,
    body: ArtifactBody,
    metadata: Record<string, unknown> | undefined,
  ) => Promise<ArtifactRef>;
  /** Per-run browser-session manager (computer use, the browser tier). Absent ⇒ `computer.openBrowser`
   *  is unsupported (no desktop/browser backend) and the host method rejects clearly. When present,
   *  `agent({ session })` binds the session's in-VM Playwright MCP to the leaf. */
  browserSessions?: BrowserSessionManager;
  /** Cooperative-cancellation signal for the run (credit exhaustion today; user cancel later). Every
   *  hook checks it at entry and unwinds (throws RunAbortedError); the spending/blocking hooks
   *  (`agent`/`sleep`/`callWorkflow`) thread it down so an in-flight op stops promptly. Absent ⇒ no
   *  cancellation (local/pre-watcher path). */
  signal?: AbortSignal;
  /** Called before a real (`ms > 0`) hold begins — used to snapshot the persistent workspace so a
   *  crash during a long sleep can restore it. Best-effort (its own errors are swallowed). Absent ⇒
   *  no pre-sleep hook (workspace persistence off). */
  onBeforeSleep?: () => Promise<void>;
  /** Defaults to {@link TimerSleepController}. */
  sleeper?: SleepController;
  /** Optional run-detail phase marker support. Absent ⇒ Phase markers are a no-op in this host. */
  phases?: PhaseController;
  /** Injected clock for `until`-relative sleeps. Defaults to Date.now. */
  now?: () => number;
  /** Override the 7-day hold ceiling (tests). */
  maxSleepMs?: number;
  /**
   * Snapshot-substrate suspension (the microVM freeze model): when present, a suspending seam
   * BLOCKS on the coordinator — the platform freezes the whole VM and a wake resolves the seam in
   * place, heap intact. Every hook also runs under the coordinator's quiescence gate: a freeze
   * never captures a live platform stream, and work arriving while a freeze is pending queues
   * until the wake. Absent ⇒ the no-substrate HOLD path: a waiting seam blocks the live process
   * for the whole wait (self-hosted daemons, the Fargate break-glass, unit tests).
   */
  freeze?: FreezeCoordinator;
  /** Register + poll for HELD human-input gates (see {@link HeldInputPort}). Absent alongside
   *  `freeze` ⇒ a held gate is answerable only once it freezes; absent WITHOUT `freeze` ⇒
   *  humanInput is unsupported in this runtime and rejects clearly. */
  heldInput?: HeldInputPort;
  /** Poll interval for a held gate's answer (default 3s). */
  heldPollIntervalMs?: number;
  /** Backs the protocol's `shell` capability (shell_exec's runShell in production). Absent ⇒
   *  `shell()` is unsupported in this runtime and rejects clearly. */
  shell?: (cmd: string, opts: ShellOptions | undefined) => Promise<ShellResult>;
  /** Live budget state for `usage.get` (the BudgetMeter's usageSnapshot in production). Absent ⇒
   *  `usage.get()` is unsupported in this runtime and rejects clearly. */
  usage?: () => UsageSnapshot;
}

export class WorkerWorkflowHost {
  private readonly sleeper: SleepController;
  private readonly now: () => number;
  private readonly maxSleepMs: number;
  private readonly heldPollIntervalMs: number;
  /** Monotonic per-run counter keying suspensions + their HITL gate rows. */
  private readonly seq: SuspensionCounter;
  /** Run context + on-demand public-API bearer the SDK `runtime` accessor reads off the host. */
  readonly runtime: RuntimeContext;

  constructor(private readonly deps: WorkerWorkflowHostDeps) {
    this.sleeper = deps.sleeper ?? new TimerSleepController();
    this.now = deps.now ?? Date.now;
    this.maxSleepMs = deps.maxSleepMs ?? MAX_SLEEP_MS;
    this.heldPollIntervalMs = deps.heldPollIntervalMs ?? 3_000;
    this.seq = new SuspensionCounter();
    this.runtime = deps.runtime;
  }

  /** Run `fn` only if the run isn't aborted; otherwise REJECT (never throw synchronously) with the
   *  signal's RunAbortedError — every Promise-returning hook funnels through this so callers always
   *  get a rejected promise on abort, not a sync throw. On the snapshot substrate the body also runs
   *  under the freeze coordinator's quiescence gate (see {@link WorkerWorkflowHostDeps.freeze}). */
  private guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      throwIfAborted(this.deps.signal);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    const phases = this.deps.phases;
    // Capture the phase at CALL time — BEFORE any gate queueing — so a hook that queued across a
    // freeze still lands in the phase its call site was in.
    const phaseId = phases?.capture() ?? null;
    const body = phases === undefined ? fn : (): Promise<T> => phases.runInPhase(phaseId, fn);
    const freeze = this.deps.freeze;
    if (freeze === undefined) return body();
    return freeze.trackWork(body);
  }

  /** A suspending seam's freeze wait: step out of the "work" count around the park (the wait itself
   *  is what the gate waits FOR, not work that blocks it), then rejoin on resume. */
  private async freezeWait(
    freeze: FreezeCoordinator,
    signal: SuspendSignal,
    abort?: AbortSignal,
  ): Promise<FreezeOutcome> {
    freeze.endWork();
    try {
      return await freeze.suspendingWait(signal, abort);
    } finally {
      freeze.beginWork();
    }
  }

  /**
   * Snapshot-substrate `humanInput()` with REGISTER-WITHOUT-RELEASE.
   * A gate reached while a sibling seam is still in flight HOLDS (the quiescence gate won't freeze
   * yet), but a human must still be able to answer during that hold. So: register the gate with the
   * broker immediately (it surfaces in the inbox/API at once), then race two outcomes —
   *   - the answer arrives (brokered poll) while holding ⇒ WITHDRAW the freeze wait and resolve
   *     in-process (the run never froze); or
   *   - quiescence is reached with no answer ⇒ the wait freezes, and the wake carries the answer.
   * Once frozen the poll is frozen too (same process), so the race is only live during the hold.
   * A register/poll failure degrades to the plain freeze wait — the gate still works, just without
   * the answerable-while-held property.
   */
  private async freezeHumanInput(
    freeze: FreezeCoordinator,
    signal: SuspendSignal,
    key: string,
  ): Promise<HumanInputResult> {
    const held = this.deps.heldInput;
    if (held === undefined) {
      // No held-input port wired: the gate can only be answered once it freezes.
      return this.resolveFreezeAnswer(await this.freezeWait(freeze, signal), key);
    }
    await held.register(signal.seq, signal.humanInput);
    const withdraw = new AbortController();
    const poll = this.pollHeldAnswer(held, signal.seq, key, withdraw.signal);
    const outcome = await Promise.race([
      poll.then((answer) => ({ kind: "answered" as const, answer })),
      this.freezeWait(freeze, signal, withdraw.signal).then((o) => ({ kind: "froze" as const, o })),
    ]);
    if (outcome.kind === "answered") {
      withdraw.abort(); // withdraw the still-holding freeze wait (no-op if it already froze)
      return normalizeHumanInputResult(outcome.answer);
    }
    withdraw.abort(); // stop the poll loop; the wake path carries the answer
    return this.resolveFreezeAnswer(outcome.o, key);
  }

  /** Poll the broker for a held gate's answer until it arrives or the wait withdraws. Resolves with
   *  the answer value; never rejects the run (a transient poll error just retries next tick). Runs
   *  OUTSIDE the quiescence gate (it is not run work — it must not block a freeze). */
  private async pollHeldAnswer(
    held: HeldInputPort,
    seq: number,
    key: string,
    abort: AbortSignal,
  ): Promise<unknown> {
    for (;;) {
      if (abort.aborted) return await new Promise<never>(() => undefined); // frozen path won: never resolve
      try {
        const answers = await held.poll(seq);
        if (key in answers) return answers[key];
      } catch {
        /* transient — retry next tick */
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.heldPollIntervalMs);
        abort.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
    }
  }

  /**
   * The no-freeze HOLD for a human-input gate: register it with the broker (it surfaces in the
   * inbox/API at once), then poll until the answer arrives — the process stays alive and pays
   * for the wait. Rejects promptly when the run's abort signal fires (cancel / credit stop),
   * which is also how a server-side gate expiry that fails the run unwinds this loop.
   */
  private async holdForAnswer(seq: number, gate: SuspendSignal["humanInput"]): Promise<unknown> {
    const held = this.deps.heldInput;
    if (held === undefined || gate === undefined) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        "humanInput is not available in this runtime (no control-plane connection to register the gate)",
        { kind: "human_input_unavailable" },
      );
    }
    await held.register(seq, gate);
    for (;;) {
      throwIfAborted(this.deps.signal);
      try {
        const answers = await held.poll(seq);
        if (gate.key in answers) return answers[gate.key];
      } catch {
        /* transient — retry next tick */
      }
      await this.sleeper.hold(this.heldPollIntervalMs, this.deps.signal);
    }
  }

  /** Map a froze/aborted freeze outcome to the gate's answer (or throw on an unexpected abort). */
  private resolveFreezeAnswer(outcome: FreezeOutcome, key: string): HumanInputResult {
    if (outcome.kind !== "wake") {
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        `Freeze wait for a human-input gate ended unexpectedly (${outcome.kind})`,
        { kind: "unexpected_freeze_outcome", key },
      );
    }
    return normalizeHumanInputResult(this.gateAnswer(outcome.wake, key));
  }

  /** The wake's answer for one gate key. A wake whose value is missing the parked gate means the
   *  control plane and the snapshot disagree about what this run was waiting for — a platform bug,
   *  failed loudly, never a retry. */
  private gateAnswer(wake: WakeValue, key: string): unknown {
    const answer = wake.answers?.[key];
    if (wake.kind !== "human_input" || answer === undefined) {
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        `Wake value does not answer the parked gate "${key}" (got kind "${wake.kind}")`,
        { kind: "wake_mismatch", key },
      );
    }
    return answer;
  }

  setPhase(name: string, opts: PhaseOptions | undefined): void {
    throwIfAborted(this.deps.signal);
    this.deps.phases?.set(name, opts);
  }

  agent(prompt: string, opts: AgentOptions | undefined): Promise<unknown> {
    return this.guarded(() => this.agentSeam(prompt, opts));
  }

  /** The `agent()` seam: run the leaf to completion. A leaf that PARKS (the model called the
   *  `human_input` tool) waits for the answer — a freeze on the snapshot substrate, a held poll
   *  otherwise — and re-enters from its in-memory checkpoint. Nothing is memoized: a crash-restart
   *  re-runs the leaf (restart-from-top semantics). */
  private async agentSeam(prompt: string, opts: AgentOptions | undefined): Promise<unknown> {
    // One suspension key for the whole leaf: every gate this leaf raises registers under it, and
    // a wake joins ALL of its answered rows, so answers accumulate server-side across parks.
    const seq = this.seq.next();
    // Bind a computer-use session's tools (browser tier ⇒ its in-VM Playwright MCP) if one was passed.
    const effectiveOpts = this.bindBrowserSession(opts);
    // Held-path answers accumulate locally too: a turn with several human_input calls parks once
    // per unanswered gate, and each re-entry must still see every earlier answer.
    const heldAnswers: Record<string, unknown> = {};
    let resume: LeafResume | undefined;
    for (;;) {
      try {
        return await this.deps.leaf.run(prompt, effectiveOpts, this.deps.signal, resume);
      } catch (err) {
        if (!(err instanceof LeafParked)) throw err;
        // The model paused for a person (the in-leaf `human_input` tool).
        if (err.checkpoint === undefined) {
          throw new AppError(
            ErrorCode.INTERNAL_ERROR,
            "Parked agent leaf has no checkpoint to resume from",
            { kind: "leaf_parked_no_checkpoint", seq },
          );
        }
        const signal: SuspendSignal = {
          reason: "human_input",
          seq,
          leafCheckpoint: err.checkpoint,
          humanInput: {
            key: err.request.toolCallId,
            prompt: err.request.prompt,
            inputSpec: err.request.inputSpec,
          },
        };
        const freeze = this.deps.freeze;
        if (freeze === undefined) {
          // Hold path: register the gate and poll until answered; the transcript stays in memory.
          heldAnswers[err.request.toolCallId] = await this.holdForAnswer(seq, signal.humanInput);
          resume = { checkpoint: err.checkpoint, answers: { ...heldAnswers } };
          continue;
        }
        // Snapshot substrate: freeze in place; the wake carries the answers and the leaf
        // re-enters from its checkpoint — heap intact. A leaf may park again on a later turn,
        // so this loops.
        const outcome = await this.freezeWait(freeze, signal);
        if (outcome.kind !== "wake") {
          throw new AppError(
            ErrorCode.INTERNAL_ERROR,
            "Suspend aborted surfaced to a human-input seam (the coordinator retries these)",
            { kind: "unexpected_abort", seq },
          );
        }
        // Validate OUR gate is answered, but hand the leaf the whole batch (spec: a wake
        // carries every answer the suspension raised, keyed by tool-call id).
        this.gateAnswer(outcome.wake, err.request.toolCallId);
        resume = { checkpoint: err.checkpoint, answers: { ...(outcome.wake.answers ?? {}) } };
      }
    }
  }

  /** Program-level `humanInput()`: wait on a gate — a freeze on the snapshot substrate, a held
   *  poll otherwise — and return the validated answer. The SDK marks this optional; the hosted
   *  host always implements it. */
  humanInput(opts: HumanInputOptions): Promise<HumanInputResult> {
    return this.guarded(() => this.humanInputSeam(opts));
  }

  private async humanInputSeam(opts: HumanInputOptions): Promise<HumanInputResult> {
    const seq = this.seq.next();
    const key = opts.key ?? `seam-${String(seq)}`;
    const expiresAt = this.timeoutExpiry(opts.timeout);
    const signal: SuspendSignal = {
      reason: "human_input",
      seq,
      humanInput: {
        key,
        prompt: opts.prompt,
        inputSpec: opts.input,
        ...(opts.assignees !== undefined ? { assignees: [...opts.assignees] } : {}),
        // A timeout only matters with a wake to fire at; carry onTimeout alongside expiresAt.
        ...(expiresAt !== null ? { expiresAt, onTimeout: opts.onTimeout ?? "fail" } : {}),
      },
    };
    const freeze = this.deps.freeze;
    if (freeze !== undefined) {
      return await this.freezeHumanInput(freeze, signal, key);
    }
    // Hold path: register the gate and poll until a person answers.
    return normalizeHumanInputResult(await this.holdForAnswer(seq, signal.humanInput));
  }

  /**
   * Park the run at a BUDGET gate and resolve with the responder's answer (docs/SUSPEND_POLICY.md
   * Decision 3). Called by the leaf executor's `streamModel` seam when the run's `max_usd` cap is
   * breached, i.e. from INSIDE an in-flight `agent()` — which drives two deliberate differences from
   * {@link humanInputSeam}:
   *
   *  - **No `guarded()` wrapper.** The enclosing `agent()` seam already counted this leaf as work via
   *    `trackWork`. Wrapping again would double-count it, and the extra count would never be released
   *    — quiescence would never be reached and the freeze would hang forever. `freezeHumanInput` →
   *    `freezeWait` does the right thing here: it `endWork`s for the duration of the park (this leaf
   *    is waiting, not working, which is exactly what lets the run reach quiescence and freeze) and
   *    rejoins on resume.
   *  - **Abort is not re-checked up front.** `streamModel` has just done it; a park is not a new
   *    entry point.
   *
   * The gate itself is an ordinary {@link HumanInputGate} keyed `budget`, so it persists, surfaces in
   * the inbox, and is answered by the same machinery as any other gate. No timeout: an unanswered
   * budget gate is aged out by the control plane's inactive-cancel reaper, not by a wake we schedule.
   */
  async budgetClearance(gate: { prompt: string; inputSpec: unknown }): Promise<HumanInputResult> {
    const seq = this.seq.next();
    const key = BUDGET_GATE_KEY;
    const signal: SuspendSignal = {
      reason: "budget",
      seq,
      humanInput: { key, prompt: gate.prompt, inputSpec: gate.inputSpec },
    };
    const freeze = this.deps.freeze;
    if (freeze !== undefined) {
      return await this.freezeHumanInput(freeze, signal, key);
    }
    // No freeze substrate (self-hosted runner / local dev): hold the live process until answered.
    return normalizeHumanInputResult(await this.holdForAnswer(seq, signal.humanInput));
  }

  /** Absolute wake time for a `humanInput({ timeout })`, or null when there is none / it's unparseable. */
  private timeoutExpiry(timeout: string | undefined): number | null {
    const ms = parseTimeoutMs(timeout);
    return ms === null ? null : this.now() + ms;
  }

  callWorkflow(slug: string, input: unknown, opts: CallOptions | undefined): Promise<unknown> {
    return this.guarded(() => this.callWorkflowSeam(slug, input, opts));
  }

  /** The `workflows.call` seam: start the child once (idempotently — the child's run row is the
   *  durable memo, so a crash-restarted parent re-attaches instead of re-spawning). A non-terminal
   *  child suspends the parent `waiting_for_child` on the snapshot substrate (the wake carries the
   *  finalized child, heap intact); without one the parent HOLDS in-process and polls. */
  private async callWorkflowSeam(
    slug: string,
    input: unknown,
    opts: CallOptions | undefined,
  ): Promise<unknown> {
    const freeze = this.deps.freeze;
    if (freeze === undefined) {
      // Hold path: the dispatcher's in-process hold-and-poll until the child is terminal.
      return this.deps.children.call(slug, input, opts, this.deps.signal);
    }
    const child = await this.deps.children.start(slug, input, opts, this.deps.signal);
    if (child.status === "completed") return child.output;
    if (child.status === "failed" || child.status === "cancelled") {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `Called workflow "${slug}" ${child.status} (run ${child.childRunId})`,
        { childRunId: child.childRunId, status: child.status },
      );
    }
    // Still running → park in place; the wake carries the finalized child directly (the heap
    // holds this whole frame across the freeze).
    const seq = this.seq.next();
    const outcome = await this.freezeWait(freeze, {
      reason: "workflow_call",
      seq,
      childRunId: child.childRunId,
    });
    if (outcome.kind !== "wake") {
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        "Suspend aborted surfaced to a child-wait seam (the coordinator retries these)",
        { kind: "unexpected_abort", seq },
      );
    }
    const woken = outcome.wake.child;
    if (outcome.wake.kind !== "workflow_call" || woken === undefined) {
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        `Wake value does not carry the awaited child run (got kind "${outcome.wake.kind}")`,
        { kind: "wake_mismatch", childRunId: child.childRunId },
      );
    }
    if (woken.status === "completed") return woken.output;
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      `Called workflow "${slug}" ${woken.status} (run ${woken.run_id})`,
      { childRunId: woken.run_id, status: woken.status },
    );
  }

  /** Fire-and-forget trigger of another workflow; resolves to the new run's id (no hold/poll). */
  runWorkflow(slug: string, input: unknown, opts: CallOptions | undefined): Promise<string> {
    return this.guarded(async () => {
      const id = await this.deps.children.run(slug, input, opts);
      return id;
    });
  }

  /** Provision a durable schedule (one-shot/recurring) that fires the target later; resolves to the
   *  new schedule's id WITHOUT running it now. Satisfies the SDK's optional `scheduleWorkflow`. */
  scheduleWorkflow(slug: string, input: unknown, opts: ScheduleOptions): Promise<string> {
    return this.guarded(async () => {
      const id = await this.deps.children.schedule(slug, input, opts);
      return id;
    });
  }

  getSecret(name: string): Promise<string> {
    return this.guarded(async () => {
      const value = await this.deps.secrets.get(name);
      return value;
    });
  }

  writeArtifact(
    name: string,
    contentType: string,
    body: ArtifactBody,
    metadata: Record<string, unknown> | undefined,
  ): Promise<ArtifactRef> {
    return this.guarded(async () => {
      if (this.deps.writeArtifact === undefined) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          "artifacts.write is not available in this runtime",
        );
      }
      const ref = await this.deps.writeArtifact(name, contentType, body, metadata);
      return ref;
    });
  }

  /** `computer.openBrowser()`: open a program-owned, in-VM browser session (the browser tier of
   *  computer use). Not a durable seam — a session is a live resource, reaped at run end, never
   *  persisted. Absent backend ⇒ a clear "not available" error. */
  openBrowserSession(opts: BrowserSessionOptions | undefined): Promise<BrowserSession> {
    return this.guarded(async () => {
      if (this.deps.browserSessions === undefined) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          "computer.openBrowser is not available in this runtime (no browser backend)",
        );
      }
      return await this.deps.browserSessions.open(opts);
    });
  }

  /** Translate `agent({ session })` into the leaf's `mcp`: append the browser session's in-VM
   *  Playwright MCP (its http ref, which passes assertHostedMcpAllowed and reaches localhost without
   *  the egress proxy) and strip the `session` handle (the engine doesn't understand it). No-op when
   *  no session is bound. */
  private bindBrowserSession(opts: AgentOptions | undefined): AgentOptions | undefined {
    if (opts === undefined || opts.session === undefined) return opts;
    const ref = this.deps.browserSessions?.mcpRefFor(opts.session);
    if (ref === null || ref === undefined) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        "agent({ session }) received a browser session that is not open in this run",
        { kind: "browser_session_not_open" },
      );
    }
    const rest: AgentOptions = { ...opts };
    delete rest.session;
    return { ...rest, mcp: [...(rest.mcp ?? []), ref] };
  }

  sleep(arg: SleepArg): Promise<void> {
    return this.guarded(() => this.sleepSeam(arg));
  }

  /** A short sleep HOLDS the task in-process (cheaper than a snapshot round-trip); a long one
   *  (≥ {@link SUSPEND_THRESHOLD_MS}) SUSPENDS on the snapshot substrate — the VM freezes and the
   *  wake resolves this very await, heap intact. Without a freeze substrate EVERY sleep holds,
   *  whatever its length (the no-substrate rule: snapshot or hold, never replay). */
  private async sleepSeam(arg: SleepArg): Promise<void> {
    const ms = this.resolveSleepMs(arg);
    if (ms > this.maxSleepMs) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `Sleep exceeds the ${String(this.maxSleepMs)}ms (7-day) maximum`,
        { kind: "sleep_cap" },
      );
    }
    // A non-positive duration (incl. an `until` already in the past) is a no-op hold, not an error.
    const holdMs = Math.max(0, ms);
    if (holdMs === 0) return;
    const freeze = this.deps.freeze;
    if (holdMs >= SUSPEND_THRESHOLD_MS && freeze !== undefined) {
      // Snapshot substrate: freeze in place. An abort falls back to holding the REMAINDER
      // in-process.
      const requestedAt = this.now();
      const seq = this.seq.next();
      const outcome = await this.freezeWait(freeze, { reason: "sleep", seq, durationMs: holdMs });
      if (outcome.kind === "wake") return;
      const remaining = holdMs - (this.now() - requestedAt);
      if (remaining <= 0) return;
      if (this.deps.onBeforeSleep !== undefined) await this.deps.onBeforeSleep();
      await this.sleeper.hold(remaining, this.deps.signal);
      return;
    }
    // Hold: the process sleeps in place (a crash-restart simply re-holds). Snapshot the
    // persistent workspace first so a crash during the hold can restore it. An abort mid-hold rejects.
    if (this.deps.onBeforeSleep !== undefined) await this.deps.onBeforeSleep();
    await this.sleeper.hold(holdMs, this.deps.signal);
  }

  /** The protocol's `shell` capability. Runs under the same abort/freeze gate as every hook, so
   *  a freeze never snapshots around an unguarded seam and an aborted run rejects promptly. */
  shell(cmd: string, opts: ShellOptions | undefined): Promise<ShellResult> {
    return this.guarded(async () => {
      if (this.deps.shell === undefined) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, "shell is not available in this runtime");
      }
      return await this.deps.shell(cmd, opts);
    });
  }

  /** Live budget state for `usage.get` — every dimension `{spent, cap, remaining}`. */
  usage(): Promise<UsageSnapshot> {
    return this.guarded(async () => {
      if (this.deps.usage === undefined) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          "usage.get is not available in this runtime",
        );
      }
      return Promise.resolve(this.deps.usage());
    });
  }

  /** `auth.idToken(audience)` — minted per call by the broker via {@link RuntimeContext}. */
  idToken(audience: string): Promise<string> {
    return this.guarded(() => this.deps.runtime.idToken(audience));
  }

  /** `auth.apiToken()` — the run's short-lived, manifest-scoped public-API bearer. */
  apiToken(): Promise<string> {
    return this.guarded(() => this.deps.runtime.apiToken());
  }

  /** Resolve any {@link SleepArg} shape to a millisecond duration from now. */
  private resolveSleepMs(arg: SleepArg): number {
    if (typeof arg === "number") return arg;
    if ("durationMs" in arg) return arg.durationMs;
    const until = typeof arg.until === "string" ? Date.parse(arg.until) : arg.until.getTime();
    if (!Number.isFinite(until)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, "Could not parse sleep `until` timestamp");
    }
    return until - this.now();
  }
}
