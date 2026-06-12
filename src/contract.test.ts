import { describe, it, expect } from "vitest";
import {
  assignmentPollResponseSchema,
  claimRequestSchema,
  claimResponseSchema,
  ContractValidationError,
  heartbeatRequestSchema,
  heartbeatResponseSchema,
  parseContract,
  runnerAssignmentSchema,
  runnerRegistrationRequestSchema,
  runnerRegistrationResponseSchema,
  statusReportSchema,
} from "./contract.js";

const ASSIGNMENT = {
  assignment_id: "asg_1",
  run_id: "run_1",
  org_id: "org_1",
  workflow_id: "wf_1",
  workflow_version_id: "wfv_1",
  manifest: { name: "nightly", triggers: [{ kind: "cron", expr: "0 9 * * *" }] },
  input: { day: "monday" },
  program: {
    digest: "a".repeat(64),
    entry: "index.mjs",
    sdk_version: "^0.1.0",
  },
  runs_on: { kind: "self-hosted", pool: "gpu-pool", labels: ["cuda"] },
  control_plane: { base_url: "https://api.example.com/runner/v1", run_token: "rt_short_lived" },
  workspace: {
    path: "/workspace",
    tmp_path: "/tmp",
    cleanup: "always",
    persist: true,
    store: { kind: "managed" },
  },
  limits: { timeout_seconds: 3600, memory_mb: 4096, cpu_units: 2048 },
  permissions: { artifacts: "write" },
  oidc: { request_url: "https://api.example.com/runner/v1/oidc", request_token: "ot_1" },
  artifacts: { prefix: "orgs/org_1/runs/run_1" },
  log_stream: { channel: "runs/run_1/events", cursor_start: 0 },
} as const;

describe("runnerAssignmentSchema", () => {
  it("round-trips a full assignment (toEqual, not toBeDefined)", () => {
    expect(runnerAssignmentSchema.parse(ASSIGNMENT)).toEqual(ASSIGNMENT);
  });

  it("accepts a hosted-label runs_on and minimal optionals", () => {
    const hosted: Record<string, unknown> = { ...ASSIGNMENT, runs_on: "boardwalk/linux" };
    delete hosted.permissions;
    delete hosted.oidc;
    expect(runnerAssignmentSchema.parse(hosted)).toEqual(hosted);
  });

  it("rejects unknown fields (no silent credential smuggling)", () => {
    expect(() =>
      runnerAssignmentSchema.parse({ ...ASSIGNMENT, platform_credentials: { key: "x" } }),
    ).toThrow();
  });

  it("rejects a malformed program digest", () => {
    expect(() =>
      runnerAssignmentSchema.parse({
        ...ASSIGNMENT,
        program: { ...ASSIGNMENT.program, digest: "not-a-digest" },
      }),
    ).toThrow(/sha256/);
  });

  it("rejects a workspace cleanup other than 'always'", () => {
    expect(() =>
      runnerAssignmentSchema.parse({
        ...ASSIGNMENT,
        workspace: { ...ASSIGNMENT.workspace, cleanup: "never" },
      }),
    ).toThrow();
  });

  it("poll response carries one assignment or null", () => {
    expect(assignmentPollResponseSchema.parse({ assignment: null })).toEqual({
      assignment: null,
    });
    expect(assignmentPollResponseSchema.parse({ assignment: ASSIGNMENT })).toEqual({
      assignment: ASSIGNMENT,
    });
  });
});

describe("registration", () => {
  it("round-trips a request and applies the labels default", () => {
    const req = {
      registration_token: "reg_1",
      pool: "default",
      name: "build-box-3",
      os: "linux",
      arch: "arm64",
      runner_version: "0.1.0",
    };
    expect(runnerRegistrationRequestSchema.parse(req)).toEqual({ ...req, labels: [] });
  });

  it("round-trips a response", () => {
    const res = {
      runner_id: "rnr_1",
      runner_token: "rt_standing",
      poll: { url: "https://api.example.com/runner/v1/assignments", interval_seconds: 15 },
    };
    expect(runnerRegistrationResponseSchema.parse(res)).toEqual(res);
  });

  it("rejects an unknown os", () => {
    expect(() =>
      runnerRegistrationRequestSchema.parse({
        registration_token: "r",
        pool: "p",
        name: "n",
        os: "freebsd",
        arch: "x64",
        runner_version: "0.1.0",
      }),
    ).toThrow();
  });
});

describe("claim / heartbeat / status", () => {
  it("claim round-trips", () => {
    const req = { runner_id: "rnr_1", assignment_id: "asg_1" };
    expect(claimRequestSchema.parse(req)).toEqual(req);
    const res = { lease_id: "lease_1", run_id: "run_1", lease_expires_at: 1_750_000_000_000 };
    expect(claimResponseSchema.parse(res)).toEqual(res);
  });

  it("heartbeat carries the control signal back", () => {
    const req = { runner_id: "rnr_1", lease_id: "lease_1", run_id: "run_1", phase: "running" };
    expect(heartbeatRequestSchema.parse(req)).toEqual(req);
    for (const action of ["continue", "cancel", "drain"] as const) {
      const res = { lease_expires_at: 1, action };
      expect(heartbeatResponseSchema.parse(res)).toEqual(res);
    }
  });

  it("status report round-trips with and without error/usage", () => {
    const minimal = {
      runner_id: "rnr_1",
      lease_id: "lease_1",
      run_id: "run_1",
      status: "completed",
    };
    expect(statusReportSchema.parse(minimal)).toEqual(minimal);

    const failed = {
      ...minimal,
      status: "failed",
      error: { code: "PROGRAM_ERROR", message: "boom" },
      usage: { runtime_seconds: 42 },
    };
    expect(statusReportSchema.parse(failed)).toEqual(failed);
  });

  it("rejects a status outside the terminal set", () => {
    expect(() =>
      statusReportSchema.parse({
        runner_id: "r",
        lease_id: "l",
        run_id: "x",
        status: "running",
      }),
    ).toThrow();
  });
});

describe("parseContract", () => {
  it("returns the parsed value on success", () => {
    expect(
      parseContract(claimRequestSchema, { runner_id: "r", assignment_id: "a" }, "claim"),
    ).toEqual({ runner_id: "r", assignment_id: "a" });
  });

  it("throws ContractValidationError with per-field issues", () => {
    let caught: unknown;
    try {
      parseContract(claimRequestSchema, { runner_id: "" }, "claim request");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ContractValidationError);
    expect((caught as Error).message).toContain("claim request");
    expect((caught as Error).message).toContain("assignment_id");
  });
});
