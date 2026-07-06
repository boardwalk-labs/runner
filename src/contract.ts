// SPDX-License-Identifier: Apache-2.0

// The Boardwalk runner contract — the canonical payload types between a self-hosted runner
// machine and the Boardwalk control plane: registration, the assignment offer, claim/lease,
// and heartbeat. Published from this repo (CONTRACT.md is the prose half); the control plane
// implements the same schemas.
//
// DRAFT until the first tagged release: breaking changes are allowed while the platform
// implementation lands. After that, this file versions with the package, semver-strictly.
//
// Shape of the protocol (revised 2026-07 — credentials moved to CLAIM):
//   - The POLLED OFFER is credential-free: identity + selector only. A queued assignment
//     never carries a token that could age out or leak before any runner commits.
//   - The CLAIM RESPONSE is the only place per-run credentials exist: the run token, the run
//     API token, the resolved non-secret env, and the org's BYO inference provider registry.
//   - Everything else about the run (manifest, program artifact + digest, workspace, artifact
//     prefixes, event stream) is fetched AFTER claim through the run-token'd Runner Control
//     API — the same broker surface a Boardwalk-hosted worker uses. One contract, hosted and
//     self-hosted.
//
// Security invariants encoded here (see CONTRACT.md §security):
//   - The registration token registers, nothing else; the standing runner token can only
//     poll/claim/heartbeat/deregister; org reach exists only in a claim's run token.
//   - Secrets are NOT in any payload here. They resolve per run through the control plane
//     with the run token, fail-closed. A BYO provider entry names its auth secret; it never
//     carries the value.
//
// Schema rules (same discipline as @boardwalk-labs/workflow): strict objects — unknown fields are
// validation errors; union members most-specific-first; types derive from schemas, never
// hand-written.

import { z } from "zod";

// ============================================================================
// Shared scalars
// ============================================================================

const id = z.string().min(1).max(128);
/** Epoch milliseconds. */
const epochMs = z.number().int().nonnegative();

export const runnerOsSchema = z.enum(["linux", "macos", "windows"]);
export const runnerArchSchema = z.enum(["x64", "arm64"]);

// ============================================================================
// Registration — a machine joins a pool
// ============================================================================

/**
 * POST /runner/v1/register, authenticated by the short-lived registration token in the body —
 * the token IS the credential (single-purpose: it can register, nothing else) and it is BOUND
 * to a pool at mint, so the request names no pool.
 */
export const runnerRegistrationRequestSchema = z.strictObject({
  registration_token: z.string().min(1),
  /** Human-readable machine name (shown in the dashboard). */
  name: z.string().min(1).max(120),
  /** Extra labels advertised for `runs_on.labels` matching. */
  labels: z.array(z.string().min(1).max(120)).max(32).default([]),
  os: runnerOsSchema.optional(),
  arch: runnerArchSchema.optional(),
  /** The runner client's own version (for deprecation + compatibility messaging). */
  runner_version: z.string().min(1).max(64).optional(),
});
export type RunnerRegistrationRequest = z.infer<typeof runnerRegistrationRequestSchema>;

export const runnerRegistrationResponseSchema = z.strictObject({
  runner_id: id,
  /**
   * The runner's standing identity credential: it can poll for assignments, claim, heartbeat,
   * and deregister — and nothing else. Per-run capability comes only from a claim's run token.
   */
  runner_token: z.string().min(1),
  poll: z.strictObject({
    url: z.string().url(),
    /** Suggested poll cadence when no long-poll is held. */
    interval_seconds: z.number().int().positive().max(300),
  }),
});
export type RunnerRegistrationResponse = z.infer<typeof runnerRegistrationResponseSchema>;

// ============================================================================
// Assignment offer — one run, offered to the pool
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

/**
 * A polled offer is CREDENTIAL-FREE by design: identity + selector only. Committing to it
 * (claim) is what mints credentials; the run's full context (manifest, program, workspace)
 * is fetched after claim through the run-token'd Runner Control API.
 */
export const assignmentOfferSchema = z.strictObject({
  assignment_id: id,
  run_id: id,
  org_id: id,
  runs_on: assignmentRunsOnSchema,
  queued_at: epochMs,
});
export type AssignmentOffer = z.infer<typeof assignmentOfferSchema>;

/**
 * Long-poll response: at most one offer. `action: "drain"` tells an idle runner to stop
 * claiming (deregistration/update flow) — control signals are always brokered polls, never
 * inbound connections to the runner.
 */
export const assignmentPollResponseSchema = z.strictObject({
  assignment: assignmentOfferSchema.nullable(),
  action: z.literal("drain").optional(),
});
export type AssignmentPollResponse = z.infer<typeof assignmentPollResponseSchema>;

// ============================================================================
// Claim — lease before work; credentials arrive HERE
// ============================================================================

/**
 * One BYO inference provider, as data: the runtime calls the endpoint directly (managed-lane
 * inference stays brokered; managed providers are never listed). The auth secret resolves by
 * NAME through the control plane with the run token — the value never rides this payload.
 */
export const byoInferenceProviderSchema = z.strictObject({
  name: z.string().min(1).max(120),
  /** Adapter kind, e.g. `openai_compatible`, `anthropic`, `bedrock`, `google`. */
  source: z.string().min(1).max(64),
  base_url: z.string().nullable(),
  auth_secret_name: z.string().nullable(),
});
export type ByoInferenceProvider = z.infer<typeof byoInferenceProviderSchema>;

/**
 * POST .../assignments/{assignment_id}/claim (runner-token authed; the bearer identifies the
 * runner, the URL the assignment — no body). First claim wins; a loser gets a conflict and
 * polls again. The response is the ONLY payload carrying per-run credentials.
 */
export const claimResponseSchema = z.strictObject({
  lease_id: id,
  run_id: id,
  /** Heartbeat before this or the lease expires and the run is recovered elsewhere. */
  lease_expires_at: epochMs,
  /**
   * The runner's ONLY org-reaching credentials, minted at claim and bound to this run:
   * `run_token` authenticates every Runner Control API call; `api_token` is the run's
   * auto-injected BOARDWALK_API_KEY (public-API machine principal, manifest-derived scopes).
   */
  control_plane: z.strictObject({
    base_url: z.string().url(),
    run_token: z.string().min(1),
    api_token: z.string().min(1),
  }),
  /** The run's resolved NON-secret env (manifest literals overlaid by org/environment
   *  variables). Secrets never ride here — they resolve through the control plane. */
  env: z.record(z.string(), z.string()),
  /** The org's BYO inference providers, for runner-direct model calls. */
  byo_providers: z.array(byoInferenceProviderSchema),
});
export type ClaimResponse = z.infer<typeof claimResponseSchema>;

// ============================================================================
// Heartbeat — keep the lease, receive control signals
// ============================================================================

export const heartbeatPhaseSchema = z.enum(["preparing", "running", "finalizing"]);

/** The bearer identifies the runner; the body names the held lease. */
export const heartbeatRequestSchema = z.strictObject({
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
   * `continue` — keep going. `cancel` — stop the run now (the broker records the terminal
   * state). `drain` — finish the current run, then claim nothing further.
   */
  action: z.enum(["continue", "cancel", "drain"]),
});
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

// ============================================================================
// Terminal status
// ============================================================================
// There is deliberately NO pool-level status report: the runner's last word on a run is the
// run-token'd `finalize` call on the Runner Control API — the same call a hosted worker makes.
// The control plane closes out the assignment (terminal status, runner back to idle) there.

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
