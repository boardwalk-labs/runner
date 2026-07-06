// SPDX-License-Identifier: Apache-2.0

// HTTP client for the control plane's pool-lease endpoints (runner/CONTRACT.md; the platform
// serves them at /runner/v1/register + /runner/v1/pool/*). Every response is validated against
// the published contract schemas — the daemon never trusts wire shapes.
//
// Corporate proxies: Node's fetch honors HTTPS_PROXY/https_proxy when the process starts with
// NODE_USE_ENV_PROXY=1 (the CLI/bin wrappers set it; see the README).

import {
  assignmentPollResponseSchema,
  claimResponseSchema,
  heartbeatResponseSchema,
  parseContract,
  runnerRegistrationResponseSchema,
  type AssignmentPollResponse,
  type ClaimResponse,
  type HeartbeatResponse,
  type RunnerRegistrationRequest,
  type RunnerRegistrationResponse,
} from "../contract.js";

export interface PoolClientConfig {
  /** Control-plane origin, e.g. https://api.boardwalk.sh */
  baseUrl: string;
  /** The standing `bwkr_…` credential (absent only for `register`). */
  runnerToken?: string;
  fetchImpl?: typeof fetch;
}

export class PoolClientError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string,
    message: string,
  ) {
    super(`${operation} failed (${String(status)}): ${message}`);
    this.name = "PoolClientError";
  }
}

async function errorBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}

export class PoolClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: PoolClientConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private url(path: string): string {
    return `${this.cfg.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private headers(): Record<string, string> {
    const token = this.cfg.runnerToken;
    if (token === undefined) throw new Error("PoolClient has no runner token");
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  /** Redeem a registration token (unauthenticated: the token in the body IS the credential). */
  async register(request: RunnerRegistrationRequest): Promise<RunnerRegistrationResponse> {
    const res = await this.fetchImpl(this.url("/runner/v1/register"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (res.status !== 201) {
      throw new PoolClientError(res.status, "register", await errorBody(res));
    }
    return parseContract(
      runnerRegistrationResponseSchema,
      await res.json(),
      "registration response",
    );
  }

  /** Long-poll for ONE credential-free offer (the server holds ~22s). */
  async poll(): Promise<AssignmentPollResponse> {
    const res = await this.fetchImpl(this.url("/runner/v1/pool/poll"), {
      method: "POST",
      headers: this.headers(),
      body: "{}",
    });
    if (res.status !== 200) throw new PoolClientError(res.status, "poll", await errorBody(res));
    return parseContract(assignmentPollResponseSchema, await res.json(), "poll response");
  }

  /** Race-safe claim. Null on 409 — another runner won; go back to polling. */
  async claim(assignmentId: string): Promise<ClaimResponse | null> {
    const res = await this.fetchImpl(
      this.url(`/runner/v1/pool/assignments/${encodeURIComponent(assignmentId)}/claim`),
      { method: "POST", headers: this.headers(), body: "{}" },
    );
    if (res.status === 409) return null;
    if (res.status !== 200) throw new PoolClientError(res.status, "claim", await errorBody(res));
    return parseContract(claimResponseSchema, await res.json(), "claim response");
  }

  /** Extend the assignment lease + receive the control signal. Null on 409 — lease lost:
   *  the control plane recovered the assignment; discard local state. */
  async heartbeat(
    leaseId: string,
    runId: string,
    phase: "preparing" | "running" | "finalizing",
  ): Promise<HeartbeatResponse | null> {
    const res = await this.fetchImpl(this.url("/runner/v1/pool/heartbeat"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ lease_id: leaseId, run_id: runId, phase }),
    });
    if (res.status === 409) return null;
    if (res.status !== 200) {
      throw new PoolClientError(res.status, "heartbeat", await errorBody(res));
    }
    return parseContract(heartbeatResponseSchema, await res.json(), "heartbeat response");
  }

  /** Permanent removal (decommissioning this machine). */
  async deregister(): Promise<void> {
    const res = await this.fetchImpl(this.url("/runner/v1/pool/deregister"), {
      method: "POST",
      headers: this.headers(),
      body: "{}",
    });
    if (res.status !== 204 && res.status !== 200) {
      throw new PoolClientError(res.status, "deregister", await errorBody(res));
    }
  }
}
