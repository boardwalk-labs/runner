import { describe, it, expect } from "vitest";
import type { Run } from "./wire/run.js";
import { RunnerControlClient } from "./runner_control_client.js";
import {
  INFERENCE_NDJSON_CONTENT_TYPE,
  serializeDeltaFrame,
  serializeErrorFrame,
  serializeHeartbeatFrame,
  serializeResultFrame,
  type InferenceFrame,
} from "./wire/inference_proxy.js";

interface Recorded {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string | undefined;
}

function fakeFetch(handler: (rec: Recorded) => Response): {
  fetchImpl: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetchImpl = ((
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const rec: Recorded = {
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(rec);
    return Promise.resolve(handler(rec));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fakeRun = { id: "run_1", orgId: "org_1", workflowId: "wf_1" } as Run;

function client(
  fetchImpl: typeof fetch,
  baseUrl = "https://api.boardwalk.sh",
): RunnerControlClient {
  return new RunnerControlClient({ baseUrl, runToken: "rt_token", runId: "run_1", fetchImpl });
}

describe("RunnerControlClient.claim", () => {
  it("POSTs the claim with bearer auth + worker/lease body and returns run + resume cursor", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json(201, { run: fakeRun, leaseUntil: 123, lastEventCursor: 2_000_004 }),
    );
    const claimed = await client(fetchImpl).claim("worker-1", 300);

    expect(claimed?.run.id).toBe("run_1");
    expect(claimed?.lastEventCursor).toBe(2_000_004);
    const call = calls[0];
    expect(call?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/claim");
    expect(call?.method).toBe("POST");
    expect(call?.headers.authorization).toBe("Bearer rt_token");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({ workerId: "worker-1", leaseSeconds: 300 });
  });

  it("returns null on 409 (claim lost / not pending)", async () => {
    const { fetchImpl } = fakeFetch(() => json(409, { error: { code: "CONFLICT" } }));
    expect(await client(fetchImpl).claim("worker-1", 300)).toBeNull();
  });

  it("throws on an unexpected status", async () => {
    const { fetchImpl } = fakeFetch(() => json(500, { error: { code: "INTERNAL_ERROR" } }));
    await expect(client(fetchImpl).claim("worker-1", 300)).rejects.toThrow(/claim failed: 500/);
  });
});

describe("RunnerControlClient.renewLease", () => {
  it("POSTs the renew with worker/lease body and returns the new leaseUntil", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, { leaseUntil: 456 }));
    const leaseUntil = await client(fetchImpl).renewLease("worker-1", 300);

    expect(leaseUntil).toBe(456);
    const call = calls[0];
    expect(call?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/renew");
    expect(call?.method).toBe("POST");
    expect(call?.headers.authorization).toBe("Bearer rt_token");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({ workerId: "worker-1", leaseSeconds: 300 });
  });

  it("returns null on 409 (lease lost — another worker reclaimed it)", async () => {
    const { fetchImpl } = fakeFetch(() => json(409, { error: { code: "CONFLICT" } }));
    expect(await client(fetchImpl).renewLease("worker-1", 300)).toBeNull();
  });

  it("throws on an unexpected status", async () => {
    const { fetchImpl } = fakeFetch(() => json(500, { error: { code: "INTERNAL_ERROR" } }));
    await expect(client(fetchImpl).renewLease("worker-1", 300)).rejects.toThrow(
      /renew failed: 500/,
    );
  });
});

describe("RunnerControlClient.finalize", () => {
  it("POSTs status + output + workerId (the ownership guard) and resolves on 204", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    await client(fetchImpl).finalize("completed", { ok: true }, "worker-7");

    const call = calls[0];
    expect(call?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/finalize");
    expect(call?.headers.authorization).toBe("Bearer rt_token");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      status: "completed",
      output: { ok: true },
      workerId: "worker-7",
    });
  });

  it("throws on a non-204 status", async () => {
    const { fetchImpl } = fakeFetch(() => json(403, { error: { code: "FORBIDDEN" } }));
    await expect(client(fetchImpl).finalize("failed", null, "worker-7")).rejects.toThrow(
      /finalize failed: 403/,
    );
  });
});

describe("RunnerControlClient.getVersion", () => {
  it("GETs the pinned version with bearer auth", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json(200, { manifest: { name: "x" }, source: "s" }),
    );
    const v = await client(fetchImpl).getVersion();

    expect(v).toEqual({ manifest: { name: "x" }, source: "s" });
    const call = calls[0];
    expect(call?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/version");
    expect(call?.method).toBe("GET");
    expect(call?.headers.authorization).toBe("Bearer rt_token");
  });

  it("returns null on 404 (version missing)", async () => {
    const { fetchImpl } = fakeFetch(() => json(404, { error: { code: "NOT_FOUND" } }));
    expect(await client(fetchImpl).getVersion()).toBeNull();
  });

  it("throws on an unexpected status", async () => {
    const { fetchImpl } = fakeFetch(() => json(500, {}));
    await expect(client(fetchImpl).getVersion()).rejects.toThrow(/version failed: 500/);
  });
});

describe("RunnerControlClient.reportUsage", () => {
  it("POSTs the runtime delta + idempotency identifier and resolves on 204", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    await client(fetchImpl).reportUsage(42, "run_1:s1:rt:3");
    const call = calls[0];
    expect(call?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/usage");
    expect(call?.headers.authorization).toBe("Bearer rt_token");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      runtimeSeconds: 42,
      identifier: "run_1:s1:rt:3",
    });
  });

  it("throws on a non-204 status", async () => {
    const { fetchImpl } = fakeFetch(() => json(500, {}));
    await expect(client(fetchImpl).reportUsage(1, "run_1:s1:rt:0")).rejects.toThrow(
      /usage failed: 500/,
    );
  });
});

describe("RunnerControlClient live-view", () => {
  it("publishLiveView POSTs frames to /liveview and resolves on 204", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    await client(fetchImpl).publishLiveView(["frameA", "frameB"]);
    const call = calls[0];
    expect(call?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/liveview");
    expect(call?.method).toBe("POST");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({ frames: ["frameA", "frameB"] });
  });

  it("publishLiveView throws on a non-204 status", async () => {
    const { fetchImpl } = fakeFetch(() => json(500, {}));
    await expect(client(fetchImpl).publishLiveView(["x"])).rejects.toThrow(/liveview failed: 500/);
  });

  it("liveViewWanted GETs /liveview/wanted and returns the wanted flag", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, { wanted: true }));
    const wanted = await client(fetchImpl).liveViewWanted();
    expect(calls[0]?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/liveview/wanted");
    expect(calls[0]?.method).toBe("GET");
    expect(wanted).toBe(true);
  });

  it("liveViewWanted returns false when no viewer is present", async () => {
    const { fetchImpl } = fakeFetch(() => json(200, { wanted: false }));
    expect(await client(fetchImpl).liveViewWanted()).toBe(false);
  });
});

describe("RunnerControlClient.meterTokens", () => {
  it("POSTs the token delta + model + identifier to /usage/tokens and resolves on 204", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    await client(fetchImpl).meterTokens({
      inputTokens: 100,
      outputTokens: 40,
      model: "my-openai/gpt-4o",
      identifier: "run_1:s1:0",
    });
    const call = calls[0];
    expect(call?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/usage/tokens");
    expect(call?.method).toBe("POST");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      model: "my-openai/gpt-4o",
      identifier: "run_1:s1:0",
    });
  });

  it("omits the model when undefined (managed default resolved server-side)", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    await client(fetchImpl).meterTokens({ inputTokens: 1, outputTokens: 2, identifier: "id" });
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      identifier: "id",
    });
  });

  it("throws on a non-204 status", async () => {
    const { fetchImpl } = fakeFetch(() => json(500, {}));
    await expect(
      client(fetchImpl).meterTokens({ inputTokens: 1, outputTokens: 0, identifier: "id" }),
    ).rejects.toThrow(/usage\/tokens failed: 500/);
  });
});

describe("RunnerControlClient.checkCredit", () => {
  it("GETs /credit and returns the funded flag", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, { funded: true }));
    const funded = await client(fetchImpl).checkCredit();
    expect(funded).toBe(true);
    expect(calls[0]?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/credit");
    expect(calls[0]?.method).toBe("GET");
  });

  it("returns false when the org is out of credit", async () => {
    const { fetchImpl } = fakeFetch(() => json(200, { funded: false }));
    expect(await client(fetchImpl).checkCredit()).toBe(false);
  });

  it("throws on a non-200 status", async () => {
    const { fetchImpl } = fakeFetch(() => json(500, {}));
    await expect(client(fetchImpl).checkCredit()).rejects.toThrow(/credit failed: 500/);
  });
});

describe("RunnerControlClient.checkCancelled", () => {
  it("GETs /cancel and returns the cancelRequested flag", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, { cancelRequested: true }));
    const cancelled = await client(fetchImpl).checkCancelled();
    expect(cancelled).toBe(true);
    expect(calls[0]?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/cancel");
    expect(calls[0]?.method).toBe("GET");
  });

  it("returns false while the run is not cancelled", async () => {
    const { fetchImpl } = fakeFetch(() => json(200, { cancelRequested: false }));
    expect(await client(fetchImpl).checkCancelled()).toBe(false);
  });

  it("throws on a non-200 status", async () => {
    const { fetchImpl } = fakeFetch(() => json(500, {}));
    await expect(client(fetchImpl).checkCancelled()).rejects.toThrow(/cancel failed: 500/);
  });
});

describe("RunnerControlClient workspace", () => {
  it("workspaceHydrateUrl POSTs and returns the url (or null when ineligible)", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, { url: "https://s3/get?sig" }));
    expect(await client(fetchImpl).workspaceHydrateUrl()).toBe("https://s3/get?sig");
    expect(calls[0]?.url).toBe(
      "https://api.boardwalk.sh/runner/v1/runs/run_1/workspace/hydrate-url",
    );
    const { fetchImpl: f2 } = fakeFetch(() => json(200, { url: null }));
    expect(await client(f2).workspaceHydrateUrl()).toBeNull();
  });

  it("workspacePersistUrl sends the snapshot size + returns the url, or null when ineligible", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json(200, { url: "https://s3/put?sig", contentType: "application/gzip" }),
    );
    expect(await client(fetchImpl).workspacePersistUrl(2048)).toEqual({
      url: "https://s3/put?sig",
      contentType: "application/gzip",
    });
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ sizeBytes: 2048 });
    const { fetchImpl: f2 } = fakeFetch(() => json(200, { url: null }));
    expect(await client(f2).workspacePersistUrl(0)).toBeNull();
  });

  it("downloadBytes returns the bytes, null on 404, throws otherwise", async () => {
    const { fetchImpl } = fakeFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const bytes = await client(fetchImpl).downloadBytes("https://s3/get");
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));

    const { fetchImpl: f404 } = fakeFetch(() => new Response(null, { status: 404 }));
    expect(await client(f404).downloadBytes("https://s3/get")).toBeNull();

    const { fetchImpl: f500 } = fakeFetch(() => new Response(null, { status: 500 }));
    await expect(client(f500).downloadBytes("https://s3/get")).rejects.toThrow(
      /workspace-download failed: 500/,
    );
  });
});

describe("RunnerControlClient.requestOidcToken", () => {
  it("POSTs the audience to /oidc/token and returns the token", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json(200, { token: "eyJ.signed.jws", expiresIn: 900 }),
    );
    const out = await client(fetchImpl).requestOidcToken("sts.amazonaws.com");
    expect(out).toEqual({ token: "eyJ.signed.jws", expiresIn: 900 });
    const call = calls[0];
    expect(call?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/oidc/token");
    expect(call?.method).toBe("POST");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({ audience: "sts.amazonaws.com" });
  });

  it("throws on a non-200 (e.g. 403 when the manifest doesn't grant id_token)", async () => {
    const { fetchImpl } = fakeFetch(() => json(403, { error: { code: "FORBIDDEN" } }));
    await expect(client(fetchImpl).requestOidcToken("sts.amazonaws.com")).rejects.toThrow(
      /oidc\/token failed: 403/,
    );
  });

  it("mints with the CURRENT run token after a wake swap (post-resume idToken)", async () => {
    // idToken is fetched per call, so a post-resume mint must ride the fresh bearer the wake
    // swapped in — not the frozen one that expired while suspended.
    const { fetchImpl, calls } = fakeFetch(() =>
      json(200, { token: "eyJ.signed.jws", expiresIn: 900 }),
    );
    const c = new RunnerControlClient({
      baseUrl: "https://api.boardwalk.sh",
      runToken: "boot-token",
      runId: "run_1",
      fetchImpl,
    });
    await c.requestOidcToken("sts.amazonaws.com");
    c.swapRunToken("fresh-token");
    await c.requestOidcToken("sts.amazonaws.com");
    expect(calls.map((r) => r.headers.authorization)).toEqual([
      "Bearer boot-token",
      "Bearer fresh-token",
    ]);
  });
});

describe("RunnerControlClient.resolveSecret", () => {
  it("POSTs the name and returns the resolved value", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, { value: "sk-live-xyz" }));
    const value = await client(fetchImpl).resolveSecret("LINEAR_TOKEN");
    expect(value).toBe("sk-live-xyz");
    const call = calls[0];
    expect(call?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/secrets/resolve");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({ name: "LINEAR_TOKEN" });
  });

  it("throws when the broker forbids / can't find the secret", async () => {
    const { fetchImpl } = fakeFetch(() => json(403, { error: { code: "FORBIDDEN" } }));
    await expect(client(fetchImpl).resolveSecret("NOPE")).rejects.toThrow(
      /secrets\/resolve failed: 403/,
    );
  });
});

describe("RunnerControlClient.startChild", () => {
  it("POSTs slug + input and returns the child (201 fresh)", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json(201, { childRunId: "child_1", status: "pending", output: null }),
    );
    const child = await client(fetchImpl).startChild("file-issue", { x: 1 });
    expect(child).toEqual({ childRunId: "child_1", status: "pending", output: null });
    const call = calls[0];
    expect(call?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/children");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({ slug: "file-issue", input: { x: 1 } });
  });

  it("accepts a 200 idempotent re-attach", async () => {
    const { fetchImpl } = fakeFetch(() =>
      json(200, { childRunId: "child_existing", status: "completed", output: { ok: 1 } }),
    );
    const child = await client(fetchImpl).startChild("file-issue", null);
    expect(child.status).toBe("completed");
  });

  it("throws on an unexpected status", async () => {
    const { fetchImpl } = fakeFetch(() => json(409, { error: { code: "CONFLICT" } }));
    await expect(client(fetchImpl).startChild("x", null)).rejects.toThrow(/children failed: 409/);
  });
});

describe("RunnerControlClient.scheduleWorkflow", () => {
  it("POSTs slug + input + spec and returns the schedule id", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(201, { scheduleId: "sched_1" }));
    const id = await client(fetchImpl).scheduleWorkflow(
      "daily-report",
      { team: "growth" },
      { cron: "0 9 * * 1", timezone: "UTC" },
    );
    expect(id).toBe("sched_1");
    const call = calls[0];
    expect(call?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/schedules");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      slug: "daily-report",
      input: { team: "growth" },
      cron: "0 9 * * 1",
      timezone: "UTC",
    });
  });

  it("throws on a non-201 status", async () => {
    const { fetchImpl } = fakeFetch(() => json(400, { error: { code: "VALIDATION_FAILED" } }));
    await expect(
      client(fetchImpl).scheduleWorkflow("x", null, { at: "2026-06-16T21:00:00Z" }),
    ).rejects.toThrow(/schedules failed: 400/);
  });
});

describe("RunnerControlClient.getChild", () => {
  it("GETs the child and returns its status/output", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json(200, { id: "child_1", status: "completed", output: { done: true } }),
    );
    const child = await client(fetchImpl).getChild("child_1");
    expect(child).toEqual({ id: "child_1", status: "completed", output: { done: true } });
    expect(calls[0]?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/children/child_1");
  });

  it("returns null on 404 (not this run's child)", async () => {
    const { fetchImpl } = fakeFetch(() => json(404, { error: { code: "NOT_FOUND" } }));
    expect(await client(fetchImpl).getChild("child_x")).toBeNull();
  });
});

describe("RunnerControlClient.webSearch", () => {
  it("POSTs the search input and returns the broker output", async () => {
    const out = { kind: "web_search", humanSummary: "Found 1", data: { query: "q", results: [] } };
    const { fetchImpl, calls } = fakeFetch(() => json(200, out));
    const result = await client(fetchImpl).webSearch({ query: "q", max_results: 5 });
    expect(result).toEqual(out);
    const call = calls[0];
    expect(call?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/tools/web_search");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({ query: "q", max_results: 5 });
  });

  it("throws on a non-200 status", async () => {
    const { fetchImpl } = fakeFetch(() => json(429, { error: { code: "RATE_LIMIT" } }));
    await expect(client(fetchImpl).webSearch({ query: "q" })).rejects.toThrow(
      /tools\/web_search failed: 429/,
    );
  });
});

describe("RunnerControlClient artifacts", () => {
  it("writeArtifact POSTs the input and returns the catalog result (201)", async () => {
    const out = {
      id: "art_1",
      name: "r.json",
      sizeBytes: 11,
      signedUrl: "https://cdn/x",
      expiresAt: 9,
    };
    const { fetchImpl, calls } = fakeFetch(() => json(201, out));
    const result = await client(fetchImpl).writeArtifact({
      name: "r.json",
      contentType: "application/json",
      body: '{"ok":true}',
    });
    expect(result).toEqual(out);
    const call = calls[0];
    expect(call?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/artifacts");
    expect(call?.method).toBe("POST");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      name: "r.json",
      contentType: "application/json",
      body: '{"ok":true}',
    });
  });

  it("writeArtifact throws on a non-201", async () => {
    const { fetchImpl } = fakeFetch(() => json(403, { error: { code: "FORBIDDEN" } }));
    await expect(
      client(fetchImpl).writeArtifact({ name: "x", contentType: "text/plain", body: "y" }),
    ).rejects.toThrow(/artifacts failed: 403/);
  });

  it("listArtifacts GETs and unwraps the artifacts array", async () => {
    const arts = [
      { id: "a1", name: "a.json", contentType: "application/json", sizeBytes: 1, createdAt: 5 },
    ];
    const { fetchImpl, calls } = fakeFetch(() => json(200, { artifacts: arts }));
    const result = await client(fetchImpl).listArtifacts();
    expect(result).toEqual(arts);
    expect(calls[0]?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/artifacts");
    expect(calls[0]?.method).toBe("GET");
  });

  it("signArtifactUrl POSTs the ttl and returns the signed result", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json(200, { signedUrl: "https://cdn/y", expiresAt: 7 }),
    );
    const result = await client(fetchImpl).signArtifactUrl("art_1", 120);
    expect(result).toEqual({ signedUrl: "https://cdn/y", expiresAt: 7 });
    const call = calls[0];
    expect(call?.url).toBe(
      "https://api.boardwalk.sh/runner/v1/runs/run_1/artifacts/art_1/signed-url",
    );
    expect(JSON.parse(call?.body ?? "{}")).toEqual({ ttlSeconds: 120 });
  });

  it("presignArtifact POSTs to /artifacts/presign and returns the upload URL + s3Key (201)", async () => {
    const out = {
      s3Key: "orgs/o/runs/r/TOKEN.csv",
      uploadUrl: "https://s3/upload?sig=put",
      uploadHeaders: { "content-type": "text/csv" },
      expiresAt: 99,
    };
    const { fetchImpl, calls } = fakeFetch(() => json(201, out));
    const result = await client(fetchImpl).presignArtifact({
      name: "big.csv",
      contentType: "text/csv",
      sizeBytes: 8_000_000,
    });
    expect(result).toEqual(out);
    const call = calls[0];
    expect(call?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/artifacts/presign");
    expect(call?.method).toBe("POST");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      name: "big.csv",
      contentType: "text/csv",
      sizeBytes: 8_000_000,
    });
  });

  it("presignArtifact throws on a non-201", async () => {
    const { fetchImpl } = fakeFetch(() => json(400, { error: { code: "VALIDATION_FAILED" } }));
    await expect(
      client(fetchImpl).presignArtifact({ name: "x", contentType: "text/plain", sizeBytes: 1 }),
    ).rejects.toThrow(/artifacts\/presign failed: 400/);
  });

  it("commitArtifact POSTs the echoed s3Key + metadata and returns the catalog result (201)", async () => {
    const out = {
      id: "art_2",
      name: "big.csv",
      sizeBytes: 8_000_000,
      signedUrl: "https://cdn/big",
      expiresAt: 99,
    };
    const { fetchImpl, calls } = fakeFetch(() => json(201, out));
    const result = await client(fetchImpl).commitArtifact({
      s3Key: "orgs/o/runs/r/TOKEN.csv",
      name: "big.csv",
      contentType: "text/csv",
      sizeBytes: 8_000_000,
    });
    expect(result).toEqual(out);
    const call = calls[0];
    expect(call?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/artifacts/commit");
    expect(call?.method).toBe("POST");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      s3Key: "orgs/o/runs/r/TOKEN.csv",
      name: "big.csv",
      contentType: "text/csv",
      sizeBytes: 8_000_000,
    });
  });

  it("commitArtifact throws on a non-201", async () => {
    const { fetchImpl } = fakeFetch(() => json(403, { error: { code: "FORBIDDEN" } }));
    await expect(
      client(fetchImpl).commitArtifact({
        s3Key: "orgs/o/runs/r/T.csv",
        name: "x",
        contentType: "text/plain",
        sizeBytes: 1,
      }),
    ).rejects.toThrow(/artifacts\/commit failed: 403/);
  });
});

describe("RunnerControlClient.uploadBytes", () => {
  it("PUTs the bytes to the presigned URL with the pinned headers", async () => {
    let seen:
      | { url: string; method: string | undefined; headers: unknown; bodyLen: number }
      | undefined;
    const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = init?.body;
      seen = {
        url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        method: init?.method,
        headers: init?.headers,
        bodyLen: body instanceof Uint8Array ? body.length : -1,
      };
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as typeof fetch;
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await client(fetchImpl).uploadBytes(
      "https://s3/upload?sig=put",
      { "content-type": "text/csv" },
      bytes,
    );
    expect(seen?.url).toBe("https://s3/upload?sig=put");
    expect(seen?.method).toBe("PUT");
    expect(seen?.headers).toEqual({ "content-type": "text/csv" });
    expect(seen?.bodyLen).toBe(5);
  });

  it("throws when S3 rejects the upload (non-2xx)", async () => {
    const fetchImpl = (() =>
      Promise.resolve(new Response("AccessDenied", { status: 403 }))) as typeof fetch;
    await expect(
      client(fetchImpl).uploadBytes("https://s3/upload", {}, new Uint8Array([1])),
    ).rejects.toThrow(/artifacts-upload failed: 403/);
  });
});

describe("RunnerControlClient.publishTelemetry", () => {
  it("POSTs the frames batch and resolves on 204", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    await client(fetchImpl).publishTelemetry(['{"cursor":1}', '{"cursor":2}']);
    const call = calls[0];
    expect(call?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/telemetry");
    expect(call?.method).toBe("POST");
    expect(call?.headers.authorization).toBe("Bearer rt_token");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({ frames: ['{"cursor":1}', '{"cursor":2}'] });
  });

  it("throws on a non-204 status", async () => {
    const { fetchImpl } = fakeFetch(() => json(500, {}));
    await expect(client(fetchImpl).publishTelemetry(["x"])).rejects.toThrow(
      /telemetry failed: 500/,
    );
  });
});

describe("RunnerControlClient.streamInference", () => {
  async function drain(it: AsyncIterable<InferenceFrame>): Promise<InferenceFrame[]> {
    const out: InferenceFrame[] = [];
    for await (const e of it) out.push(e);
    return out;
  }

  const turn = {
    text: "hi",
    toolCalls: [],
    usage: { inputTokens: 3, outputTokens: 2 },
    wantsTools: false,
  };

  it("POSTs the request and yields the NDJSON-relayed frames (deltas + the terminal result)", async () => {
    const ndjson = serializeDeltaFrame("hi") + serializeResultFrame(turn, "boardwalk/sonnet");
    const { fetchImpl, calls } = fakeFetch(
      () =>
        new Response(ndjson, {
          status: 200,
          headers: { "content-type": INFERENCE_NDJSON_CONTENT_TYPE },
        }),
    );
    const frames = await drain(
      client(fetchImpl).streamInference({
        model: "anthropic/claude-sonnet-4.5",
        provider: "boardwalk",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      }),
    );
    expect(frames).toEqual([
      { kind: "delta", text: "hi" },
      { kind: "result", turn, modelRef: "boardwalk/sonnet", costMicros: 0 },
    ]);
    const call = calls[0];
    expect(call?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/inference");
    expect(call?.method).toBe("POST");
    expect(call?.headers.authorization).toBe("Bearer rt_token");
    expect(call?.headers.accept).toBe(INFERENCE_NDJSON_CONTENT_TYPE);
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      model: "anthropic/claude-sonnet-4.5",
      provider: "boardwalk",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });
  });

  it("yields a terminal error frame (the consumer decides how to surface it)", async () => {
    const ndjson =
      serializeDeltaFrame("hi") +
      serializeErrorFrame({
        code: "PROVIDER_RATE_LIMITED",
        message: "Slow down, try again shortly.",
      });
    const { fetchImpl } = fakeFetch(() => new Response(ndjson, { status: 200 }));
    const frames = await drain(
      client(fetchImpl).streamInference({ model: "a", provider: "b", messages: [], tools: [] }),
    );
    expect(frames[1]).toEqual({
      kind: "error",
      error: { code: "PROVIDER_RATE_LIMITED", message: "Slow down, try again shortly." },
    });
  });

  it("surfaces the broker's clean message on a non-200 response (no status/json nesting)", async () => {
    const { fetchImpl } = fakeFetch(() =>
      json(502, {
        error: {
          code: "MODEL_NOT_FOUND",
          message: 'Model "anthropic/claude-3.5-haiku" was not found on this connection.',
        },
      }),
    );
    await expect(
      drain(
        client(fetchImpl).streamInference({ model: "a", provider: "b", messages: [], tools: [] }),
      ),
    ).rejects.toThrow(/^Model "anthropic\/claude-3\.5-haiku" was not found on this connection\.$/);
  });

  it("falls back to a generic message when a non-200 body isn't parseable", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("<html>502</html>", { status: 502 }));
    await expect(
      drain(
        client(fetchImpl).streamInference({ model: "a", provider: "b", messages: [], tools: [] }),
      ),
    ).rejects.toThrow(/^Inference failed\.$/);
  });
});

describe("RunnerControlClient url building", () => {
  it("normalizes a trailing slash on the base URL", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    await client(fetchImpl, "https://api.boardwalk.sh/").finalize("completed", null, "worker-7");
    expect(calls[0]?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/finalize");
  });
});

describe("claim", () => {
  it("returns the run + lastEventCursor (defaulting to 0)", async () => {
    const withCursor = fakeFetch(() =>
      json(201, { run: fakeRun, leaseUntil: 1, lastEventCursor: 7 }),
    );
    expect((await client(withCursor.fetchImpl).claim("w", 300))?.lastEventCursor).toBe(7);
    const without = fakeFetch(() => json(201, { run: fakeRun, leaseUntil: 1 }));
    expect((await client(without.fetchImpl).claim("w", 300))?.lastEventCursor).toBe(0);
  });
});

describe("swapRunToken (the wake path)", () => {
  it("every call after the swap carries the fresh bearer", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const c = new RunnerControlClient({
      baseUrl: "https://api.test",
      runToken: "old-token",
      runId: "run_1",
      fetchImpl,
    });
    await c.finalize("completed", {}, "w1");
    c.swapRunToken("fresh-token");
    await c.finalize("completed", {}, "w1");
    expect(calls.map((r) => r.headers.authorization)).toEqual([
      "Bearer old-token",
      "Bearer fresh-token",
    ]);
  });
});

describe("control-call timeout (freeze-mid-poll safety)", () => {
  it("a poll that never responds rejects on the AbortSignal instead of hanging forever", async () => {
    // A fetch that honors the abort signal but never resolves otherwise — models a socket frozen
    // mid-poll and dead on restore. The client must abort it via its own timeout.
    const fetchImpl = ((_url: string, init?: RequestInit): Promise<Response> => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
      });
    }) as typeof fetch;
    const c = new RunnerControlClient({
      baseUrl: "https://api.boardwalk.sh",
      runToken: "rt",
      runId: "run_1",
      fetchImpl,
      controlTimeoutMs: 40, // tiny so the test is fast
      retryDelaysMs: [], // retries off: this test isolates the per-attempt timeout
    });
    const start = Date.now();
    await expect(c.checkCancelled()).rejects.toBeTruthy();
    expect(Date.now() - start).toBeLessThan(2000); // aborted promptly, not hung
  });

  it("passes an AbortSignal on control calls and none on the inference stream", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetchImpl = ((_url: string, init?: RequestInit): Promise<Response> => {
      signals.push(init?.signal);
      return Promise.resolve(json(200, { cancelled: false }));
    }) as typeof fetch;
    const c = client(fetchImpl);
    await c.checkCancelled();
    expect(signals[0]).toBeInstanceOf(AbortSignal); // control call is bounded
  });
});

describe("register-without-release (held HITL gates)", () => {
  it("registerInput POSTs the gate and returns whether it was newly registered", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, { registered: true }));
    const c = client(fetchImpl);
    const created = await c.registerInput(3, { key: "approve", prompt: "ok?" });
    expect(created).toBe(true);
    expect(calls[0]?.url).toMatch(/\/runner\/v1\/runs\/run_1\/inputs$/);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      seq: 3,
      humanInput: { key: "approve", prompt: "ok?" },
    });
  });

  it("pollInputAnswers GETs the resolved answers for a seq", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json(200, { answers: { approve: { value: "yes" } } }),
    );
    const c = client(fetchImpl);
    const answers = await c.pollInputAnswers(3);
    expect(answers).toEqual({ approve: { value: "yes" } });
    expect(calls[0]?.url).toMatch(/\/runner\/v1\/runs\/run_1\/inputs\/3$/);
  });
});

describe("transient-failure retry (control-plane deploy rollovers)", () => {
  // Zero-delay schedule: exercises the retry LOOP without real backoff waits.
  function retryClient(fetchImpl: typeof fetch, retryDelaysMs: number[]): RunnerControlClient {
    return new RunnerControlClient({
      baseUrl: "https://api.boardwalk.sh",
      runToken: "rt_token",
      runId: "run_1",
      fetchImpl,
      retryDelaysMs,
    });
  }

  it("retries an LB 503 and succeeds on a later attempt", async () => {
    let n = 0;
    const { fetchImpl, calls } = fakeFetch(() => {
      n += 1;
      return n < 3 ? json(503, { error: "no healthy target" }) : json(200, { funded: true });
    });
    const c = retryClient(fetchImpl, [0, 0, 0]);
    await expect(c.checkCredit()).resolves.toBe(true);
    expect(calls).toHaveLength(3);
  });

  it("retries a thrown network error (connection reset mid-rollover)", async () => {
    let n = 0;
    const { fetchImpl, calls } = fakeFetch(() => {
      n += 1;
      if (n === 1) throw new TypeError("fetch failed");
      return json(200, { cancelRequested: false });
    });
    const c = retryClient(fetchImpl, [0, 0]);
    await expect(c.checkCancelled()).resolves.toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("exhausts the schedule and surfaces the last 5xx as the usual broker error", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(503, { error: "still rolling" }));
    const c = retryClient(fetchImpl, [0, 0]);
    await expect(c.checkCredit()).rejects.toThrow(/503/);
    expect(calls).toHaveLength(3); // first attempt + two retries
  });

  it("exhausts the schedule and rethrows a persistent network error", async () => {
    const { fetchImpl, calls } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const c = retryClient(fetchImpl, [0]);
    await expect(c.checkCredit()).rejects.toThrow(/fetch failed/);
    expect(calls).toHaveLength(2);
  });

  it("does NOT retry a real answer (409 claim-lost stays single-shot)", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(409, { error: "claimed" }));
    const c = retryClient(fetchImpl, [0, 0, 0]);
    await expect(c.claim("w1", 60)).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("does NOT retry a 500 (a live handler's answer — retrying could duplicate a side effect)", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(500, { error: "boom" }));
    const c = retryClient(fetchImpl, [0, 0]);
    await expect(c.checkCredit()).rejects.toThrow(/500/);
    expect(calls).toHaveLength(1);
  });

  it("bulk transfers (presigned S3) retry too", async () => {
    let n = 0;
    const { fetchImpl, calls } = fakeFetch(() => {
      n += 1;
      return n === 1 ? json(503, {}) : new Response(new Uint8Array([1, 2]), { status: 200 });
    });
    const c = retryClient(fetchImpl, [0]);
    const bytes = await c.downloadBytes("https://s3.example/presigned");
    expect(bytes).toEqual(new Uint8Array([1, 2]));
    expect(calls).toHaveLength(2);
  });

  // Streaming inference retries only while a re-POST is safe — before any CONTENT frame has gone out.
  // A bare drop here used to surface as a run-fatal `PROVIDER_ERROR: terminated`.
  describe("streaming inference", () => {
    const turn = {
      text: "hi",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      wantsTools: false,
    };
    const streamOk = (ndjson: string): Response =>
      new Response(ndjson, {
        status: 200,
        headers: { "content-type": INFERENCE_NDJSON_CONTENT_TYPE },
      });
    // A 200 stream that relays `lines` verbatim, then the socket drops (undici `terminated`).
    function streamThenDrop(lines: readonly string[]): Response {
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const line = lines[i];
          if (line === undefined) {
            controller.error(new TypeError("terminated"));
            return;
          }
          i += 1;
          controller.enqueue(new TextEncoder().encode(line));
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": INFERENCE_NDJSON_CONTENT_TYPE },
      });
    }
    async function drain(c: RunnerControlClient): Promise<InferenceFrame[]> {
      const out: InferenceFrame[] = [];
      for await (const f of c.streamInference({
        model: "a",
        provider: "b",
        messages: [],
        tools: [],
      })) {
        out.push(f);
      }
      return out;
    }

    it("retries an LB 503 before the stream begins, then relays the turn", async () => {
      let n = 0;
      const { fetchImpl, calls } = fakeFetch(() => {
        n += 1;
        return n < 2
          ? json(503, { error: "no healthy target" })
          : streamOk(serializeResultFrame(turn, "m"));
      });
      const frames = await drain(retryClient(fetchImpl, [0, 0]));
      expect(frames).toEqual([{ kind: "result", turn, modelRef: "m", costMicros: 0 }]);
      expect(calls).toHaveLength(2);
    });

    it("does NOT retry a 502 — the broker's upstream model error surfaces once", async () => {
      const { fetchImpl, calls } = fakeFetch(() =>
        json(502, { error: { code: "MODEL_ERROR", message: "upstream boom" } }),
      );
      await expect(drain(retryClient(fetchImpl, [0, 0]))).rejects.toThrow(/^upstream boom$/);
      expect(calls).toHaveLength(1);
    });

    it("retries a connection failure (the POST never returned)", async () => {
      let n = 0;
      const { fetchImpl, calls } = fakeFetch(() => {
        n += 1;
        if (n === 1) throw new TypeError("fetch failed");
        return streamOk(serializeResultFrame(turn, "m"));
      });
      const frames = await drain(retryClient(fetchImpl, [0]));
      expect(frames).toEqual([{ kind: "result", turn, modelRef: "m", costMicros: 0 }]);
      expect(calls).toHaveLength(2);
    });

    it("retries a mid-stream drop that relayed only heartbeats (the observed failure)", async () => {
      let n = 0;
      const { fetchImpl, calls } = fakeFetch(() => {
        n += 1;
        return n < 2
          ? streamThenDrop([serializeHeartbeatFrame(), serializeHeartbeatFrame()])
          : streamOk(serializeResultFrame(turn, "m"));
      });
      const frames = await drain(retryClient(fetchImpl, [0, 0]));
      // The aborted attempt's pings are no-ops; the re-POST delivered the real result.
      expect(frames.filter((f) => f.kind === "result")).toEqual([
        { kind: "result", turn, modelRef: "m", costMicros: 0 },
      ]);
      expect(calls).toHaveLength(2);
    });

    it("does NOT retry once a content frame (delta) has been relayed — no duplicate output", async () => {
      const { fetchImpl, calls } = fakeFetch(() =>
        streamThenDrop([serializeDeltaFrame("partial")]),
      );
      const seen: InferenceFrame[] = [];
      await expect(
        (async () => {
          for await (const f of retryClient(fetchImpl, [0, 0]).streamInference({
            model: "a",
            provider: "b",
            messages: [],
            tools: [],
          })) {
            seen.push(f);
          }
        })(),
      ).rejects.toThrow(/terminated/);
      expect(seen).toEqual([{ kind: "delta", text: "partial" }]); // relayed exactly once
      expect(calls).toHaveLength(1); // NOT retried
    });

    it("exhausts the schedule on a persistent pre-stream 503", async () => {
      const { fetchImpl, calls } = fakeFetch(() => json(503, { error: "still rolling" }));
      await expect(drain(retryClient(fetchImpl, [0, 0]))).rejects.toThrow();
      expect(calls).toHaveLength(3); // first attempt + two retries
    });
  });
});
