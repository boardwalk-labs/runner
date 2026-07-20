// RunnerControlClient — the worker's HTTP client for the Runner Control API (the Runner Credential Broker model).
//
// Under the broker model the worker reaches run lifecycle through the api-server, not the DB directly:
// it presents its per-run token (BOARDWALK_RUN_TOKEN) as a bearer credential and calls the broker for
// claim / finalize / version. The client is bound to ONE run (the token is too), so every call targets
// `…/runner/v1/runs/<runId>/…`.
//
// Thin + injectable (fetch is overridable) so it's unit-tested without a live server. Status mapping
// mirrors the broker handlers: claim 409 ⇒ "claim lost" (null), version 404 ⇒ missing (null); any
// other non-success status throws so the worker fails loud (→ restart, lease reclaimed). TRANSIENT
// failures (thrown network errors, LB 502/503/504 — a control-plane deploy rollover) are retried
// with backoff first, so a blip heals in place instead of crashing the run.

import { createLogger } from "./support/index.js";
import type { McpTokenResult } from "@boardwalk-labs/engine/core";
import type { Run } from "./wire/run.js";
import type { WebSearchOutput } from "./tools/web_search.js";
import type {
  ArtifactCommitInput,
  ArtifactPresignInput,
  ArtifactPresignResult,
  ArtifactSignResult,
  ArtifactSummary,
  ArtifactWriteInput,
  ArtifactWriteResult,
} from "./tools/artifacts.js";
import {
  INFERENCE_NDJSON_CONTENT_TYPE,
  parseInferenceFrame,
  serializeInferenceRequest,
  type InferenceFrame,
  type InferenceProxyRequest,
} from "./wire/inference_proxy.js";

const log = createLogger("RunnerControlClient");

export interface RunnerControlClientConfig {
  /** Base URL of the Runner Control API (BOARDWALK_CONTROL_PLANE_URL). */
  baseUrl: string;
  /** The per-run bearer token (BOARDWALK_RUN_TOKEN). */
  runToken: string;
  /** The run this client (and token) is bound to. */
  runId: string;
  /** Injected fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** Per-call ceiling for short control calls (default 30s) — bounds a poll frozen mid-flight. */
  controlTimeoutMs?: number;
  /** Per-call ceiling for bulk artifact/workspace transfers (default 5 min). */
  bulkTimeoutMs?: number;
  /** Backoff schedule for transient-failure retries (length = extra attempts after the first;
   *  see {@link RETRYABLE_STATUSES}). Injectable for tests; [] disables retries. */
  retryDelaysMs?: number[];
}

/**
 * Transient statuses worth retrying: the load-balancer answers during a control-plane deploy
 * rollover (no healthy target / draining target / gateway timeout). Anything else — including a
 * 500 — is treated as a real answer from a live handler and surfaces immediately: retrying a
 * handler error could duplicate a side effect for no healing value.
 */
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

/**
 * Transient statuses worth retrying on the STREAMING inference POST — a narrower set than
 * {@link RETRYABLE_STATUSES}. 502 is EXCLUDED: on `/inference` the broker uses 502 for a real
 * upstream model error (a clean, customer-facing message), so retrying it just re-hits a guaranteed
 * failure. 503/504 are only ever the load balancer during a rollover (no healthy / draining target,
 * gateway timeout) — safe to re-POST since the stream hasn't begun. See {@link streamInference}.
 */
const INFERENCE_RETRYABLE_STATUSES = new Set([503, 504]);

/** Default backoff (ms) between attempts — ~17.5s of spread, sized to ride out the target-group
 *  rotation window of an api-server rolling deploy (the observed killer: guests died hard
 *  mid-suspend/finalize during TWO deploys, 2026-07-13, and only crash-reclaim saved the runs). */
const DEFAULT_RETRY_DELAYS_MS = [500, 2_000, 5_000, 10_000];

/** The pinned program's download reference (the worker fetches + verifies + extracts it). */
export interface BrokerProgram {
  entry: string;
  digest: string;
  sdkVersion: string;
  downloadUrl: string;
}

export interface BrokerVersion {
  manifest: unknown;
  program: BrokerProgram;
}

/** The schedule spec the worker sends for `workflows.schedule` (exactly one of cron/rate/at). `at`
 *  is a ms epoch or ISO string — a Date is serialized to ISO by the host before it reaches here. */
export interface BrokerScheduleSpec {
  cron?: string;
  rate?: string;
  at?: string | number;
  timezone?: string;
  idempotencyKey?: string;
}

/** A child run's terminal-relevant state, as returned by the `children` create/poll endpoints. */
export interface BrokerChild {
  childRunId: string;
  status: string;
  output: unknown;
}

export class RunnerControlClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  /** The live bearer. Mutable: on the snapshot substrate a wake carries a FRESH run token (the
   *  frozen one expired while suspended) and the worker swaps it at runtime. */
  private runToken: string;
  private readonly controlTimeoutMs: number;
  private readonly bulkTimeoutMs: number;
  private readonly retryDelaysMs: readonly number[];

  constructor(private readonly cfg: RunnerControlClientConfig) {
    this.base = cfg.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.runToken = cfg.runToken;
    this.controlTimeoutMs = cfg.controlTimeoutMs ?? 30_000;
    this.bulkTimeoutMs = cfg.bulkTimeoutMs ?? 300_000;
    this.retryDelaysMs = cfg.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  /** Swap the bearer for a fresh run token (the wake path). Every subsequent call uses it. */
  swapRunToken(token: string): void {
    this.runToken = token;
  }

  /**
   * Every SHORT control call (claim / renew / cancel / credit / inputs / …) goes through here so
   * it carries a hard timeout. Without one, a poll frozen mid-flight on the snapshot substrate
   * hangs FOREVER on restore (the socket is dead but never reset), and since a watcher serializes
   * its ticks, one hung tick wedges that watcher — the dead-connections gotcha for the
   * background pollers (lease/cancel/credit), which run on untracked timers the quiescence gate
   * doesn't cover. Also plain robustness: no broker call should hang on a network blip. The
   * streaming inference call is the ONE exception (long-lived NDJSON) and bypasses this.
   */
  private controlFetch(url: string, init: RequestInit): Promise<Response> {
    return this.retryingFetch(url, init, this.controlTimeoutMs);
  }

  /** Bulk transfers (artifact + workspace up/download over presigned S3) — a much larger ceiling
   *  than a control call, but still bounded so a dead socket can't hang the run. */
  private bulkFetch(url: string, init: RequestInit): Promise<Response> {
    return this.retryingFetch(url, init, this.bulkTimeoutMs);
  }

  /**
   * One attempt per entry in the backoff schedule (+1): retry thrown network failures (connection
   * reset/refused mid-rollover, our own per-attempt timeout on a dead socket) and the
   * load-balancer's {@link RETRYABLE_STATUSES}. Safe to re-send because every caller's body is a
   * reusable string/byte-array (the streaming inference call bypasses this entirely), and the
   * broker's mutating endpoints are idempotent per worker/identifier (gate seq, usage
   * identifier, lease per workerId). Before this, ONE blip during an api-server deploy rollover
   * crashed the worker hard mid-suspend/finalize and only crash-reclaim recovered the run.
   */
  private async retryingFetch(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const last = attempt >= this.retryDelaysMs.length;
      try {
        const res = await this.fetchImpl(url, {
          ...init,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (last || !RETRYABLE_STATUSES.has(res.status)) return res;
        // Drop the unused body so the socket is released before the retry.
        await res.body?.cancel().catch(() => {});
        log.warn("broker_call_retry", {
          status: res.status,
          attempt: attempt + 1,
          delayMs: this.retryDelaysMs[attempt],
        });
      } catch (err) {
        if (last) throw err;
        log.warn("broker_call_retry", {
          error: err instanceof Error ? err.name : "unknown",
          attempt: attempt + 1,
          delayMs: this.retryDelaysMs[attempt],
        });
      }
      await sleep(this.retryDelaysMs[attempt] ?? 0);
    }
  }

  /** Claim the run's lease. Returns the run on success, or null when it isn't claimable (409 —
   *  another worker has it, or it isn't pending), which the worker treats as "claim lost". */
  async claim(
    workerId: string,
    leaseSeconds: number,
  ): Promise<{ run: Run; lastEventCursor: number } | null> {
    const res = await this.controlFetch(this.url("claim"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ workerId, leaseSeconds }),
    });
    if (res.status === 409) return null;
    if (res.status !== 201) throw await brokerError(res, "claim");
    const body = (await res.json()) as {
      run: Run;
      lastEventCursor?: number;
    };
    return {
      run: body.run,
      lastEventCursor: body.lastEventCursor ?? 0,
    };
  }

  /** Heartbeat: extend our lease so a long run isn't reclaimed mid-flight. Returns the new
   *  `leaseUntil`, or null when the lease was lost (409 — another worker reclaimed the run), which
   *  the worker treats as "stop". */
  async renewLease(workerId: string, leaseSeconds: number): Promise<number | null> {
    const res = await this.controlFetch(this.url("renew"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ workerId, leaseSeconds }),
    });
    if (res.status === 409) return null;
    if (res.status !== 200) throw await brokerError(res, "renew");
    const body = (await res.json()) as { leaseUntil: number };
    return body.leaseUntil;
  }

  /** Mark the run terminal. `workerId` lets the broker reject a finalize from a DISPLACED worker (one
   *  whose lease expired and whose run was reclaimed + re-dispatched to a new owner), so a
   *  hung/partitioned worker that later recovers can't clobber the live run or revive a terminal one. */
  async finalize(status: "completed" | "failed", output: unknown, workerId: string): Promise<void> {
    const res = await this.controlFetch(this.url("finalize"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ status, output, workerId }),
    });
    if (res.status !== 204) throw await brokerError(res, "finalize");
  }

  /** Fetch the run's pinned manifest + program source, or null when the version is missing (404). */
  async getVersion(): Promise<BrokerVersion | null> {
    const res = await this.controlFetch(this.url("version"), {
      method: "GET",
      headers: this.headers(false),
    });
    if (res.status === 404) return null;
    if (res.status !== 200) throw await brokerError(res, "version");
    return (await res.json()) as BrokerVersion;
  }

  /** Book a runtime-seconds DELTA (the worker's RuntimeFlusher → broker). `identifier` makes a
   *  retried/duplicate flush idempotent; distinct per-flush ids sum into the run's runtime total. */
  async reportUsage(runtimeSeconds: number, identifier: string): Promise<void> {
    const res = await this.controlFetch(this.url("usage"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ runtimeSeconds, identifier }),
    });
    if (res.status !== 204) throw await brokerError(res, "usage");
  }

  /** Report a token-usage delta for incremental in-run metering (the usage flusher → broker). The
   *  broker gates on the run's per-connection `billed_by_boardwalk` server-side + meters usage to the
   *  platform; `identifier` makes a retried/duplicate flush idempotent. Satisfies {@link TokenUsageReporter}. */
  async meterTokens(input: {
    inputTokens: number;
    outputTokens: number;
    model?: string;
    identifier: string;
    /** Cache-served input tokens — display-only annotation (omitted when zero/unknown). */
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
  }): Promise<void> {
    const res = await this.controlFetch(this.url("usage/tokens"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(input),
    });
    if (res.status !== 204) throw await brokerError(res, "usage/tokens");
  }

  /** Check whether the run's org is still funded (the CreditWatcher → broker). The broker reads the
   *  live billing balance server-side; `false` means out of credit (the watcher then aborts the run). */
  async checkCredit(): Promise<boolean> {
    const res = await this.controlFetch(this.url("credit"), {
      method: "GET",
      headers: this.headers(false),
    });
    if (res.status !== 200) throw await brokerError(res, "credit");
    return ((await res.json()) as { funded: boolean }).funded;
  }

  /** Check whether the run has been asked to cancel (the CancelWatcher → broker). `true` once the user
   *  cancelled the run (the broker flipped it to `cancelling`/`cancelled`); the watcher then aborts the
   *  run. Brokered because the runner holds no DB/Redis — this replaces the unreachable Redis channel. */
  async checkCancelled(): Promise<boolean> {
    const res = await this.controlFetch(this.url("cancel"), {
      method: "GET",
      headers: this.headers(false),
    });
    if (res.status !== 200) throw await brokerError(res, "cancel");
    return ((await res.json()) as { cancelRequested: boolean }).cancelRequested;
  }

  /** Register-without-release: register a HELD HITL gate's request row
   *  so it is answerable while the run keeps running — no suspend. Idempotent. Returns whether a new
   *  gate was registered. */
  async registerInput(seq: number, gate: unknown): Promise<boolean> {
    const res = await this.controlFetch(this.url("inputs"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ seq, humanInput: gate }),
    });
    if (res.status !== 200) throw await brokerError(res, "register-input");
    return ((await res.json()) as { registered: boolean }).registered;
  }

  /** Poll the resolved answers for a held gate at `seq` (empty until a human responds). */
  async pollInputAnswers(seq: number): Promise<Record<string, unknown>> {
    const res = await this.controlFetch(this.url(`inputs/${encodeURIComponent(String(seq))}`), {
      method: "GET",
      headers: this.headers(false),
    });
    if (res.status !== 200) throw await brokerError(res, "poll-inputs");
    return ((await res.json()) as { answers: Record<string, unknown> }).answers;
  }

  /** Mint a presigned GET URL to restore this workflow's last `/workspace` snapshot (workspace
   *  persistence). `null` when the run isn't eligible (not opted-in, or self-hosted). */
  async workspaceHydrateUrl(): Promise<string | null> {
    const res = await this.controlFetch(this.url("workspace/hydrate-url"), {
      method: "POST",
      headers: this.headers(false),
    });
    if (res.status !== 200) throw await brokerError(res, "workspace/hydrate-url");
    return ((await res.json()) as { url: string | null }).url;
  }

  /** Mint a presigned PUT URL to snapshot this workflow's `/workspace` (the worker uploads the tarball
   *  straight to S3). `null` when the run isn't eligible. `sizeBytes` is the archive's on-disk size
   *  (the worker tars BEFORE requesting the URL) — the broker records it for the org storage counter +
   *  daily meter; the snapshot overwrites one per-workflow key, so it's the workflow's full footprint. */
  async workspacePersistUrl(
    sizeBytes: number,
  ): Promise<{ url: string; contentType: string } | null> {
    const res = await this.controlFetch(this.url("workspace/persist-url"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ sizeBytes }),
    });
    if (res.status !== 200) throw await brokerError(res, "workspace/persist-url");
    const body = (await res.json()) as { url: string | null; contentType?: string };
    return body.url === null ? null : { url: body.url, contentType: body.contentType ?? "" };
  }

  /** Download bytes from a presigned S3 URL (workspace hydrate). `null` on 404 (no snapshot yet —
   *  e.g. the workflow's first run); throws on any other non-2xx. Goes straight to S3, not the broker. */
  async downloadBytes(url: string): Promise<Uint8Array | null> {
    const res = await this.bulkFetch(url, { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) throw await brokerError(res, "workspace-download");
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Request an OIDC run id-token for `audience` (§OIDC). The broker mints an asymmetric,
   *  third-party-verifiable token (gated server-side on `permissions.id_token: "write"`) — used to
   *  federate into the org's OWN cloud (AWS/GCP). DIFFERENT from this client's run token. */
  async requestOidcToken(audience: string): Promise<{ token: string; expiresIn: number }> {
    const res = await this.controlFetch(this.url("oidc/token"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ audience }),
    });
    if (res.status !== 200) throw await brokerError(res, "oidc/token");
    return (await res.json()) as { token: string; expiresIn: number };
  }

  /** Publish a batch of live agent-event frames (the SSE live-tail source) — the broker publishes
   *  them to the run's Redis channel server-side, so the runner holds no Redis credential. */
  async publishTelemetry(frames: string[]): Promise<void> {
    const res = await this.controlFetch(this.url("telemetry"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ frames }),
    });
    if (res.status !== 204) throw await brokerError(res, "telemetry");
  }

  /** Push a batch of encoded desktop frames (base64 JPEG) for the live-view surface — the broker
   *  republishes them to the run's live-view channel server-side (never durably stored; the session
   *  recording is the durable copy). See docs/SCREEN_CAPTURE.md §5. */
  async publishLiveView(frames: string[]): Promise<void> {
    const res = await this.controlFetch(this.url("liveview"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ frames }),
    });
    if (res.status !== 204) throw await brokerError(res, "liveview");
  }

  /** Is a browser currently watching this run's live-view? The capture loop polls this so it only
   *  captures + pushes frames while someone is attached (capture costs guest CPU + metered egress). */
  async liveViewWanted(): Promise<boolean> {
    const res = await this.controlFetch(this.url("liveview/wanted"), {
      method: "GET",
      headers: this.headers(false),
    });
    if (res.status !== 200) throw await brokerError(res, "liveview/wanted");
    const body = (await res.json()) as { wanted?: unknown };
    return body.wanted === true;
  }

  /** Store a run artifact through the broker (which holds the S3 credential + neutralizes the served
   *  content type server-side). Returns the catalog id + a signed download URL. */
  async writeArtifact(input: ArtifactWriteInput): Promise<ArtifactWriteResult> {
    const res = await this.controlFetch(this.url("artifacts"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(input),
    });
    if (res.status !== 201) throw await brokerError(res, "artifacts");
    return (await res.json()) as ArtifactWriteResult;
  }

  /** Phase 1 of the LARGE-artifact path (the Runner Credential Broker model): presign an S3 PUT. The
   *  broker derives the S3 key + neutralizes/pins the served content type; it returns the upload URL +
   *  required headers + the `s3Key` to echo back at commit. No catalog row exists yet. */
  async presignArtifact(input: ArtifactPresignInput): Promise<ArtifactPresignResult> {
    const res = await this.controlFetch(this.url("artifacts/presign"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(input),
    });
    if (res.status !== 201) throw await brokerError(res, "artifacts/presign");
    return (await res.json()) as ArtifactPresignResult;
  }

  /** Upload bytes to a presigned S3 URL (the large-artifact path). The `headers` come from the
   *  presign response and MUST be sent verbatim — the content type is pinned into the signature, so
   *  S3 rejects a mismatch. This call goes straight to S3, not the broker. */
  async uploadBytes(url: string, headers: Record<string, string>, body: Uint8Array): Promise<void> {
    const res = await this.bulkFetch(url, { method: "PUT", headers, body });
    if (!res.ok) throw await brokerError(res, "artifacts-upload");
  }

  /** Phase 2 of the LARGE-artifact path: register the catalog row AFTER the bytes have landed in S3
   *  (called only on a successful {@link uploadBytes}, so a failed upload leaves no dangling row). The
   *  broker re-validates the run prefix + re-neutralizes the content type, then returns the catalog id
   *  + a signed download URL. */
  async commitArtifact(input: ArtifactCommitInput): Promise<ArtifactWriteResult> {
    const res = await this.controlFetch(this.url("artifacts/commit"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(input),
    });
    if (res.status !== 201) throw await brokerError(res, "artifacts/commit");
    return (await res.json()) as ArtifactWriteResult;
  }

  /** List the artifacts this run has produced. */
  async listArtifacts(): Promise<ArtifactSummary[]> {
    const res = await this.controlFetch(this.url("artifacts"), {
      method: "GET",
      headers: this.headers(false),
    });
    if (res.status !== 200) throw await brokerError(res, "artifacts-list");
    return ((await res.json()) as { artifacts: ArtifactSummary[] }).artifacts;
  }

  /** Mint a fresh signed download URL for one of this run's artifacts. */
  async signArtifactUrl(artifactId: string, ttlSeconds: number): Promise<ArtifactSignResult> {
    const res = await this.controlFetch(
      this.url(`artifacts/${encodeURIComponent(artifactId)}/signed-url`),
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({ ttlSeconds }),
      },
    );
    if (res.status !== 200) throw await brokerError(res, "artifacts-sign");
    return (await res.json()) as ArtifactSignResult;
  }

  /** Resolve an org secret the run's manifest allows (the program's `secrets.get`). The broker
   *  enforces the allowlist + returns the value; a forbidden/missing secret surfaces as a throw. */
  async resolveSecret(name: string): Promise<string> {
    const res = await this.controlFetch(this.url("secrets/resolve"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ name }),
    });
    if (res.status !== 200) throw await brokerError(res, "secrets/resolve");
    const body = (await res.json()) as { value: string };
    return body.value;
  }

  /** Broker a short-lived OAuth bearer for a hosted MCP server (the engine's `mcpToken` hook, called
   *  reactively after a 401). The broker vends from the org's connection vault and re-checks egress.
   *  A 403 (no active connection / non-allowlisted host) degrades to `{ accessToken: null, hint }` so
   *  the engine surfaces a clean failure instead of a thrown 500 mid-run; the token is never logged. */
  async mcpToken(serverUrl: string, invalidateToken?: string): Promise<McpTokenResult> {
    const res = await this.controlFetch(this.url("mcp/token"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({
        serverUrl,
        ...(invalidateToken !== undefined ? { invalidateToken } : {}),
      }),
    });
    if (res.status === 403) {
      return { accessToken: null, hint: await brokerForbiddenHint(res) };
    }
    if (res.status !== 200) throw await brokerError(res, "mcp/token");
    const body = (await res.json()) as { accessToken: string; expiresAt: number | null };
    return { accessToken: body.accessToken };
  }

  /** Proxy a web_search through the broker (which holds the Tavily key) — the runner sends the
   *  query, the broker calls Tavily and returns the results. */
  async webSearch(input: unknown): Promise<WebSearchOutput> {
    const res = await this.controlFetch(this.url("tools/web_search"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(input),
    });
    if (res.status !== 200) throw await brokerError(res, "tools/web_search");
    return (await res.json()) as WebSearchOutput;
  }

  /** Create (or idempotently re-attach to) a child run for `workflows.call`. */
  async startChild(slug: string, input: unknown): Promise<BrokerChild> {
    const res = await this.controlFetch(this.url("children"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ slug, input }),
    });
    // The broker returns 201 for a fresh child, 200 for an idempotent re-attach.
    if (res.status !== 200 && res.status !== 201) throw await brokerError(res, "children");
    return (await res.json()) as BrokerChild;
  }

  /** Provision a durable schedule for `workflows.schedule`; returns the new schedule's id. */
  async scheduleWorkflow(slug: string, input: unknown, spec: BrokerScheduleSpec): Promise<string> {
    const res = await this.controlFetch(this.url("schedules"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ slug, input, ...spec }),
    });
    if (res.status !== 201) throw await brokerError(res, "schedules");
    return ((await res.json()) as { scheduleId: string }).scheduleId;
  }

  /** Poll a child run's status/output, or null when it isn't this run's child (404). */
  async getChild(
    childRunId: string,
  ): Promise<{ id: string; status: string; output: unknown } | null> {
    const res = await this.controlFetch(this.url(`children/${encodeURIComponent(childRunId)}`), {
      method: "GET",
      headers: this.headers(false),
    });
    if (res.status === 404) return null;
    if (res.status !== 200) throw await brokerError(res, "children-get");
    return (await res.json()) as { id: string; status: string; output: unknown };
  }

  /**
   * Proxy one model turn through the broker (the Runner Credential Broker model). POSTs the
   * neutral conversation; the broker resolves the REAL model server-side (the runner holds no model
   * creds), invokes the matching engine adapter, and relays the model's stream back as NDJSON
   * `InferenceFrame`s (delta / result / error). Yields each frame; the engine-backed leaf surfaces
   * deltas via `providerIo.onDelta`, takes the terminal `result` as the turn, and throws on `error`.
   *
   * Backs {@link InferenceProxyTransport} (inference_transport.ts) — the model swap is invisible to
   * the engine loop, which keeps the runner provider-agnostic (the broker owns model invocation). A
   * non-200 (a failure BEFORE the stream began) throws the broker's already-classified message.
   *
   * Resilience (added because a bare drop here surfaced as a run-fatal `PROVIDER_ERROR: terminated`):
   * a transient failure is retried WHILE it is still safe to re-POST — i.e. before any CONTENT frame
   * has been relayed. Three cases:
   *   - the POST never returned a response (connection refused/reset during an api-server rollover),
   *   - a load-balancer {@link INFERENCE_RETRYABLE_STATUSES} (no healthy / gateway timeout) before the
   *     stream began — NOT 502, which the broker uses for a real upstream model error,
   *   - the body dropped MID-stream (undici `terminated` / socket close) but only `ping` heartbeats
   *     had been relayed so far (the observed failure: a huge-context turn streamed only pings for
   *     ~120s during time-to-first-token, then the connection dropped).
   * Once a `delta`/`reasoning`/`result`/`error` frame has been yielded, the model has already
   * produced output (or the turn finished), so a re-POST would duplicate it: the drop surfaces as
   * before. Re-POST is billing-safe — the broker aborts the abandoned turn on our disconnect and
   * returns before it meters (no `result` frame ⇒ no usage). The body is a reusable string.
   */
  async *streamInference(
    req: InferenceProxyRequest,
  ): AsyncGenerator<InferenceFrame, void, undefined> {
    const body = serializeInferenceRequest(req);
    for (let attempt = 0; ; attempt += 1) {
      const last = attempt >= this.retryDelaysMs.length;

      let res: Response;
      try {
        res = await this.fetchImpl(this.url("inference"), {
          method: "POST",
          headers: { ...this.headers(true), accept: INFERENCE_NDJSON_CONTENT_TYPE },
          body,
        });
      } catch (err) {
        // No response at all — nothing streamed, so a re-POST is always safe.
        if (last) throw err;
        await this.backoffInferenceRetry(attempt, "connect", err);
        continue;
      }

      if (res.status !== 200 || res.body === null) {
        // A load-balancer transient (target draining / gateway timeout) before the stream began —
        // safe to re-POST. Any other non-200 is the broker's real, already-classified answer
        // (incl. a 502 upstream model error): surface it as the run's customer-facing error.
        if (!last && res.body !== null && INFERENCE_RETRYABLE_STATUSES.has(res.status)) {
          await res.body.cancel().catch(() => {});
          await this.backoffInferenceRetry(attempt, "status", res.status);
          continue;
        }
        throw await inferenceHttpError(res);
      }

      // Relay the stream. A mid-stream transport drop throws out of readNdjsonLines; retry it only
      // while nothing but heartbeats has gone out (see the doc-comment). `ping` frames carry no
      // model output, so a drop during the pre-first-token wait stays safely retryable.
      let sawContent = false;
      try {
        for await (const line of readNdjsonLines(res.body)) {
          const frame = parseInferenceFrame(line);
          if (frame.kind !== "ping") sawContent = true;
          yield frame;
        }
        return; // the stream ended cleanly
      } catch (err) {
        if (last || sawContent) throw err;
        await res.body.cancel().catch(() => {});
        await this.backoffInferenceRetry(attempt, "stream", err);
        continue;
      }
    }
  }

  /** Log + wait one backoff step before re-POSTing a transient inference failure (see streamInference). */
  private async backoffInferenceRetry(
    attempt: number,
    reason: "connect" | "status" | "stream",
    detail: unknown,
  ): Promise<void> {
    log.warn("broker_inference_retry", {
      reason,
      ...(reason === "status"
        ? { status: detail as number }
        : { error: detail instanceof Error ? detail.name : "unknown" }),
      attempt: attempt + 1,
      delayMs: this.retryDelaysMs[attempt],
    });
    await sleep(this.retryDelaysMs[attempt] ?? 0);
  }

  private url(suffix: string): string {
    return `${this.base}/runner/v1/runs/${encodeURIComponent(this.cfg.runId)}/${suffix}`;
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = {
      authorization: `Bearer ${this.runToken}`,
      accept: "application/json",
    };
    if (json) h["content-type"] = "application/json";
    return h;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Yield complete newline-delimited lines from a streaming response body (NDJSON inference frames),
 *  buffering partial chunks and flushing any trailing line. Blank lines are skipped. */
async function* readNdjsonLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const idx = buf.indexOf("\n");
        if (idx < 0) break;
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.length > 0) yield line;
      }
    }
    const tail = (buf + decoder.decode()).trim();
    if (tail.length > 0) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/** Build a redacted-enough error from a non-success broker response (status + a clipped body). Used
 *  for the internal control-plane ops (claim/finalize/usage/…), whose failures crash+restart the run
 *  rather than surface to the customer — so the op+status framing is the useful debugging detail. */
async function brokerError(res: Response, op: string): Promise<Error> {
  let detail = "";
  try {
    detail = (await res.text()).slice(0, 500);
  } catch {
    /* body unreadable — status alone is enough */
  }
  log.warn("broker_call_failed", { op, status: res.status });
  return new Error(`Runner Control ${op} failed: ${String(res.status)} ${detail}`);
}

/** Best-effort human hint from a broker 403 body (the error envelope's message, else the raw text)
 *  — surfaced to the model when an MCP server can't be reached. Never includes a token (403s carry
 *  none). */
async function brokerForbiddenHint(res: Response): Promise<string> {
  let text = "";
  try {
    text = (await res.text()).slice(0, 500);
  } catch {
    return "MCP connection is not available for this server.";
  }
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") return parsed.error.message;
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return text === "" ? "MCP connection is not available for this server." : text;
}

/** Clean Error from a non-200 INFERENCE response. Unlike {@link brokerError}, this becomes the run's
 *  customer-facing error, so it surfaces the broker's already-classified `{error:{message}}` directly
 *  (HTTP status / op stay in the log, not the user text). Falls back to a generic line if unparsable. */
async function inferenceHttpError(res: Response): Promise<Error> {
  let message = "Inference failed.";
  try {
    const parsed = JSON.parse(await res.text()) as { error?: { message?: string } };
    if (typeof parsed.error?.message === "string" && parsed.error.message.length > 0) {
      message = parsed.error.message;
    }
  } catch {
    /* non-JSON body — keep the generic message */
  }
  log.warn("broker_inference_failed", { status: res.status });
  return new Error(message);
}
