// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import {
  assignmentOfferSchema,
  assignmentPollResponseSchema,
  byoInferenceProviderSchema,
  claimResponseSchema,
  ContractValidationError,
  heartbeatRequestSchema,
  heartbeatResponseSchema,
  parseContract,
  runnerRegistrationRequestSchema,
  runnerRegistrationResponseSchema,
} from "./contract.js";

const OFFER = {
  assignment_id: "01H_assignment",
  run_id: "01H_run",
  org_id: "01H_org",
  runs_on: { kind: "self-hosted", pool: "default", labels: ["gpu"] },
  queued_at: 1_700_000_000_000,
};

const CLAIM = {
  lease_id: "01H_assignment",
  run_id: "01H_run",
  workflow_id: "01H_workflow",
  environment_id: null,
  lease_expires_at: 1_700_000_300_000,
  control_plane: {
    base_url: "https://api.boardwalk.sh",
    run_token: "run-token",
    api_token: "api-token",
  },
  env: { REGION: "us-east-1" },
  byo_providers: [
    {
      name: "my-vllm",
      source: "openai_compatible",
      base_url: "http://10.0.0.5:8000",
      auth_secret_name: "VLLM_KEY",
    },
  ],
};

describe("registration", () => {
  it("round-trips a request and applies the labels default (no pool — the token binds it)", () => {
    const parsed = runnerRegistrationRequestSchema.parse({
      registration_token: "bwkreg_raw",
      name: "mac-mini-1",
      os: "macos",
      arch: "arm64",
      runner_version: "0.1.0",
    });
    expect(parsed.labels).toEqual([]);
    expect(parsed.name).toBe("mac-mini-1");
  });

  it("rejects a pool field (bound at token mint, not at registration)", () => {
    const res = runnerRegistrationRequestSchema.safeParse({
      registration_token: "t",
      name: "m",
      pool: "default",
    });
    expect(res.success).toBe(false);
  });

  it("round-trips a response", () => {
    const value = {
      runner_id: "01H_runner",
      pool: "default",
      runner_token: "bwkr_raw",
      poll: { url: "https://api.boardwalk.sh/runner/v1/pool/poll", interval_seconds: 5 },
    };
    expect(runnerRegistrationResponseSchema.parse(value)).toEqual(value);
  });

  it("rejects an unknown os", () => {
    const res = runnerRegistrationRequestSchema.safeParse({
      registration_token: "t",
      name: "m",
      os: "beos",
    });
    expect(res.success).toBe(false);
  });
});

describe("assignment offer + poll", () => {
  it("round-trips a credential-free offer (toEqual, not toBeDefined)", () => {
    expect(assignmentOfferSchema.parse(OFFER)).toEqual(OFFER);
  });

  it("rejects credential-shaped fields on the offer (no smuggling)", () => {
    const res = assignmentOfferSchema.safeParse({
      ...OFFER,
      control_plane: { base_url: "https://x", run_token: "t" },
    });
    expect(res.success).toBe(false);
  });

  it("accepts a hosted-label runs_on (the hosted worker speaks the same contract)", () => {
    const parsed = assignmentOfferSchema.parse({ ...OFFER, runs_on: "boardwalk/linux" });
    expect(parsed.runs_on).toBe("boardwalk/linux");
  });

  it("poll carries one offer, or null, or null + drain", () => {
    expect(assignmentPollResponseSchema.parse({ assignment: OFFER }).assignment).toEqual(OFFER);
    expect(assignmentPollResponseSchema.parse({ assignment: null })).toEqual({ assignment: null });
    expect(assignmentPollResponseSchema.parse({ assignment: null, action: "drain" }).action).toBe(
      "drain",
    );
  });
});

describe("claim", () => {
  it("round-trips — the ONLY payload carrying per-run credentials", () => {
    expect(claimResponseSchema.parse(CLAIM)).toEqual(CLAIM);
  });

  it("carries the run's persistence SCOPE — the daemon lays out its disk from it", () => {
    // (workflow, environment) keys a self-hosted runner's durable workspace exactly as it keys the
    // hosted S3 key (docs/WORKSPACE_PERSISTENCE.md I3/§4). The daemon needs it BEFORE the run starts,
    // because under container isolation the scope dir is a bind mount chosen at `docker run` time.
    const scoped = claimResponseSchema.parse({ ...CLAIM, environment_id: "01H_env" });
    expect(scoped.workflow_id).toBe("01H_workflow");
    expect(scoped.environment_id).toBe("01H_env");
    // A run with no environment is the BASE scope, not an error.
    expect(claimResponseSchema.parse(CLAIM).environment_id).toBeNull();
    // Absent entirely = an older control plane; the runner cannot key a scope it wasn't told.
    const withoutScope: Record<string, unknown> = { ...CLAIM };
    delete withoutScope.workflow_id;
    expect(claimResponseSchema.safeParse(withoutScope).success).toBe(false);
  });

  it("requires all three control-plane credentials", () => {
    const res = claimResponseSchema.safeParse({
      ...CLAIM,
      control_plane: { base_url: "https://x", run_token: "t" },
    });
    expect(res.success).toBe(false);
  });

  it("byo provider entries name the auth secret, never a value", () => {
    const res = byoInferenceProviderSchema.safeParse({
      name: "x",
      source: "anthropic",
      base_url: null,
      auth_secret_name: "KEY",
      api_key: "sk-smuggled",
    });
    expect(res.success).toBe(false);
  });
});

describe("heartbeat", () => {
  it("request names the lease; the bearer names the runner", () => {
    const value = { lease_id: "01H_assignment", run_id: "01H_run", phase: "running" };
    expect(heartbeatRequestSchema.parse(value)).toEqual(value);
  });

  it("rejects a runner_id field (identity is the bearer)", () => {
    const res = heartbeatRequestSchema.safeParse({
      runner_id: "01H_runner",
      lease_id: "01H_assignment",
      run_id: "01H_run",
      phase: "running",
    });
    expect(res.success).toBe(false);
  });

  it("response carries the control signal back", () => {
    for (const action of ["continue", "cancel", "drain"] as const) {
      expect(heartbeatResponseSchema.parse({ lease_expires_at: 1, action }).action).toBe(action);
    }
  });

  it("rejects an unknown phase", () => {
    const res = heartbeatRequestSchema.safeParse({
      lease_id: "a",
      run_id: "r",
      phase: "meditating",
    });
    expect(res.success).toBe(false);
  });
});

describe("parseContract", () => {
  it("returns the parsed value on success", () => {
    expect(parseContract(assignmentOfferSchema, OFFER, "offer")).toEqual(OFFER);
  });

  it("throws ContractValidationError with per-field issues", () => {
    expect(() => parseContract(assignmentOfferSchema, { assignment_id: 3 }, "offer")).toThrow(
      ContractValidationError,
    );
    try {
      parseContract(assignmentOfferSchema, { assignment_id: 3 }, "offer");
    } catch (err) {
      expect((err as Error).message).toContain("Invalid offer");
      expect((err as Error).message).toContain("assignment_id");
    }
  });
});
