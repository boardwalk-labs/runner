// WorkerWorkflowHost — the real WorkflowHost the worker installs onto @boardwalk-labs/workflow
// before running a program (docs/WORKFLOW_RUNTIME.md §3.8). The program's hooks delegate here:
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
 * structurally. Platform credentials are NEVER placed in `process.env` (docs/RUN_ENV_AND_CREDS.md):
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
   * Durable-suspension journal (docs/SUSPENSION.md): the host memoizes each `agent`/`step`/`sleep`/
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
  /** Synchronous durable-seam counter + silent-replay live flag (docs/SUSPENSION.md). */
  private readonly seq: SeamSequencer;
  /** Run context + on-demand public-API bearer the SDK `runtime` accessor reads off the host. */
  readonly runtime: RuntimeContext;

  constructor(private readonly deps: WorkerWorkflowHostDeps) {
    this.sleeper = deps.sleeper ?? new TimerSleepController();
    this.now = deps.now ?? Date.now;
    this.maxSleepMs = deps.maxSleepMs ?? MAX_SLEEP_MS;
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
   *  get a rejected promise on abort, not a sync throw. */
  private guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      throwIfAborted(this.deps.signal);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    const phases = this.deps.phases;
    if (phases === undefined) return fn();
    const phaseId = phases.capture();
    return phases.runInPhase(phaseId, fn);
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
      if (err instanceof LeafParked) {
        // The model paused for a person: suspend with the leaf's checkpoint + the gate.
        return this.suspend({
          reason: "human_input",
          seq,
          fingerprint,
          ...(err.checkpoint !== undefined ? { leafCheckpoint: err.checkpoint } : {}),
          humanInput: {
            key: err.request.toolCallId,
            prompt: err.request.prompt,
            inputSpec: err.request.inputSpec,
          },
        });
      }
      throw err;
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
    return this.suspend({
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
    });
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

  /** The `workflows.call` durable seam (docs/SUSPENSION.md): start the child once + memoize its
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
    // Still running → suspend (release the task); the child's finalize wakes us.
    return this.suspend({
      reason: "workflow_call",
      seq,
      fingerprint,
      childRunId: child.childRunId,
    });
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
    // Long wait: SUSPEND (release the task). The broker records the (resolved) sleep journal entry +
    // the wake time transactionally, so on wake this seam replays past it (the journal hit above).
    // Only when a journal is wired — without it there is no resume, so fall back to holding.
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
