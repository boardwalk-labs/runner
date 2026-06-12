// The Boardwalk runner contract — the canonical payload types between a runner (hosted or
// self-hosted) and the Boardwalk control plane: registration, assignment, claim/lease,
// heartbeat, and terminal status. Published from this repo (CONTRACT.md is the prose half);
// the control plane implements the same schemas.
//
// DRAFT until the first tagged release: breaking changes are allowed while the Cloud
// implementation lands. After that, this file versions with the package, semver-strictly.
//
// Security invariants encoded here (see CONTRACT.md §security):
//   - An assignment's ONLY credential is `control_plane.run_token` — short-lived and bound to
//     this run + lease. There is no field for org-wide or platform credentials, by design.
//   - Secrets are NOT in the assignment. The runner resolves them per run through the control
//     plane API with the run token, fail-closed against the manifest.
//   - Program bytes are NOT inlined. The runner fetches the content-addressed artifact via the
//     control plane and MUST verify `program.digest` before extraction.
//
// Schema rules (same discipline as @boardwalk/workflow): strict objects — unknown fields are
// validation errors; union members most-specific-first; types derive from schemas, never
// hand-written.

import { z } from "zod";

// ============================================================================
// Shared scalars
// ============================================================================

const id = z.string().min(1).max(128);
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase sha256 hex digest");
/** Epoch milliseconds. */
const epochMs = z.number().int().nonnegative();

export const runnerOsSchema = z.enum(["linux", "macos", "windows"]);
export const runnerArchSchema = z.enum(["x64", "arm64"]);

// ============================================================================
// Registration — a machine joins a pool
// ============================================================================

/**
 * POST /runners/register, authenticated by a short-lived registration token minted in the
 * dashboard. The registration token is single-purpose: it can register, nothing else.
 */
export const runnerRegistrationRequestSchema = z.strictObject({
  registration_token: z.string().min(1),
  /** The pool this machine serves; `runs_on: { kind: "self-hosted", pool }` matches against it. */
  pool: z.string().min(1).max(120),
  /** Human-readable machine name (shown in the dashboard). */
  name: z.string().min(1).max(120),
  /** Extra labels advertised for `runs_on.labels` matching. */
  labels: z.array(z.string().min(1).max(120)).max(32).default([]),
  os: runnerOsSchema,
  arch: runnerArchSchema,
  /** The runner client's own version (for deprecation + compatibility messaging). */
  runner_version: z.string().min(1).max(64),
});
export type RunnerRegistrationRequest = z.infer<typeof runnerRegistrationRequestSchema>;

export const runnerRegistrationResponseSchema = z.strictObject({
  runner_id: id,
  /**
   * The runner's standing identity credential: it can poll for assignments, claim, heartbeat,
   * and deregister — and nothing else. Per-run capability comes only from an assignment's
   * run token.
   */
  runner_token: z.string().min(1),
  poll: z.strictObject({
    url: z.string().url(),
    /** Suggested poll cadence when no long-poll/socket is held. */
    interval_seconds: z.number().int().positive().max(300),
  }),
});
export type RunnerRegistrationResponse = z.infer<typeof runnerRegistrationResponseSchema>;

// ============================================================================
// Assignment — one run, offered to a runner
// ============================================================================

/** The matched `runs_on` selector, echoed so the runner can re-verify it should run this. */
export const assignmentRunsOnSchema = z.union([
  z.strictObject({
    kind: z.literal("self-hosted"),
    pool: z.string().min(1).max(120),
    labels: z.array(z.string().min(1).max(120)).optional(),
  }),
  // Hosted labels (the hosted worker speaks the same contract).
  z.string().min(1).max(120),
]);

export const workspaceStoreKindSchema = z.enum(["managed", "local", "custom"]);

export const runnerAssignmentSchema = z.strictObject({
  assignment_id: id,
  run_id: id,
  org_id: id,
  workflow_id: id,
  workflow_version_id: id,
  /**
   * The workflow manifest snapshot for this version. Shape is owned by @boardwalk/workflow's
   * `workflowManifestSchema`; carried opaquely here so the contract package doesn't pin the
   * SDK. Runners validate it with the SDK schema before honoring any grant in it.
   */
  manifest: z.record(z.string(), z.unknown()),
  /** The trigger payload (becomes the program's `input`). */
  input: z.unknown(),
  /**
   * The workflow PROGRAM — always a built JS artifact, never raw source. Bytes are fetched
   * via the control plane (content-addressed); `digest` MUST be verified before extraction.
   * The runner never transpiles and never installs dependencies.
   */
  program: z.strictObject({
    digest: sha256Hex,
    /** Module to import after extraction, e.g. `index.mjs`. Importing it IS running it. */
    entry: z.string().min(1).max(256),
    /** The @boardwalk/workflow version range the artifact was built against (layer compat). */
    sdk_version: z.string().min(1).max(64),
  }),
  runs_on: assignmentRunsOnSchema,
  /**
   * The runner's ONLY Boardwalk credential: everything privileged (program fetch, secret
   * resolution, event/log streaming, artifact upload, child-run calls, status + usage
   * submission) is a call to this API with this token, authorized per call against the bound
   * run + manifest.
   */
  control_plane: z.strictObject({
    base_url: z.string().url(),
    run_token: z.string().min(1),
  }),
  workspace: z.strictObject({
    /** The run's working directory (also HOME + cwd), e.g. `/workspace`. */
    path: z.string().min(1).max(256),
    /** Ephemeral scratch, cleared per run. */
    tmp_path: z.string().min(1).max(256),
    /** Local teardown always happens; persistence survives via the store. */
    cleanup: z.literal("always"),
    /** Whether declared persistent paths are hydrated/persisted for this run. */
    persist: z.boolean(),
    store: z.strictObject({ kind: workspaceStoreKindSchema }),
  }),
  limits: z.strictObject({
    timeout_seconds: z.number().int().positive(),
    memory_mb: z.number().int().positive(),
    cpu_units: z.number().int().positive().optional(),
  }),
  /** Run-permission grants; shape owned by @boardwalk/workflow (carried opaquely, like manifest). */
  permissions: z.record(z.string(), z.unknown()).optional(),
  /** Present iff the manifest grants an identity token. */
  oidc: z
    .strictObject({
      request_url: z.string().url(),
      request_token: z.string().min(1),
    })
    .optional(),
  /** Where this run's artifacts land (uploads themselves go through the control plane). */
  artifacts: z.strictObject({
    prefix: z.string().min(1).max(512),
  }),
  /** Run-event stream coordinates (wire format owned by @boardwalk/workflow). */
  log_stream: z.strictObject({
    channel: z.string().min(1).max(256),
    cursor_start: z.number().int().nonnegative(),
  }),
});
export type RunnerAssignment = z.infer<typeof runnerAssignmentSchema>;

/** GET/long-poll for work: at most one assignment per response. */
export const assignmentPollResponseSchema = z.strictObject({
  assignment: runnerAssignmentSchema.nullable(),
});
export type AssignmentPollResponse = z.infer<typeof assignmentPollResponseSchema>;

// ============================================================================
// Claim — lease before work
// ============================================================================

export const claimRequestSchema = z.strictObject({
  runner_id: id,
  assignment_id: id,
});
export type ClaimRequest = z.infer<typeof claimRequestSchema>;

export const claimResponseSchema = z.strictObject({
  lease_id: id,
  run_id: id,
  /** Heartbeat before this or the lease expires and the run is recovered elsewhere. */
  lease_expires_at: epochMs,
});
export type ClaimResponse = z.infer<typeof claimResponseSchema>;

// ============================================================================
// Heartbeat — keep the lease, receive control signals
// ============================================================================

export const heartbeatPhaseSchema = z.enum(["preparing", "running", "finalizing"]);

export const heartbeatRequestSchema = z.strictObject({
  runner_id: id,
  lease_id: id,
  run_id: id,
  phase: heartbeatPhaseSchema,
});
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;

/**
 * The heartbeat response is the control channel: cancellation and drain arrive HERE (a
 * brokered poll), never as an inbound connection to the runner.
 */
export const heartbeatResponseSchema = z.strictObject({
  lease_expires_at: epochMs,
  /**
   * `continue` — keep going. `cancel` — stop the run now; report `cancelled`.
   * `drain` — finish the current run, then claim nothing further (deregistration/update flow).
   */
  action: z.enum(["continue", "cancel", "drain"]),
});
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

// ============================================================================
// Terminal status — the runner's last word on a run
// ============================================================================

export const statusReportSchema = z.strictObject({
  runner_id: id,
  lease_id: id,
  run_id: id,
  status: z.enum(["completed", "failed", "cancelled"]),
  /** Present on `failed`. Never contains secret material — runners redact before reporting. */
  error: z
    .strictObject({
      code: z.string().min(1).max(120),
      message: z.string().max(10_000),
    })
    .optional(),
  usage: z
    .strictObject({
      runtime_seconds: z.number().int().nonnegative(),
    })
    .optional(),
});
export type StatusReport = z.infer<typeof statusReportSchema>;

// ============================================================================
// Validation helper
// ============================================================================

/** Thrown when a contract payload fails validation. */
export class ContractValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractValidationError";
  }
}

/** Parse with a readable multi-issue error (the schemas are strict — unknown fields fail). */
export function parseContract<T>(schema: z.ZodType<T>, payload: unknown, what: string): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("\n");
    throw new ContractValidationError(`Invalid ${what}:\n${issues}`);
  }
  return result.data;
}
