// buildContextData tests — the run row → bootstrap `context` mapping (P3.3), including the
// honest fallbacks for the fields the claim payload does not deliver yet. The result must
// always satisfy the SDK's contextDataSchema (the client validates bootstrap strictly).

import { describe, it, expect } from "vitest";
import { contextDataSchema } from "@boardwalk-labs/workflow/runtime";
import { buildContextData } from "./run_context.js";
import type { Run, RunActor } from "./wire/run.js";

function run(over: Partial<Run> = {}): Run {
  const actor: RunActor = { type: "user", user_id: "01H_user" };
  return {
    id: "01H_run",
    orgId: "01H_org",
    workflowId: "01H_wf",
    workflowVersionId: "01H_ver",
    environmentId: null,
    parentRunId: null,
    actor,
    triggerKind: "manual",
    triggerPayload: null,
    status: "pending",
    concurrencyKey: null,
    input: null,
    config: null,
    output: null,
    state: null,
    leaseUntil: null,
    workerId: null,
    nextWakeAt: null,
    waitingOnRunId: null,
    retriedFromRunId: null,
    startedAt: null,
    completedAt: null,
    createdAt: 1_700_000_000_000,
    pendingSince: null,
    outcomeStatus: null,
    outcomeReasoning: null,
    tokensIn: 0,
    tokensOut: 0,
    runtimeSeconds: 0,
    dispatchAttempts: 0,
    ...over,
  };
}

describe("buildContextData", () => {
  it("builds a contextDataSchema-valid payload from a plain manual run", () => {
    const ctx = buildContextData(run(), "/workspace");
    expect(() => contextDataSchema.parse(ctx)).not.toThrow();
    expect(ctx).toMatchObject({
      runId: "01H_run",
      workflowId: "01H_wf",
      orgId: "01H_org",
      workspaceDir: "/workspace",
      trigger: { kind: "manual", firedAt: 1_700_000_000_000 },
      actor: { type: "user", user_id: "01H_user" },
    });
  });

  it("uses the honest fallbacks for claim-payload gaps (version 1, attempt 1, env null)", () => {
    const ctx = buildContextData(run({ environmentId: "01H_env" }), "/workspace");
    expect(ctx.workflowVersion).toBe(1); // sequential int not on the claim yet (backend follow-up)
    expect(ctx.attempt).toBe(1); // crash-restart counter column not on the claim yet
    expect(ctx.environment).toBeNull(); // id without a name cannot honestly become {id, name}
  });

  it("maps trigger kinds through, and unknown kinds to manual", () => {
    expect(buildContextData(run({ triggerKind: "cron" }), "/w").trigger.kind).toBe("cron");
    expect(buildContextData(run({ triggerKind: "webhook" }), "/w").trigger.kind).toBe("webhook");
    expect(buildContextData(run({ triggerKind: "mystery" }), "/w").trigger.kind).toBe("manual");
  });

  it("stamps a trigger source from the actor (webhook / cron / event)", () => {
    const webhook = buildContextData(
      run({ triggerKind: "webhook", actor: { type: "webhook", source: "wh_1" } }),
      "/w",
    );
    expect(webhook.trigger.source).toBe("wh_1");
    const cron = buildContextData(
      run({ triggerKind: "cron", actor: { type: "cron", rule: "sched_1" } }),
      "/w",
    );
    expect(cron.trigger.source).toBe("sched_1");
    const event = buildContextData(
      run({
        actor: {
          type: "event",
          subscription_id: "sub_1",
          source_run_id: "01H_src",
          source_workflow_id: "01H_srcwf",
          event_type: "run.completed",
          event_chain_depth: 1,
        },
      }),
      "/w",
    );
    expect(event.trigger.source).toBe("sub_1");
    expect(() => contextDataSchema.parse(event)).not.toThrow();
  });

  it("passes every actor variant through schema-valid (the backend mirror IS the SDK shape)", () => {
    const actors: RunActor[] = [
      { type: "user", user_id: "u" },
      { type: "workflow", parent_run_id: "r", parent_workflow_id: "w", user_id: "workflow:w" },
      { type: "webhook", source: "s" },
      { type: "cron", rule: "c" },
      {
        type: "event",
        subscription_id: "s",
        source_run_id: "r",
        source_workflow_id: "w",
        event_type: "t",
        event_chain_depth: 0,
      },
    ];
    for (const actor of actors) {
      const ctx = buildContextData(run({ actor }), "/w");
      expect(() => contextDataSchema.parse(ctx)).not.toThrow();
      expect(ctx.actor).toEqual(actor);
    }
  });
});
