// SPDX-License-Identifier: Apache-2.0

// The runtime's view of a run — the fields the broker's claim/version responses carry, NOT the
// platform's DB row (the runtime never sees the database). Field names mirror the platform
// entity so the ported code reads identically; `RunActor` mirrors the platform's
// `runActorSchema` (domain/models/run_state.ts).

export type RunActor =
  | { type: "user"; user_id: string }
  | { type: "workflow"; parent_run_id: string; parent_workflow_id: string; user_id: string }
  | { type: "webhook"; source: string }
  | { type: "cron"; rule: string }
  | {
      type: "event";
      subscription_id: string;
      source_run_id: string;
      source_workflow_id: string;
      event_type: string;
      event_chain_depth: number;
    };

export interface Run {
  id: string;
  orgId: string;
  workflowId: string;
  workflowVersionId: string;
  environmentId: string | null;
  /** 1-based crash-restart-from-top counter (context.attempt). Optional: an older backend's
   *  claim payload may predate the column; the honest fallback is 1. */
  attempt?: number;
  parentRunId: string | null;
  actor: RunActor;
  triggerKind: string;
  triggerPayload: unknown;
  status: string;
  concurrencyKey: string | null;
  input: unknown;
  config: Record<string, unknown> | null;
  output: unknown;
  state: unknown;
  leaseUntil: number | null;
  workerId: string | null;
  nextWakeAt: number | null;
  waitingOnRunId: string | null;
  retriedFromRunId: string | null;
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  pendingSince: number | null;
  outcomeStatus: string | null;
  outcomeReasoning: string | null;
  tokensIn: number;
  tokensOut: number;
  runtimeSeconds: number;
  dispatchAttempts: number;
}
