// SPDX-License-Identifier: Apache-2.0

// buildContextData — construct the `context` half of the host protocol's `bootstrap` payload
// (P3.3 of the workflow-format redesign) from the claimed run row.
//
// The SDK's `contextDataSchema` is the wire shape (camelCase top-level, snake_case inside
// `actor`); the client builds the live frozen `Context` from it, synthesizing `signal` from the
// host's `cancel` notification. This module is PURE — the claim payload delivers
// `workflowVersion` (the sequential int), `environment {id, name} | null`, and `run.attempt`
// (P3.7, backend `d173e8f5`); each keeps an honest, LOGGED fallback for an older backend whose
// claim predates the field (version-skew tolerance, not a design gap):
//
//   - `workflowVersion` absent/null → 1 + a warning.
//   - `environment` absent → `null` + a warning (a PRESENT `null` is the real org-base value —
//     no warning).
//   - `run.attempt` absent → 1 + a warning (`dispatch_attempts` is a different thing).
//   - `trigger.firedAt` — approximated by the run row's `createdAt` (when the platform created
//     the run IS when it fired it, for every current trigger path).

import type { ContextData } from "@boardwalk-labs/workflow/runtime";
import { createLogger } from "./support/index.js";
import type { Run, RunActor } from "./wire/run.js";

const log = createLogger("RunContext");

/** `trigger.kind` is the TRANSPORT (the two-axis rule): cron timer, webhook delivery, or a
 *  direct invocation = `manual`. Anything unrecognized maps to `manual` with a warning — the
 *  actor still says who fired it. */
function triggerKind(run: Run): "cron" | "webhook" | "manual" {
  const kind = run.triggerKind;
  if (kind === "cron" || kind === "webhook" || kind === "manual") return kind;
  log.warn("context_trigger_kind_unrecognized", { runId: run.id, triggerKind: kind });
  return "manual";
}

/** The runner's wire `RunActor` mirrors the backend's `runActorSchema`, which is exactly the
 *  SDK's `actorSchema` — an identity mapping, typed as such so a drift breaks the build. */
function toActor(actor: RunActor): ContextData["actor"] {
  return actor;
}

/** A trigger-specific `source` when the actor names one (webhook source / cron rule /
 *  event subscription), else absent. */
function triggerSource(actor: RunActor): string | undefined {
  switch (actor.type) {
    case "webhook":
      return actor.source;
    case "cron":
      return actor.rule;
    case "event":
      return actor.subscription_id;
    default:
      return undefined;
  }
}

/** The claim-payload siblings of the run row that feed `context` (P3.7). Fields are optional so
 *  an older backend's claim (predating them) degrades to the logged fallbacks. */
export interface ClaimContextExtras {
  workflowVersion?: number | null;
  environment?: { id: string; name: string } | null;
}

/** Build the bootstrap `context` data for a claimed run. Pure; fallbacks are logged, never thrown. */
export function buildContextData(
  run: Run,
  workspaceRoot: string,
  extras: ClaimContextExtras = {},
): ContextData {
  let workflowVersion = extras.workflowVersion ?? null;
  if (workflowVersion === null) {
    // Older backend (field absent) or a backend integrity anomaly (explicit null) — fall back.
    log.warn("context_workflow_version_unavailable", {
      runId: run.id,
      workflowVersionId: run.workflowVersionId,
    });
    workflowVersion = 1;
  }
  let environment: { id: string; name: string } | null;
  if (extras.environment !== undefined) {
    environment = extras.environment; // null here is the REAL org-base value.
  } else {
    environment = null;
    if (run.environmentId !== null) {
      // Older backend: an environment was selected but the claim carries no name.
      log.warn("context_environment_name_unavailable", {
        runId: run.id,
        environmentId: run.environmentId,
      });
    }
  }
  if (run.attempt === undefined) {
    log.warn("context_attempt_unavailable", { runId: run.id });
  }
  const source = triggerSource(run.actor);
  return {
    runId: run.id,
    workflowId: run.workflowId,
    workflowVersion,
    orgId: run.orgId,
    environment,
    actor: toActor(run.actor),
    attempt: run.attempt ?? 1,
    trigger: {
      kind: triggerKind(run),
      firedAt: run.createdAt,
      ...(source !== undefined ? { source } : {}),
    },
    workspaceDir: workspaceRoot,
  };
}
