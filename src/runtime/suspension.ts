// Durable-suspension primitives for the JS-body worker (docs/SUSPENSION.md).
//
// A run SUSPENDS at a durable seam — a long `sleep`, a `humanInput()` gate, or the in-leaf
// `human_input` tool — by releasing its Fargate task and re-acquiring one on wake. The mechanism is
// a JOURNAL: every memoizable seam (`agent` / `step` / `humanInput` / `sleep`) is keyed by a
// synchronous monotonic `seq` and records its whole result, so a resumed run RESTARTS from the top
// and replays through the journal (a hit returns the memoized value instantly; we never replay an
// LLM turn — we memoize whole results, the `findChildCall` pattern generalized). This is NOT
// Temporal-style turn replay, so it does not violate the no-replay-engine rule (CLAUDE.md).
//
// This file holds the SHARED pieces the host + worker + broker client agree on: the suspend signal a
// seam raises, the journal seam the host reads/writes, the seq sequencer driving silent replay, and
// the determinism fingerprint. The behavior is conformance-pinned to the OSS engine's
// `src/run/child_host.ts` — the two runtimes must suspend + resume identically.

import { createHash } from "node:crypto";
import { z } from "zod";
import type { ChatMessage, LeafCheckpoint, LeafResume } from "@boardwalk-labs/engine/core";
import { AppError, ErrorCode } from "./support/index.js";

/**
 * Sleeps at/above this hold-vs-release boundary SUSPEND (release the task; a timer re-dispatches the
 * run when due); shorter ones HOLD the process in-memory, where a release + replay round-trip costs
 * more than it saves. Mirrors the engine's `SUSPEND_THRESHOLD_MS` so the two runtimes draw the line
 * in the same place.
 */
export const SUSPEND_THRESHOLD_MS = 30_000;

/** The durable-seam kinds the journal memoizes (mirrors `run_journal.kind` + the engine's IPC). */
export type JournalKind = "agent" | "step" | "human_input" | "sleep" | "workflow_call";

/** Why a seam suspended the run. */
export type SuspendReason = "human_input" | "sleep" | "workflow_call";

/** A human-in-the-loop gate carried out of a suspending seam (program-level or the in-leaf tool). */
export interface HumanInputGate {
  /** The stable key the responder answers by (an author/seq key, or the model's tool-call id). */
  key: string;
  prompt: string;
  /** The response form ({@link import("@boardwalk-labs/workflow").HumanInputSpec}); validated on submit. */
  inputSpec: unknown;
  /** RBAC scopes (`role:…`, `user:…`) allowed to respond; absent ⇒ any member with `run:respond`. */
  assignees?: string[];
  /** When the gate auto-expires (ms since epoch), for a `timeout`; absent ⇒ waits indefinitely. */
  expiresAt?: number;
  /** What to do on expiry (`"fail"` | `{ value }`) — the SDK's `onTimeout`; jsonb passthrough. */
  onTimeout?: unknown;
}

/** Everything the broker needs to persist a suspension + the wake condition. */
export interface SuspendSignal {
  reason: SuspendReason;
  /** The journal seq of the suspending seam. */
  seq: number;
  /** The seam's determinism fingerprint (recorded on the pending journal entry). */
  fingerprint: string;
  /** Present for `reason: "human_input"` — the gate to register a request row for. */
  humanInput?: HumanInputGate;
  /** A tool-level gate's leaf transcript checkpoint, stored so the leaf resumes where it paused. */
  leafCheckpoint?: LeafCheckpoint;
  /** Relative wait (ms) for `reason: "sleep"`; the broker computes the absolute wake time. */
  durationMs?: number;
  /** The child run id for `reason: "workflow_call"` — the parent suspends `waiting_for_child` and is
   *  woken when this child finalizes (the sweep wakes a parent whose child is terminal). */
  childRunId?: string;
}

/**
 * The control signal a host seam raises to suspend the run. Unlike the engine (a child process the
 * supervisor kills out-of-band), the backend worker runs the program IN-PROCESS, so a suspend is
 * surfaced by the host calling `onSuspend(signal)` and returning a NEVER-resolving promise; the
 * worker races that against the program body and tears down. This class exists so a seam that has no
 * `onSuspend` wired (the local/test path) can still raise a typed, catchable signal.
 */
export class SuspendError extends Error {
  readonly signal: SuspendSignal;
  constructor(signal: SuspendSignal) {
    super(`run suspended (${signal.reason}) at seam ${String(signal.seq)}`);
    this.name = "SuspendError";
    this.signal = signal;
  }
}

/** Journal-entry states (mirrors `run_journal.state` + the engine's IPC). */
export const JOURNAL_STATES = ["pending", "suspended", "resolved"] as const;
export type JournalEntryState = (typeof JOURNAL_STATES)[number];

/** A memoized journal entry, as the host reads it back on replay (mirrors the engine's IPC shape). */
export interface JournalLookup {
  seq: number;
  kind: JournalKind;
  fingerprint: string;
  /** `resolved` ⇒ `result` is the memoized value; `suspended` ⇒ a parked agent leaf (result is the
   *  {@link LeafResume} the host re-enters with); `pending` ⇒ awaiting an external event (re-suspend). */
  state: JournalEntryState;
  result: unknown;
}

/** Validate the broker's journal_get response (the worker's run token doesn't exempt the channel from
 *  validation). The result is genuinely heterogeneous JSON (an agent return / a LeafResume / a
 *  HumanInputResult), parsed per-kind downstream — so it stays `unknown` here, the validation seam. */
export const journalLookupSchema = z.object({
  seq: z.number().int().positive(),
  kind: z.enum(["agent", "step", "human_input", "sleep", "workflow_call"]),
  fingerprint: z.string(),
  state: z.enum(JOURNAL_STATES),
  result: z.unknown(),
});

/** The journal the host reads (replay lookup) + writes (resolved seam results). Backed by the broker
 *  over the run token on hosted runs; absent on the local/test path (no durable suspension). */
export interface JournalSeam {
  /** The memoized entry for a seam, or null on a replay miss. */
  get(seq: number): Promise<JournalLookup | null>;
  /** Record a RESOLVED seam result (idempotent on the run + seq; a resolved entry is immutable). */
  put(entry: {
    seq: number;
    kind: JournalKind;
    fingerprint: string;
    label: string;
    result: unknown;
  }): Promise<void>;
}

/**
 * The synchronous, monotonic durable-seam counter. Incremented at each journaled seam's ENTRY:
 * because a program's synchronous call order is deterministic (even under `Promise.all`, whose
 * `.map(...)` runs left-to-right synchronously), the same logical call gets the same `seq` on every
 * execution — the journal key that lets a resumed run return a memoized result.
 *
 * It also drives SILENT REPLAY: a resume starts suppressed (observability — console output, phase
 * markers — was already emitted last segment) and goes `live` the moment it reaches the suspending
 * seam (the frontier = the highest journaled seq). A fresh run (frontier 0) is live immediately.
 */
export class SeamSequencer {
  private count = 0;
  private liveFlag: boolean;

  constructor(private readonly replayFrontier = 0) {
    this.liveFlag = replayFrontier === 0;
  }

  next(): number {
    const seq = ++this.count;
    if (seq >= this.replayFrontier) this.liveFlag = true;
    return seq;
  }

  /** True once execution has crossed the replay frontier — output after this point is NEW. */
  get isLive(): boolean {
    return this.liveFlag;
  }

  /** True while re-running already-journaled seams on a resume (observability suppressed). */
  isReplaying(): boolean {
    return !this.liveFlag;
  }
}

/** The child run id a `workflow_call` seam journals while it waits (parsed back on resume). */
export const childRunIdSchema = z.string().min(1);

/** A stable content hash of a seam's salient args — the determinism check on replay. Identical
 *  construction to the engine's `seamFingerprint` so a journal written by one runtime validates in
 *  the other (the conformance promise). */
export function seamFingerprint(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** A seam reached on replay didn't match what the journal recorded at that seq — the workflow's code
 *  on the path to a suspend changed (a different prompt/model/step name, or a different seam kind).
 *  Fails the run loudly rather than returning a stale memoized result for the wrong call. */
export function determinismError(seq: number, got: JournalKind, recorded: JournalKind): AppError {
  const detail =
    got === recorded
      ? `the same "${got}" seam but with different arguments (a changed prompt, model, or step name)`
      : `a "${recorded}" call, but this execution reached a "${got}" call`;
  return new AppError(
    ErrorCode.VALIDATION_FAILED,
    `Nondeterministic replay at seam ${String(seq)}: the journal recorded ${detail}. A workflow's ` +
      `code on the path to a suspend/resume must be deterministic — route nondeterministic I/O ` +
      `through agent(), step.run(), or workflows.call so it is journaled.`,
    { kind: "nondeterministic_replay", seq },
  );
}

/**
 * The shape of a SUSPENDED agent leaf's journal result on resume: the transcript checkpoint plus the
 * answers the broker joined from the resolved request rows, keyed by tool-call id. `messages` is the
 * engine's own serialized transcript round-tripping through JSON — handed straight back to the leaf,
 * not re-validated field-by-field. Structurally a {@link LeafResume}.
 */
export const leafResumeSchema: z.ZodType<LeafResume> = z.object({
  checkpoint: z.object({
    messages: z.array(z.custom<ChatMessage>()),
    iteration: z.number().int(),
    totals: z.object({
      inputTokens: z.number().int(),
      outputTokens: z.number().int(),
    }),
  }),
  answers: z.record(z.string(), z.unknown()),
});
