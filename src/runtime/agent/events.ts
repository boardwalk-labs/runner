// Run-event wire format — ADOPTED from the published SDK (flip item, 2026-06-12).
//
// The contract lives in `@boardwalk-labs/workflow` (`runEventSchema`, CHANNELS, cursors): one
// typed, ordered stream per run, identical in every engine. This module re-exports the SDK
// contract and defines the BODY shape producers build (the envelope — runId / turnId / seq / t —
// is stamped centrally by the worker's shared RunEventEmitter, which owns the run-global
// `cursor = turn * TURN_CURSOR_STRIDE + seq` counter exactly like the OSS engine's supervisor).

export {
  runEventSchema,
  CHANNELS,
  DEFAULT_CHANNELS,
  channelOf,
  matchesChannels,
  makeCursor,
  TURN_CURSOR_STRIDE,
  type RunEvent,
  type RunEventKind,
  type Channel,
  type EventEnvelope,
  type TokenUsage,
  type ToolReturn,
} from "@boardwalk-labs/workflow";

import type { RunEvent } from "@boardwalk-labs/workflow";

/** Error shape on `tool_call_error` and `turn_ended` (reason='error') — the SDK's event error. */
export interface AgentApiError {
  code: string;
  message: string;
}

/** Distributive omit that preserves the discriminated union. */
type BodyOf<E> = E extends RunEvent ? Omit<E, "runId" | "turnId" | "seq" | "t"> : never;

/**
 * A run event WITHOUT its envelope — what producers (the normalizer, the phase tracker, the log
 * capture) build. The shared emitter stamps the envelope + computes the cursor.
 */
export type RunEventBody = BodyOf<RunEvent>;

/** The published/stored row: the run-global cursor + the full enveloped event (engine parity). */
export interface RunEventRow {
  cursor: number;
  event: RunEvent;
}

/**
 * Minimal Redis publisher surface (publish only). We depend only on `publish` so tests inject a
 * fake without pulling in ioredis; production wires the broker telemetry publisher.
 */
export interface RedisPublisher {
  publish(channel: string, message: string): Promise<number>;
}

/**
 * The shared per-run emitter surface a turn stamps through (the worker's WorkerRunEventEmitter
 * satisfies it). `emit` stamps the envelope + cursor on a body and rides the current stride block;
 * `beginTurn` opens a new agent stride block, then emits its opening frame (the caller supplies
 * `turn_started`).
 */
export interface TurnEventSink {
  emit(body: RunEventBody, turnId?: string): RunEvent;
  beginTurn(turnId: string, started: RunEventBody): void;
}

/**
 * Identity of one agent() leaf — stamped on its `turn_started`/`turn_ended` frames so a stream
 * consumer can tell concurrent agents apart. `agentId` is stable + run-unique (worker-assigned);
 * `agentName` is the author's `AgentOptions.name`, present only when set. Mirrors the engine's
 * `AgentIdentity` shape so the platform's wire matches the self-hosted server.
 */
export interface AgentIdentity {
  agentId: string;
  agentName?: string;
}
