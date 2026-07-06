import { AsyncLocalStorage } from "node:async_hooks";
import { AppError, ErrorCode } from "./support/index.js";
import type { PhaseOptions } from "@boardwalk-labs/workflow/runtime";
import type { TurnEventSink } from "./agent/events.js";

export type PhaseCloseStatus = "completed" | "failed" | "cancelled";

export interface PhaseTrackerOptions {
  /** The run's shared event emitter — phases ride the one ordered stream. */
  sink: TurnEventSink;
}

interface ActivePhase {
  id: string;
  name: string;
}

/**
 * Tracks the author-visible `phase("...")` marker for live run details. v1 wire semantics: a
 * `phase` event is a MARKER — everything after it belongs to that phase until the next marker or
 * run end (no phase_completed/failed events on the wire; consumers derive spans from positions).
 * This is observability only: it never checkpoints JS execution or replays/skips user code.
 */
export class PhaseTracker {
  private readonly sink: TurnEventSink;
  private readonly storage = new AsyncLocalStorage<string | null>();
  private readonly seenIds = new Set<string>();
  private current: ActivePhase | null = null;
  private seq = 0;

  constructor(opts: PhaseTrackerOptions) {
    this.sink = opts.sink;
  }

  set(name: string, opts: PhaseOptions | undefined): void {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, "Phase name must not be empty");
    }

    // Use the caller's id only when it's a non-empty string after trimming; an empty trim falls
    // back to a generated id (so `??` would be wrong here — it wouldn't catch `""`).
    const trimmedId = opts?.id?.trim();
    const id =
      trimmedId !== undefined && trimmedId !== "" ? trimmedId : `phase-${String(this.seq + 1)}`;
    if (this.seenIds.has(id)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, `Phase id already used: ${id}`);
    }

    this.seq += 1;
    this.seenIds.add(id);
    this.current = { id, name: trimmed };
    this.sink.emit({ kind: "phase", name: trimmed, id });
  }

  /** v1 phases are markers — nothing to emit at close; clear the current span. */
  close(_status: PhaseCloseStatus): void {
    this.current = null;
  }

  capture(): string | null {
    return this.current?.id ?? null;
  }

  runInPhase<T>(phaseId: string | null, fn: () => Promise<T>): Promise<T> {
    return this.storage.run(phaseId, fn);
  }
}
