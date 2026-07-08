// RunnerControlClient — the worker's HTTP client for the Runner Control API (the Runner Credential Broker model).
//
// Under the broker model the worker reaches run lifecycle through the api-server, not the DB directly:
// it presents its per-run token (BOARDWALK_RUN_TOKEN) as a bearer credential and calls the broker for
// claim / finalize / version. The client is bound to ONE run (the token is too), so every call targets
// `…/runner/v1/runs/<runId>/…`.
//
// Thin + injectable (fetch is overridable) so it's unit-tested without a live server. Status mapping
// mirrors the broker handlers: claim 409 ⇒ "claim lost" (null), version 404 ⇒ missing (null); any
// other non-success status throws so the worker fails loud (→ restart, lease reclaimed).

import { createLogger } from "./support/index.js";
import type { McpTokenResult } from "@boardwalk-labs/engine/core";
import type { Run } from "./wire/run.js";
import {
  journalLookupSchema,
  type JournalKind,
  type JournalLookup,
  type JournalSeam,
  type SuspendSignal,
} from "./suspension.js";
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
}

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

  constructor(private readonly cfg: RunnerControlClientConfig) {
    this.base = cfg.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.runToken = cfg.runToken;
    this.controlTimeoutMs = cfg.controlTimeoutMs ?? 30_000;
    this.bulkTimeoutMs = cfg.bulkTimeoutMs ?? 300_000;
  }

  /** Swap the bearer for a fresh run token (the wake path). Every subsequent call uses it. */
  swapRunToken(token: string): void {
    this.runToken = token;
  }

  /**
   * Every SHORT control call (claim / renew / cancel / credit / journal / …) goes through here so
   * it carries a hard timeout. Without one, a poll frozen mid-flight on the snapshot substrate
   * hangs FOREVER on restore (the socket is dead but never reset), and since a watcher serializes
   * its ticks, one hung tick wedges that watcher — the §9 dead-connections gotcha for the
   * background pollers (lease/cancel/credit), which run on untracked timers the quiescence gate
   * doesn't cover. Also plain robustness: no broker call should hang on a network blip. The
   * streaming inference call is the ONE exception (long-lived NDJSON) and bypasses this.
   */
  private controlFetch(url: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.controlTimeoutMs) });
  }

  /** Bulk transfers (artifact + workspace up/download over presigned S3) — a much larger ceiling
   *  than a control call, but still bounded so a dead socket can't hang the run. */
  private bulkFetch(url: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.bulkTimeoutMs) });
  }

  /** Claim the run's lease. Returns the run on success, or null when it isn't claimable (409 —
   *  another worker has it, or it isn't pending), which the worker treats as "claim lost". */
  async claim(
    workerId: string,
    leaseSeconds: number,
  ): Promise<{ run: Run; lastEventCursor: number; lastJournalSeq: number } | null> {
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
      lastJournalSeq?: number;
    };
    return {
      run: body.run,
      lastEventCursor: body.lastEventCursor ?? 0,
      // The replay frontier for silent replay (the durable-suspension design): the highest journaled seq, so a
      // resumed run knows which seams already ran (suppress their re-emitted observability).
      lastJournalSeq: body.lastJournalSeq ?? 0,
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

  /** Look up a durable-seam journal entry by its seq (the durable-suspension design), or null on a replay miss
   *  (404). The broker joins a parked agent leaf's answers into the result server-side. */
  async journalGet(seq: number): Promise<JournalLookup | null> {
    const res = await this.controlFetch(this.url(`journal/${encodeURIComponent(String(seq))}`), {
      method: "GET",
      headers: this.headers(false),
    });
    if (res.status === 404) return null;
    if (res.status !== 200) throw await brokerError(res, "journal-get");
    return journalLookupSchema.parse(await res.json());
  }

  /** Record a RESOLVED seam result (idempotent on the run + seq server-side; a resolved entry is
   *  immutable). The broker writes the memoized value the next replay returns. */
  async journalPut(entry: {
    seq: number;
    kind: JournalKind;
    fingerprint: string;
    label: string;
    result: unknown;
  }): Promise<void> {
    const res = await this.controlFetch(this.url("journal"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(entry),
    });
    if (res.status !== 204) throw await brokerError(res, "journal-put");
  }

  /** Persist a durable SUSPENSION: the broker records the wake condition (a pending/suspended journal
   *  entry + a human-input request row for HITL, or the wake time for a long sleep), flips the run to
   *  its suspended status, and releases the lease — transactionally. No finalize; a wake re-dispatches. */
  async suspend(signal: SuspendSignal, workerId: string): Promise<void> {
    const res = await this.controlFetch(this.url("suspend"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ ...signal, workerId }),
    });
    if (res.status !== 204) throw await brokerError(res, "suspend");
  }

  /** The {@link JournalSeam} the worker host reads/writes — a thin adapter over the broker methods. */
  journalSeam(): JournalSeam {
    return {
      get: (seq) => this.journalGet(seq),
      put: (entry) => this.journalPut(entry),
    };
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
   *  broker gates on the run's per-connection `billed_by_boardwalk` server-side + meters to Stripe;
   *  `identifier` makes a retried/duplicate flush idempotent. Satisfies {@link TokenUsageReporter}. */
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
   *  live Stripe balance server-side; `false` means out of credit (the watcher then aborts the run). */
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

  /** Mint a presigned GET URL to restore this workflow's last `/workspace` snapshot (workspace
   *  persistence, §5). `null` when the run isn't eligible (not opted-in, or self-hosted). */
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
   */
  async *streamInference(
    req: InferenceProxyRequest,
  ): AsyncGenerator<InferenceFrame, void, undefined> {
    const res = await this.fetchImpl(this.url("inference"), {
      method: "POST",
      headers: { ...this.headers(true), accept: INFERENCE_NDJSON_CONTENT_TYPE },
      body: serializeInferenceRequest(req),
    });
    if (res.status !== 200 || res.body === null) {
      throw await inferenceHttpError(res);
    }
    for await (const line of readNdjsonLines(res.body)) {
      yield parseInferenceFrame(line);
    }
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
