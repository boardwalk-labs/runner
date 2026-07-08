import { describe, it, expect } from "vitest";
import type { Run } from "./wire/run.js";
import { RunnerControlClient } from "./runner_control_client.js";
import {
  INFERENCE_NDJSON_CONTENT_TYPE,
  serializeDeltaFrame,
  serializeErrorFrame,
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
        messages: [{ role: "user", text: "hello" }],
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
      messages: [{ role: "user", text: "hello" }],
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

describe("RunnerControlClient — durable suspension", () => {
  it("journalGet parses a hit, returns null on a 404 miss", async () => {
    const entry = { seq: 2, kind: "agent", fingerprint: "fp", state: "resolved", result: { x: 1 } };
    const hit = fakeFetch(() => json(200, entry));
    expect(await client(hit.fetchImpl).journalGet(2)).toEqual(entry);
    expect(hit.calls[0]?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/journal/2");
    expect(hit.calls[0]?.method).toBe("GET");

    const miss = fakeFetch(() => new Response(null, { status: 404 }));
    expect(await client(miss.fetchImpl).journalGet(9)).toBeNull();
  });

  it("journalPut POSTs the entry and tolerates 204", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    await client(fetchImpl).journalPut({
      seq: 1,
      kind: "step",
      fingerprint: "fp",
      label: "compute",
      result: { n: 7 },
    });
    expect(calls[0]?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/journal");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
      seq: 1,
      kind: "step",
      label: "compute",
    });
  });

  it("suspend POSTs the signal + workerId", async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    await client(fetchImpl).suspend(
      { reason: "sleep", seq: 3, fingerprint: "fp", durationMs: 60000 },
      "worker-7",
    );
    expect(calls[0]?.url).toBe("https://api.boardwalk.sh/runner/v1/runs/run_1/suspend");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
      reason: "sleep",
      seq: 3,
      durationMs: 60000,
      workerId: "worker-7",
    });
  });

  it("journalSeam() adapts get/put onto the broker methods", async () => {
    const { fetchImpl } = fakeFetch((rec) =>
      rec.method === "GET"
        ? json(200, { seq: 1, kind: "agent", fingerprint: "fp", state: "resolved", result: "ok" })
        : new Response(null, { status: 204 }),
    );
    const seam = client(fetchImpl).journalSeam();
    expect((await seam.get(1))?.result).toBe("ok");
    await seam.put({ seq: 1, kind: "agent", fingerprint: "fp", label: "p", result: "ok" });
  });

  it("claim surfaces lastJournalSeq (replay frontier), defaulting to 0", async () => {
    const withSeq = fakeFetch(() =>
      json(201, { run: fakeRun, leaseUntil: 1, lastEventCursor: 0, lastJournalSeq: 5 }),
    );
    expect((await client(withSeq.fetchImpl).claim("w", 300))?.lastJournalSeq).toBe(5);
    const without = fakeFetch(() => json(201, { run: fakeRun, leaseUntil: 1 }));
    expect((await client(without.fetchImpl).claim("w", 300))?.lastJournalSeq).toBe(0);
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
