// SPDX-License-Identifier: Apache-2.0

// buildContextData — construct the `context` half of the host protocol's `bootstrap` payload
// (P3.3 of the workflow-format redesign) from the claimed run row.
//
// The SDK's `contextDataSchema` is the wire shape (camelCase top-level, snake_case inside
// `actor`); the client builds the live frozen `Context` from it, synthesizing `signal` from the
// host's `cancel` notification. This module is PURE — it maps what the claim payload carries
// TODAY onto the frozen v1 field set, with honest fallbacks (logged) for the fields the payload
// does not yet deliver:
//
//   - `workflowVersion` — the claim carries only the version ULID, not the sequential int.
//     Fallback 1 + a warning; the backend must add the int to the claim/version payload.
//   - `environment` — the claim carries `environmentId` but no name, and the schema's shape is
//     `{id, name} | null`. Rather than fabricate a name, fall back to `null` + a warning; the
//     backend must deliver `{id, name}` on the claim.
//   - `attempt` — needs the net-new crash-restart counter column on `runs`; until the claim
//     carries it the honest fallback is 1 (`dispatch_attempts` is a different thing).
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

/** Build the bootstrap `context` data for a claimed run. Pure; fallbacks are logged, never thrown. */
export function buildContextData(run: Run, workspaceRoot: string): ContextData {
  // The claim payload has no sequential version int yet (only the version ULID) — backend gap.
  log.warn("context_workflow_version_unavailable", {
    runId: run.id,
    workflowVersionId: run.workflowVersionId,
  });
  if (run.environmentId !== null) {
    // The claim payload has no environment NAME yet; `{id, name} | null` can't be built honestly.
    log.warn("context_environment_name_unavailable", {
      runId: run.id,
      environmentId: run.environmentId,
    });
  }
  return {
    runId: run.id,
    workflowId: run.workflowId,
    workflowVersion: 1,
    orgId: run.orgId,
    environment: null,
    actor: toActor(run.actor),
    attempt: 1,
    trigger: {
      kind: triggerKind(run),
      firedAt: run.createdAt,
      ...(triggerSource(run.actor) !== undefined ? { source: triggerSource(run.actor) } : {}),
    },
    workspaceDir: workspaceRoot,
  };
}
