import { describe, it, expect } from "vitest";
import {
  makeArtifactsTool,
  type ArtifactsOutput,
  type ArtifactsDeps,
  type ArtifactStore,
  type ArtifactWriteInput,
} from "./artifacts.js";
import { isControlSignal, type ToolContext } from "./types.js";

const NOW = 1_700_000_000_000;

const ctx: ToolContext = {
  auth: { userId: "01H_user", orgId: "01H_org", role: "member", source: "session_jwt" },
  runId: "01H_run",
  secrets: { resolve: () => Promise.reject(new Error("no secrets in artifacts")) },
};

function makeDeps(over?: Partial<ArtifactsDeps>): {
  deps: ArtifactsDeps;
  writes: ArtifactWriteInput[];
  signedFor: { id: string; ttl: number }[];
  listCalls: number[];
} {
  const writes: ArtifactWriteInput[] = [];
  const signedFor: { id: string; ttl: number }[] = [];
  const listCalls: number[] = [];

  const store: ArtifactStore = {
    write: (input) => {
      writes.push(input);
      return Promise.resolve({
        id: "01H_newart",
        name: input.name,
        sizeBytes: 42,
        signedUrl: "https://cdn.boardwalk.sh/01H_newart?sig=abc",
        expiresAt: NOW + 3600 * 1000,
      });
    },
    list: () => {
      listCalls.push(1);
      return Promise.resolve([
        {
          id: "01H_a1",
          name: "a.json",
          contentType: "application/json",
          sizeBytes: 10,
          createdAt: NOW,
        },
        {
          id: "01H_a2",
          name: "b.txt",
          contentType: "text/plain",
          sizeBytes: 20,
          createdAt: NOW + 1,
        },
      ]);
    },
    signedUrl: (artifactId, ttlSeconds) => {
      signedFor.push({ id: artifactId, ttl: ttlSeconds });
      return Promise.resolve({
        signedUrl: `https://cdn.boardwalk.sh/${artifactId}?sig=abc`,
        expiresAt: NOW + ttlSeconds * 1000,
      });
    },
  };

  return { deps: { store, ...over }, writes, signedFor, listCalls };
}

async function run(
  deps: ArtifactsDeps,
  input: Parameters<ReturnType<typeof makeArtifactsTool>["invoke"]>[0],
): Promise<ArtifactsOutput> {
  const out = await makeArtifactsTool(deps).invoke(input, ctx);
  if (isControlSignal(out)) throw new Error("artifacts returned a control signal");
  return out;
}

describe("artifacts — write", () => {
  it("delegates the write to the store and formats the result", async () => {
    const h = makeDeps();
    const out = await run(h.deps, {
      op: "write",
      name: "report.json",
      content_type: "application/json",
      body: '{"ok":true}',
    });

    expect(h.writes).toEqual([
      { name: "report.json", contentType: "application/json", body: '{"ok":true}' },
    ]);
    expect(out.data).toMatchObject({
      op: "write",
      id: "01H_newart",
      name: "report.json",
      sizeBytes: 42,
      signedUrl: expect.stringContaining("cdn.boardwalk.sh"),
    });
    if (out.data.op !== "write") throw new Error("expected write");
    expect(out.data.expiresAt).toBe(NOW + 3600 * 1000);
  });

  it("forwards encoding + metadata to the store", async () => {
    const h = makeDeps();
    await run(h.deps, {
      op: "write",
      name: "blob.bin",
      content_type: "application/octet-stream",
      body: "AAEC/w==",
      encoding: "base64",
      metadata: { branch: "feature-x", resolved: 3 },
    });
    expect(h.writes[0]).toEqual({
      name: "blob.bin",
      contentType: "application/octet-stream",
      body: "AAEC/w==",
      encoding: "base64",
      metadata: { branch: "feature-x", resolved: 3 },
    });
  });
});

describe("artifacts — list", () => {
  it("returns this run's artifacts as summaries", async () => {
    const h = makeDeps();
    const out = await run(h.deps, { op: "list" });
    expect(h.listCalls).toHaveLength(1);
    if (out.data.op !== "list") throw new Error("expected list");
    expect(out.data.artifacts).toEqual([
      {
        id: "01H_a1",
        name: "a.json",
        contentType: "application/json",
        sizeBytes: 10,
        createdAt: NOW,
      },
      { id: "01H_a2", name: "b.txt", contentType: "text/plain", sizeBytes: 20, createdAt: NOW + 1 },
    ]);
  });
});

describe("artifacts — signed_url", () => {
  it("mints a URL with the default TTL", async () => {
    const h = makeDeps();
    const out = await run(h.deps, { op: "signed_url", artifact_id: "01H_a1" });
    expect(h.signedFor).toEqual([{ id: "01H_a1", ttl: 3600 }]);
    if (out.data.op !== "signed_url") throw new Error("expected signed_url");
    expect(out.data.expiresAt).toBe(NOW + 3600 * 1000);
  });

  it("honors an explicit ttl_seconds", async () => {
    const h = makeDeps();
    await run(h.deps, { op: "signed_url", artifact_id: "01H_a1", ttl_seconds: 60 });
    expect(h.signedFor).toEqual([{ id: "01H_a1", ttl: 60 }]);
  });

  it("respects a deps-level defaultTtlSeconds override", async () => {
    const h = makeDeps({ defaultTtlSeconds: 120 });
    await run(h.deps, { op: "signed_url", artifact_id: "01H_a1" });
    expect(h.signedFor).toEqual([{ id: "01H_a1", ttl: 120 }]);
  });
});

describe("artifacts — input validation", () => {
  it("rejects an unknown op", () => {
    expect(() => makeArtifactsTool(makeDeps().deps).inputSchema.parse({ op: "delete" })).toThrow();
  });

  it("rejects a ttl over the 7-day cap", () => {
    expect(() =>
      makeArtifactsTool(makeDeps().deps).inputSchema.parse({
        op: "signed_url",
        artifact_id: "x",
        ttl_seconds: 8 * 24 * 60 * 60,
      }),
    ).toThrow();
  });

  it("rejects an empty artifact name on write", () => {
    expect(() =>
      makeArtifactsTool(makeDeps().deps).inputSchema.parse({
        op: "write",
        name: "",
        content_type: "text/plain",
        body: "x",
      }),
    ).toThrow();
  });
});
