// SPDX-License-Identifier: Apache-2.0

// The conformance harness — a REAL control plane, faked.
//
// Why this exists: every unit test in src/ mocks the seam from one side. A daemon test mocks the
// client; a handler test mocks the request. Both sides can therefore be wrong *in agreement*, and
// on 2026-07-27 they were: the CLI declared no runner version at registration, the control plane
// gated poll on the version it had stored, and 566 CLI tests plus 897 runner tests passed while
// `boardwalk runner start` could not bring a single runner online.
//
// So this harness never mocks the client. It stands up an HTTP server, parses every request with
// the PUBLISHED contract schema, and answers with a payload it parses back through the same schema
// before sending. The real PoolClient talks to it over a real socket. A field one side invents, or
// one side forgets, is a test failure here rather than a 403 loop on someone's laptop.
//
// The control plane's OWN implementation is verified against these same schemas on its side (see
// the backend's runner-control contract test) — that is the other half of the pincer.

import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assignmentPollResponseSchema,
  claimResponseSchema,
  heartbeatRequestSchema,
  heartbeatResponseSchema,
  runnerRegistrationRequestSchema,
  runnerRegistrationResponseSchema,
  type AssignmentOffer,
  type ClaimResponse,
  type RunnerRegistrationRequest,
} from "../src/contract.js";
import type { RunProcessHandle } from "../src/daemon/daemon.js";

const cleanups: (() => void)[] = [];

/** Tear down everything a case created, newest first. Each file's afterEach. */
export function disposeConformance(): void {
  for (const fn of cleanups.splice(0).reverse()) fn();
}

export function makeWorkDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bw-runner-conformance-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** One request the fake control plane received, after schema validation. */
export interface RecordedCall {
  path: string;
  /** The bearer credential presented, or null when the request was unauthenticated. */
  auth: string | null;
  /** The parsed body. Typed `unknown` on purpose — cases narrow it with the contract schema. */
  body: unknown;
}

/**
 * A sleep that never exceeds `maxMs`, for driving the real daemon fast.
 *
 * NOT `() => Promise.resolve()`: the daemon's heartbeat loop is `for(;;) { await sleep(60s); … }`,
 * so a zero sleep turns it into a tight loop hammering a real socket — the run finishes but the
 * suite drowns. Capping keeps the ORDERING the daemon depends on (a 0ms run exit lands before a
 * 1ms heartbeat tick) while collapsing wall-clock.
 */
export function cappedSleep(maxMs: number): (ms: number) => Promise<void> {
  return (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, maxMs)));
}

export interface FakeControlPlaneOptions {
  /** Offers handed out at poll, in order. When exhausted, poll answers "nothing queued". */
  offers?: AssignmentOffer[];
  /** Answer `action: "drain"` once this many polls have been served (bounds an idle loop). */
  drainAfterPolls?: number;
  /** Reject poll with this status before doing anything else (the version/credential gates). */
  rejectPollWith?: { status: number; code: string; message: string };
  /** Answer the FIRST claim with 409 (another runner won the race). */
  claimConflictOnce?: boolean;
  /** Answer heartbeat with `drain`, or with 409 for a lost lease. */
  heartbeat?: { action: "continue" | "cancel" | "drain" } | "lease_lost";
  /** Reject registration with this status (e.g. a pool that does not exist). */
  rejectRegistrationWith?: { status: number; code: string; message: string };
}

export interface FakeControlPlane {
  baseUrl: string;
  /** Every validated request, in arrival order. */
  calls: RecordedCall[];
  /** Calls to one path — the usual assertion shortcut. */
  callsTo: (path: string) => RecordedCall[];
  /** The registration bodies received, typed. */
  registrations: RunnerRegistrationRequest[];
  close: () => Promise<void>;
}

const RUNNER_TOKEN = "bwkr_conformance_standing_token";

/** A contract-valid claim for an offer — the shape a real control plane mints AT CLAIM. */
export function claimFor(assignment: AssignmentOffer): ClaimResponse {
  return {
    lease_id: `lease_${assignment.assignment_id}`,
    run_id: assignment.run_id,
    workflow_id: "01H_workflow",
    environment_id: null,
    workspace_key: null,
    lease_expires_at: 4_000_000_000_000,
    control_plane: {
      base_url: "https://control-plane.invalid",
      run_token: "bwrt_conformance_run_token",
      api_token: "bwk_conformance_api_token",
    },
    env: { CONFORMANCE: "1" },
    byo_providers: [],
  };
}

/** A contract-valid offer. */
export function offer(assignmentId: string): AssignmentOffer {
  return {
    assignment_id: assignmentId,
    run_id: `run_${assignmentId}`,
    org_id: "01H_conformance_org",
    runs_on: { kind: "self-hosted", pool: "default", labels: [] },
    queued_at: 1_700_000_000_000,
  };
}

/**
 * Stand up the fake control plane. Every handler validates its request with the contract schema
 * and its response with the contract schema — a shape either side invents fails here.
 */
export async function startFakeControlPlane(
  opts: FakeControlPlaneOptions = {},
): Promise<FakeControlPlane> {
  const calls: RecordedCall[] = [];
  const registrations: RunnerRegistrationRequest[] = [];
  const pending = [...(opts.offers ?? [])];
  let claimsSeen = 0;
  let pollsServed = 0;

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      // A handler that throws must still ANSWER. Without this the socket stays open, the daemon's
      // fetch never settles, and a fixture typo surfaces as a 5-second timeout with no cause —
      // which is exactly how the first draft of this harness wasted a debugging pass.
      try {
        handle();
      } catch (err) {
        send(res, 500, {
          error: {
            code: "HARNESS_ERROR",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    });

    function handle(): void {
      const path = req.url ?? "";
      const authHeader = req.headers.authorization;
      const auth =
        typeof authHeader === "string" && authHeader.startsWith("Bearer ")
          ? authHeader.slice("Bearer ".length)
          : null;
      let body: unknown;
      try {
        body = raw === "" ? {} : JSON.parse(raw);
      } catch {
        return send(res, 400, { error: { code: "VALIDATION", message: "body is not JSON" } });
      }
      calls.push({ path, auth, body });

      if (path.endsWith("/runner/v1/register")) {
        if (opts.rejectRegistrationWith !== undefined) {
          const { status, code, message } = opts.rejectRegistrationWith;
          return send(res, status, { error: { code, message } });
        }
        // The registration token IS the credential here; a bearer token would be a protocol error.
        const parsed = runnerRegistrationRequestSchema.safeParse(body);
        if (!parsed.success) {
          return send(res, 400, {
            error: { code: "VALIDATION", message: parsed.error.message },
          });
        }
        registrations.push(parsed.data);
        return send(
          res,
          201,
          runnerRegistrationResponseSchema.parse({
            runner_id: "01H_conformance_runner",
            pool: "default",
            runner_token: RUNNER_TOKEN,
            poll: { url: `${baseUrl()}/runner/v1/pool/poll`, interval_seconds: 5 },
          }),
        );
      }

      // Everything below is authenticated by the STANDING runner token, never the registration one.
      if (auth !== RUNNER_TOKEN) {
        return send(res, 401, {
          error: { code: "UNAUTHORIZED", message: "Invalid runner token" },
        });
      }

      if (path.endsWith("/runner/v1/pool/poll")) {
        if (opts.rejectPollWith !== undefined) {
          const { status, code, message } = opts.rejectPollWith;
          return send(res, status, { error: { code, message } });
        }
        pollsServed += 1;
        const next = pending.shift();
        if (
          next === undefined &&
          opts.drainAfterPolls !== undefined &&
          pollsServed >= opts.drainAfterPolls
        ) {
          return send(
            res,
            200,
            assignmentPollResponseSchema.parse({ assignment: null, action: "drain" }),
          );
        }
        return send(
          res,
          200,
          assignmentPollResponseSchema.parse(
            next === undefined ? { assignment: null } : { assignment: next },
          ),
        );
      }

      if (path.includes("/runner/v1/pool/assignments/") && path.endsWith("/claim")) {
        claimsSeen += 1;
        if (opts.claimConflictOnce === true && claimsSeen === 1) {
          return send(res, 409, { error: { code: "CONFLICT", message: "already claimed" } });
        }
        const assignmentId = decodeURIComponent(
          path.slice(
            path.indexOf("/assignments/") + "/assignments/".length,
            path.length - "/claim".length,
          ),
        );
        return send(res, 200, claimResponseSchema.parse(claimFor(offer(assignmentId))));
      }

      if (path.endsWith("/runner/v1/pool/heartbeat")) {
        const parsed = heartbeatRequestSchema.safeParse(body);
        if (!parsed.success) {
          return send(res, 400, {
            error: { code: "VALIDATION", message: parsed.error.message },
          });
        }
        if (opts.heartbeat === "lease_lost") {
          return send(res, 409, { error: { code: "CONFLICT", message: "lease lost" } });
        }
        return send(
          res,
          200,
          heartbeatResponseSchema.parse({
            lease_expires_at: 4_000_000_000_000,
            action: opts.heartbeat?.action ?? "continue",
          }),
        );
      }

      if (path.endsWith("/runner/v1/pool/deregister")) return send(res, 204, null);

      return send(res, 404, { error: { code: "NOT_FOUND", message: path } });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const port = address.port;
  const baseUrl = (): string => `http://127.0.0.1:${String(port)}`;

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanups.push(() => void close());

  return {
    baseUrl: baseUrl(),
    calls,
    callsTo: (p: string) => calls.filter((c) => c.path.endsWith(p)),
    registrations,
    close,
  };
}

/** The standing token the fake control plane issues — for cases that build an identity by hand. */
export const CONFORMANCE_RUNNER_TOKEN = RUNNER_TOKEN;

/**
 * A run process that exits cleanly, recording the env it was handed. The spawner is an injected
 * seam by design, so conformance drives the REAL daemon loop without a real runtime binary.
 */
export function stubSpawner(opts: { exitCode?: number; holdMs?: number } = {}): {
  spawn: (a: { entry: string; env: Record<string, string>; cwd: string }) => RunProcessHandle;
  spawned: { entry: string; env: Record<string, string>; cwd: string }[];
} {
  const spawned: { entry: string; env: Record<string, string>; cwd: string }[] = [];
  return {
    spawned,
    spawn: (args) => {
      spawned.push(args);
      let killed = false;
      const exit = new Promise<number>((resolve) => {
        setTimeout(() => resolve(killed ? 143 : (opts.exitCode ?? 0)), opts.holdMs ?? 0);
      });
      return {
        wait: () => exit,
        kill: () => {
          killed = true;
        },
      };
    },
  };
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  if (body === null) {
    res.writeHead(status).end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" }).end(text);
}
