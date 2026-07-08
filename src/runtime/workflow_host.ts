// WorkerWorkflowHost — the real WorkflowHost the worker installs onto @boardwalk-labs/workflow
// before running a program (the workflow runtime design). The program's hooks delegate here:
//
//   agent(prompt, opts)        → an ephemeral Strands agent leaf (the demoted agent loop)
//   sleep(arg)                 → an IN-PROCESS hold (hold-and-pay; no checkpoint, no exit)
//   workflows.call(slug, in)   → a durable child run (parent holds while it runs)
//   secrets.get(name)          → the run's fail-closed secret resolver
//
// The leaf executor, child dispatcher, and secret accessor are injected seams so each lights
// up independently (agent leaf, composition, secrets are separate plan items) and the host's
// own logic — chiefly the sleep-hold + argument resolution — is unit-tested in isolation.

import { AppError, ErrorCode } from "./support/index.js";
import type {
  WorkflowHost,
  AgentOptions,
  ArtifactBody,
  ArtifactRef,
  CallOptions,
  HumanInputOptions,
  HumanInputResult,
  PhaseOptions,
  SleepArg,
} from "@boardwalk-labs/workflow/runtime";
import { LeafParked, type LeafResume } from "@boardwalk-labs/engine/core";
import { normalizeHumanInputResult } from "./wire/human_input.js";
import {
  SeamSequencer,
  SuspendError,
  childRunIdSchema,
  determinismError,
  leafResumeSchema,
  seamFingerprint,
  SUSPEND_THRESHOLD_MS,
  type JournalSeam,
  type SuspendSignal,
} from "./suspension.js";
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

/** Dispatches child runs: `call` holds + returns output (the no-journal path); `start`/`poll` back the
 *  DURABLE callWorkflow seam (start once, suspend `waiting_for_child` on a non-terminal child, poll on
 *  resume); `run` is fire-and-forget → run id; `schedule` provisions a durable future/recurring run →
 *  schedule id. The `signal` lets a hold/start abort promptly when the parent run is cancelled. */
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
  /** Poll a child run's current state by id, or null when it isn't this run's child. */
  poll(childRunId: string): Promise<ChildResult | null>;
  run(slug: string, input: unknown, opts: CallOptions | undefined): Promise<string>;
  schedule(slug: string, input: unknown, opts: ScheduleOptions): Promise<string>;
}

/** Resolves a granted secret to its plaintext value (audited, fail-closed). */
export interface SecretAccessor {
  get(name: string): Promise<string>;
}

/** Register-without-release (docs/SUSPEND_POLICY.md §1.2): register a HELD HITL gate so it is
 *  answerable while the run keeps running, and poll for the answer. Backed by the broker's
 *  `inputs` endpoints. Absent ⇒ a held gate is only answerable once it freezes. */
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
   * Durable-suspension journal (the durable-suspension design): the host memoizes each `agent`/`step`/`sleep`/
   * `humanInput` seam here, so a resumed run replays journaled seams instantly instead of re-running
   * them. Backed by the broker over the run token on hosted runs. Absent ⇒ no memoization (the
   * local/test path): seams run live every time and a suspend can't be resumed.
   */
  journal?: JournalSeam;
  /**
   * Raise a durable suspension: the host calls this from a suspending seam, then returns a
   * never-resolving promise; the worker races that against the program body and tears the task down
   * (the program's own `try/catch` can't swallow a suspend this way). Absent ⇒ a suspending seam
   * rejects with {@link SuspendError} instead (the local/test path).
   */
  onSuspend?: (signal: SuspendSignal) => void;
  /**
   * Snapshot-substrate suspension (the microVM freeze model): when present, a suspending seam
   * BLOCKS on the coordinator instead of raising `onSuspend` — the platform freezes the whole VM
   * and a wake resolves the seam in place, heap intact (no exit, no journal replay). Every hook
   * also runs under the coordinator's quiescence gate: a freeze never captures a live platform
   * stream, and work arriving while a freeze is pending queues until the wake.
   */
  freeze?: FreezeCoordinator;
  /** Register-without-release for HELD human-input gates (docs/SUSPEND_POLICY.md §1.2). Only
   *  meaningful alongside `freeze`; absent ⇒ a held gate is answerable only once it freezes. */
  heldInput?: HeldInputPort;
  /** Poll interval for a held gate's answer (default 3s). */
  heldPollIntervalMs?: number;
  /**
   * The highest journaled seq at claim (0 on a fresh run). While re-running seams up to this
   * frontier on a resume, the host is REPLAYING and observability (phase markers, program logs) is
   * suppressed — those lines were emitted in the prior segment.
   */
  replayFrontier?: number;
}

export class WorkerWorkflowHost implements WorkflowHost {
  private readonly sleeper: SleepController;
  private readonly now: () => number;
  private readonly maxSleepMs: number;
  private readonly heldPollIntervalMs: number;
  /** Synchronous durable-seam counter + silent-replay live flag (the durable-suspension design). */
  private readonly seq: SeamSequencer;
  /** Run context + on-demand public-API bearer the SDK `runtime` accessor reads off the host. */
  readonly runtime: RuntimeContext;

  constructor(private readonly deps: WorkerWorkflowHostDeps) {
    this.sleeper = deps.sleeper ?? new TimerSleepController();
    this.now = deps.now ?? Date.now;
    this.maxSleepMs = deps.maxSleepMs ?? MAX_SLEEP_MS;
    this.heldPollIntervalMs = deps.heldPollIntervalMs ?? 3_000;
    this.seq = new SeamSequencer(deps.replayFrontier ?? 0);
    this.runtime = deps.runtime;
  }

  /** True while re-running already-journaled seams on a resume (the worker suppresses program-log +
   *  phase observability during this window — those lines were emitted in the prior segment). */
  isReplaying(): boolean {
    return this.seq.isReplaying();
  }

  /** Raise a durable suspension. With `onSuspend` wired (the real worker) the host signals out-of-band
   *  and returns a never-resolving promise, so the program's own try/catch can't swallow it; without
   *  it (the local/test path) it rejects with {@link SuspendError}. */
  private suspend(signal: SuspendSignal): Promise<never> {
    if (this.deps.onSuspend === undefined) return Promise.reject(new SuspendError(signal));
    this.deps.onSuspend(signal);
    return new Promise<never>(() => {
      /* never settles: the worker races this against the body and tears the task down */
    });
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
   * Snapshot-substrate `humanInput()` with REGISTER-WITHOUT-RELEASE (docs/SUSPEND_POLICY.md §1.2).
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
    // Suppressed during replay: the marker was already emitted in the prior segment.
    if (this.seq.isReplaying()) return;
    this.deps.phases?.set(name, opts);
  }

  agent(prompt: string, opts: AgentOptions | undefined): Promise<unknown> {
    return this.guarded(() => this.agentSeam(prompt, opts));
  }

  /** The `agent()` durable seam: a journal hit returns the memoized result (never re-runs the LLM); a
   *  `suspended` hit resumes a parked leaf from its checkpoint + answers; a miss runs the leaf and
   *  journals the result. A leaf that PARKS (the model called `human_input`) suspends the run. */
  private async agentSeam(prompt: string, opts: AgentOptions | undefined): Promise<unknown> {
    const seq = this.seq.next();
    const fingerprint = seamFingerprint([
      "agent",
      opts?.provider ?? null,
      opts?.model ?? null,
      prompt,
      opts?.schema ?? null,
    ]);
    let resume: LeafResume | undefined;
    if (this.deps.journal !== undefined) {
      const existing = await this.deps.journal.get(seq);
      if (existing !== null) {
        if (existing.fingerprint !== fingerprint)
          throw determinismError(seq, "agent", existing.kind);
        if (existing.state === "resolved") return existing.result;
        // A `suspended` entry is a parked leaf (tool-level human_input): re-enter it from the stored
        // checkpoint + the answers the broker joined in.
        resume = leafResumeSchema.parse(existing.result);
      }
    }
    for (;;) {
      try {
        const result = await this.deps.leaf.run(prompt, opts, this.deps.signal, resume);
        await this.deps.journal?.put({
          seq,
          kind: "agent",
          fingerprint,
          label: prompt.slice(0, 120),
          result,
        });
        return result;
      } catch (err) {
        if (!(err instanceof LeafParked)) throw err;
        // The model paused for a person (the in-leaf `human_input` tool).
        const signal: SuspendSignal = {
          reason: "human_input",
          seq,
          fingerprint,
          ...(err.checkpoint !== undefined ? { leafCheckpoint: err.checkpoint } : {}),
          humanInput: {
            key: err.request.toolCallId,
            prompt: err.request.prompt,
            inputSpec: err.request.inputSpec,
          },
        };
        const freeze = this.deps.freeze;
        if (freeze === undefined) return this.suspend(signal);
        // Snapshot substrate: freeze in place; the wake carries the answers and the leaf
        // re-enters from its checkpoint — heap intact, no journal round-trip. A leaf may park
        // again on a later turn, so this loops.
        if (err.checkpoint === undefined) {
          throw new AppError(
            ErrorCode.INTERNAL_ERROR,
            "Parked agent leaf has no checkpoint to resume from",
            { kind: "leaf_parked_no_checkpoint", seq },
          );
        }
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

  /** Program-level `humanInput()`: suspend the run on a gate, resume with the validated answer. The
   *  SDK marks this optional; the hosted host always implements it. */
  humanInput(opts: HumanInputOptions): Promise<HumanInputResult> {
    return this.guarded(() => this.humanInputSeam(opts));
  }

  private async humanInputSeam(opts: HumanInputOptions): Promise<HumanInputResult> {
    const seq = this.seq.next();
    const key = opts.key ?? `seam-${String(seq)}`;
    const fingerprint = seamFingerprint(["human_input", key, opts.prompt, opts.input]);
    if (this.deps.journal !== undefined) {
      const existing = await this.deps.journal.get(seq);
      if (existing !== null) {
        if (existing.fingerprint !== fingerprint) {
          throw determinismError(seq, "human_input", existing.kind);
        }
        // A resolved entry is the human's validated response; a still-pending entry is a spurious
        // wake without an answer, so fall through and re-suspend.
        if (existing.state === "resolved") return normalizeHumanInputResult(existing.result);
      }
    }
    const expiresAt = this.timeoutExpiry(opts.timeout);
    const signal: SuspendSignal = {
      reason: "human_input",
      seq,
      fingerprint,
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
    return this.suspend(signal);
  }

  /** Absolute wake time for a `humanInput({ timeout })`, or null when there is none / it's unparseable. */
  private timeoutExpiry(timeout: string | undefined): number | null {
    const ms = parseTimeoutMs(timeout);
    return ms === null ? null : this.now() + ms;
  }

  /** `step.run(name, fn)`: run `fn` exactly once across restarts, memoizing its result in the journal
   *  (the escape hatch for nondeterministic work on a suspend/resume path). */
  step(name: string, fn: () => unknown): Promise<unknown> {
    return this.guarded(() => this.stepSeam(name, fn));
  }

  private async stepSeam(name: string, fn: () => unknown): Promise<unknown> {
    const seq = this.seq.next();
    const fingerprint = seamFingerprint(["step", name]);
    if (this.deps.journal !== undefined) {
      const existing = await this.deps.journal.get(seq);
      if (existing !== null) {
        if (existing.fingerprint !== fingerprint)
          throw determinismError(seq, "step", existing.kind);
        if (existing.state === "resolved") return existing.result;
      }
    }
    const result = await fn();
    await this.deps.journal?.put({ seq, kind: "step", fingerprint, label: name, result });
    return result;
  }

  callWorkflow(slug: string, input: unknown, opts: CallOptions | undefined): Promise<unknown> {
    return this.guarded(() => this.callWorkflowSeam(slug, input, opts));
  }

  /** The `workflows.call` durable seam (the durable-suspension design): start the child once + memoize its
   *  output; a non-terminal child SUSPENDS the parent (`waiting_for_child`, the child's id journaled)
   *  — the parent releases its task and is woken when the child finalizes. On resume the seam polls
   *  the journaled child and returns its output (or throws on a failed child). Without a journal (the
   *  local/test path) it falls back to the in-process hold-and-poll. */
  private async callWorkflowSeam(
    slug: string,
    input: unknown,
    opts: CallOptions | undefined,
  ): Promise<unknown> {
    if (this.deps.journal === undefined) {
      return this.deps.children.call(slug, input, opts, this.deps.signal);
    }
    const seq = this.seq.next();
    const fingerprint = seamFingerprint([
      "workflow_call",
      slug,
      input ?? null,
      opts?.idempotencyKey ?? null,
    ]);
    let knownChildId: string | undefined;
    const existing = await this.deps.journal.get(seq);
    if (existing !== null) {
      if (existing.fingerprint !== fingerprint) {
        throw determinismError(seq, "workflow_call", existing.kind);
      }
      if (existing.state === "resolved") return existing.result;
      // A pending entry holds the child run id we suspended waiting on (resume polls it).
      knownChildId = childRunIdSchema.parse(existing.result);
    }
    // First execution starts (idempotently) the child; a resume polls the journaled one.
    const child =
      knownChildId === undefined
        ? await this.deps.children.start(slug, input, opts, this.deps.signal)
        : await this.deps.children.poll(knownChildId);
    if (child === null) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, `Called workflow's child run vanished`, {
        slug,
        childRunId: knownChildId,
      });
    }
    if (child.status === "completed") {
      await this.deps.journal.put({
        seq,
        kind: "workflow_call",
        fingerprint,
        label: slug,
        result: child.output,
      });
      return child.output;
    }
    if (child.status === "failed" || child.status === "cancelled") {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `Called workflow "${slug}" ${child.status} (run ${child.childRunId})`,
        { childRunId: child.childRunId, status: child.status },
      );
    }
    // Still running → suspend; the child's finalize wakes us.
    const signal: SuspendSignal = {
      reason: "workflow_call",
      seq,
      fingerprint,
      childRunId: child.childRunId,
    };
    const freeze = this.deps.freeze;
    if (freeze !== undefined) {
      // Snapshot substrate: park in place; the wake carries the finalized child directly (no
      // journal write for the wake-derived value — the heap holds it and nothing replays).
      const outcome = await this.freezeWait(freeze, signal);
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
    return this.suspend(signal);
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

  sleep(arg: SleepArg): Promise<void> {
    return this.guarded(() => this.sleepSeam(arg));
  }

  /** A short sleep HOLDS the task in-process (cheaper than a release + replay round-trip); a long one
   *  (≥ {@link SUSPEND_THRESHOLD_MS}) SUSPENDS — releases the task, and a timer re-dispatches the run
   *  when due. Journaled so a resumed run replays past an already-elapsed sleep instantly. */
  private async sleepSeam(arg: SleepArg): Promise<void> {
    const ms = this.resolveSleepMs(arg);
    if (ms > this.maxSleepMs) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `Sleep exceeds the ${String(this.maxSleepMs)}ms (7-day) maximum`,
        { kind: "sleep_cap" },
      );
    }
    const seq = this.seq.next();
    const fingerprint = seamFingerprint(["sleep"]);
    if (this.deps.journal !== undefined) {
      const existing = await this.deps.journal.get(seq);
      if (existing !== null) {
        if (existing.fingerprint !== fingerprint)
          throw determinismError(seq, "sleep", existing.kind);
        // A journaled sleep already elapsed in a prior segment — a resumed run only progresses past a
        // sleep once it is due, so on replay this returns immediately.
        return;
      }
    }
    // A non-positive duration (incl. an `until` already in the past) is a no-op hold, not an error.
    const holdMs = Math.max(0, ms);
    if (holdMs === 0) return;
    const freeze = this.deps.freeze;
    if (holdMs >= SUSPEND_THRESHOLD_MS && freeze !== undefined) {
      // Snapshot substrate: freeze in place; the wake (when the sleep is due) resolves this very
      // await, heap intact. An abort falls back to holding the REMAINDER in-process — the
      // two-ways rule: snapshot or hold, never replay.
      const requestedAt = this.now();
      const outcome = await this.freezeWait(freeze, {
        reason: "sleep",
        seq,
        fingerprint,
        durationMs: holdMs,
      });
      if (outcome.kind === "wake") return;
      const remaining = holdMs - (this.now() - requestedAt);
      if (remaining <= 0) return;
      if (this.deps.onBeforeSleep !== undefined) await this.deps.onBeforeSleep();
      await this.sleeper.hold(remaining, this.deps.signal);
      return;
    }
    // Long wait (transitional substrate): SUSPEND (release the task). The broker records the
    // (resolved) sleep journal entry + the wake time transactionally, so on wake this seam replays
    // past it (the journal hit above). Only when a journal is wired — without it there is no
    // resume, so fall back to holding.
    if (holdMs >= SUSPEND_THRESHOLD_MS && this.deps.journal !== undefined) {
      return this.suspend({ reason: "sleep", seq, fingerprint, durationMs: holdMs });
    }
    // Short wait: HOLD the process (no journal — a crash-restart simply re-holds). Snapshot the
    // persistent workspace first so a crash during the hold can restore it. An abort mid-hold rejects.
    if (this.deps.onBeforeSleep !== undefined) await this.deps.onBeforeSleep();
    await this.sleeper.hold(holdMs, this.deps.signal);
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
