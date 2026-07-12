// WorkerRunEventEmitter — the run's SINGLE event envelope counter, engine-parity
// (boardwalk-labs/boardwalk supervisor semantics):
//
//   * One shared `{turn, seq}` per run session. Every emit bumps `seq` (1-based);
//     `cursor = makeCursor(turn, seq)` is run-globally monotonic.
//   * `beginTurn(turnId)` opens a new agent stride block: `turn += 1`, `seq = 0`, then emits
//     the block's opening `turn_started` frame.
//   * Run-level frames (run_status / phase / output / program_output) carry `turnId = runId`
//     and ride the CURRENT block — there is no separate "program band", which is what keeps
//     cursors monotonic when program logs interleave with agent turns.
//   * Resume (crash-restart re-runs the program from the top): the claim response carries the
//     store's max cursor; the emitter starts in the NEXT stride block so new frames always
//     order after the previous session's.
//
// Frames publish as the stored row shape `{cursor, event}` (JSON) on `run:<id>` — the broker's
// telemetry endpoint fans out + appends verbatim. Publishing is best-effort (telemetry must
// never fail a run); the publisher (BrokerEventPublisher) batches.

import { makeCursor, TURN_CURSOR_STRIDE } from "./agent/events.js";
import type { RunEvent, RunEventBody, RedisPublisher } from "./agent/events.js";

export interface RunEventEmitterOptions {
  runId: string;
  publisher: RedisPublisher;
  /** The durable store's max cursor at claim (0 ⇒ fresh run). Restart resumes in the next block. */
  resumeAfterCursor?: number;
  /** Injected clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /** Optional local mirror of every (already-redacted) event — used to surface the run's output in an
   *  on-screen terminal in the ambient desktop (docs/SCREEN_CAPTURE.md). Best-effort: a sink throw never
   *  affects the run or the broker publish. Only fed events that already passed the run's redactor. */
  localSink?: (event: RunEvent) => void;
}

export class WorkerRunEventEmitter {
  private readonly runId: string;
  private readonly publisher: RedisPublisher;
  private readonly now: () => number;
  private readonly localSink: ((event: RunEvent) => void) | undefined;
  private turn: number;
  private seq: number;

  constructor(opts: RunEventEmitterOptions) {
    this.runId = opts.runId;
    this.publisher = opts.publisher;
    this.now = opts.now ?? Date.now;
    this.localSink = opts.localSink;
    const max = opts.resumeAfterCursor ?? 0;
    this.turn = max > 0 ? Math.floor(max / TURN_CURSOR_STRIDE) + 1 : 0;
    this.seq = 0;
  }

  /** Stamp + publish a run-level or agent frame. Agent frames pass their turnId. */
  emit(body: RunEventBody, turnId?: string): RunEvent {
    this.seq += 1;
    const event = {
      ...body,
      runId: this.runId,
      turnId: turnId ?? this.runId,
      seq: this.seq,
      t: this.now(),
    };
    const cursor = makeCursor(this.turn, this.seq);
    this.publisher
      .publish(`run:${this.runId}`, JSON.stringify({ cursor, event }))
      .catch(() => undefined); // best-effort; the publisher logs its own failures
    if (this.localSink !== undefined) {
      try {
        this.localSink(event); // best-effort on-screen mirror; must never affect the run
      } catch {
        /* ignore */
      }
    }
    return event;
  }

  /** Restart resume: jump past the previous session's frames (claim carries the store max). */
  resumeAfter(maxCursor: number): void {
    if (maxCursor > 0) {
      this.turn = Math.floor(maxCursor / TURN_CURSOR_STRIDE) + 1;
      this.seq = 0;
    }
  }

  /** Open a new agent stride block and emit its opening `turn_started` frame (built by the caller,
   *  which names the leaf). */
  beginTurn(turnId: string, started: RunEventBody): void {
    this.turn += 1;
    this.seq = 0;
    this.emit(started, turnId);
  }
}
