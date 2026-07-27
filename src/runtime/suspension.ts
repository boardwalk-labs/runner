// Suspension primitives for the JS-body worker (the snapshot-substrate model).
//
// A run SUSPENDS at a waiting seam — a long `sleep`, a `humanInput()` gate, or the in-leaf
// `human_input` tool — by freezing the WHOLE microVM: the freeze coordinator quiesces platform
// streams, the host snapshots memory, and the wake restores the literal heap, so the seam's
// `await` resolves in place. There is no journal and no replay — the heap is the durable unit.
//
// A runtime with NO freeze substrate (a self-hosted runner daemon, unit tests, the Fargate
// break-glass) HOLDS instead: the seam blocks the live process until its condition is met. One
// mechanism serves every non-snapshot surface; the run pays for the idle wait.
//
// This file holds the SHARED pieces the host + worker + broker client agree on: the suspend
// signal a seam raises (what the broker persists as the wake condition) and the human-input gate
// it carries.

import type { LeafCheckpoint } from "@boardwalk-labs/engine/core";
import type { RunEventBody } from "./agent/events.js";

/**
 * Sleeps at/above this boundary SUSPEND on the snapshot substrate (freeze the VM; the wake fires
 * when the sleep is due); shorter ones HOLD the process in-memory, where a snapshot round-trip
 * costs more than it saves. Without a freeze substrate every sleep holds, whatever its length.
 */
export const SUSPEND_THRESHOLD_MS = 30_000;

/**
 * Why a seam suspended the run. `budget` is the odd one out: it is NOT a seam the program called but
 * an involuntary park — the run hit its `max_usd` cap and is waiting for a person to approve more
 * spend (docs/SUSPEND_POLICY.md Decision 3). It still carries a `humanInput` gate (key `budget`), so
 * the control plane persists, surfaces, and answers it exactly like any other gate; only the reason
 * differs, which is what lets the UI say "budget" instead of "waiting on a human".
 */
export type SuspendReason = "human_input" | "sleep" | "workflow_call" | "budget";

/** A human-in-the-loop gate carried out of a suspending seam (program-level or the in-leaf tool). */
export interface HumanInputGate {
  /** The stable key the responder answers by (an author/derived key, or the model's tool-call id). */
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
  /** The suspension's within-run key (a monotonic per-run counter): it keys the HITL gate rows the
   *  wake joins answers from. Not a journal seq — there is no journal. */
  seq: number;
  /** Present for `reason: "human_input"` — the gate to register a request row for. */
  humanInput?: HumanInputGate;
  /** A tool-level gate's leaf transcript checkpoint. On the snapshot substrate the transcript
   *  rides in the frozen heap — this field is informational for the control plane, not a resume
   *  source. */
  leafCheckpoint?: LeafCheckpoint;
  /** Relative wait (ms) for `reason: "sleep"`; the broker computes the absolute wake time. */
  durationMs?: number;
  /** Absolute deadline (ms since epoch) for `reason: "sleep"`, stamped when the seam was
   *  REACHED. Authoritative over `durationMs`: a sleep that composed with other waits (or
   *  re-froze after an abort) must still land on its own deadline, not one rebased to whenever
   *  the freeze was finally requested. */
  wakeAtMs?: number;
  /** The child run id for `reason: "workflow_call"` — the parent suspends `waiting_for_child` and is
   *  woken when this child finalizes (the sweep wakes a parent whose child is terminal). */
  childRunId?: string;
}

/** The wire's three suspension reasons, which are what a READER of the run needs — narrower than the
 *  four a seam raises. A budget park maps onto `human_input` because that is literally what it waits
 *  for (a person raising the cap), and the enum is closed: a fourth value would make a strict
 *  consumer drop the frame entirely. */
const WIRE_REASON: Record<SuspendReason, "sleep" | "human_input" | "child"> = {
  sleep: "sleep",
  human_input: "human_input",
  budget: "human_input",
  workflow_call: "child",
};

/**
 * The `suspended` frame for a park, from the waits it froze on — PRIMARY FIRST (the coordinator
 * orders them by the same precedence the control plane derives the run's status from, so the frame
 * and the status pill agree on what the run is waiting for).
 *
 * `wakeAt` is the EARLIEST deadline in the whole set, not the primary's: with a gate and a sleep
 * composed, the sleep is when the run actually wakes, and a reader counting down wants that.
 */
export function suspendedEventBody(waits: readonly SuspendSignal[]): RunEventBody {
  const primary = waits[0];
  const deadlines = waits.flatMap((w) => {
    const at = w.reason === "sleep" ? w.wakeAtMs : w.humanInput?.expiresAt;
    return at === undefined ? [] : [at];
  });
  const wakeAt = deadlines.length === 0 ? undefined : Math.min(...deadlines);
  return {
    kind: "suspended",
    reason: primary === undefined ? "sleep" : WIRE_REASON[primary.reason],
    ...(wakeAt !== undefined ? { wakeAt } : {}),
  };
}

/** A monotonic per-run counter for suspension/gate keys (the `seq` on {@link SuspendSignal}). */
export class SuspensionCounter {
  private count = 0;

  next(): number {
    return ++this.count;
  }
}
