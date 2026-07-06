import { describe, it, expect } from "vitest";
import { BrokerArtifactStore, type ArtifactBrokerTransport } from "./broker_artifact_store.js";
import type {
  ArtifactCommitInput,
  ArtifactPresignInput,
  ArtifactWriteInput,
} from "./tools/artifacts.js";
import { ARTIFACT_PROXY_MAX_BYTES } from "./wire/artifact_storage.js";

interface Upload {
  url: string;
  headers: Record<string, string>;
  byteLength: number;
}

/** Records the order of broker calls so a test can assert commit follows a successful upload. */
type Step = "write" | "presign" | "upload" | "commit";

function transport(): {
  t: ArtifactBrokerTransport;
  writes: ArtifactWriteInput[];
  presigns: ArtifactPresignInput[];
  uploads: Upload[];
  commits: ArtifactCommitInput[];
  signed: { id: string; ttl: number }[];
  lists: number[];
  order: Step[];
} {
  const writes: ArtifactWriteInput[] = [];
  const presigns: ArtifactPresignInput[] = [];
  const uploads: Upload[] = [];
  const commits: ArtifactCommitInput[] = [];
  const signed: { id: string; ttl: number }[] = [];
  const lists: number[] = [];
  const order: Step[] = [];
  const t: ArtifactBrokerTransport = {
    writeArtifact: (input) => {
      order.push("write");
      writes.push(input);
      return Promise.resolve({
        id: "art_proxy",
        name: input.name,
        sizeBytes: 3,
        signedUrl: "https://cdn/x",
        expiresAt: 9,
      });
    },
    presignArtifact: (input) => {
      order.push("presign");
      presigns.push(input);
      return Promise.resolve({
        s3Key: "orgs/o/runs/r/TOKEN.csv",
        uploadUrl: "https://s3/upload?sig=put",
        uploadHeaders: { "content-type": input.contentType },
        expiresAt: 99,
      });
    },
    uploadBytes: (url, headers, body) => {
      order.push("upload");
      uploads.push({ url, headers, byteLength: body.length });
      return Promise.resolve();
    },
    commitArtifact: (input) => {
      order.push("commit");
      commits.push(input);
      return Promise.resolve({
        id: "art_committed",
        name: input.name,
        sizeBytes: input.sizeBytes,
        signedUrl: "https://cdn/big",
        expiresAt: 99,
      });
    },
    listArtifacts: () => {
      lists.push(1);
      return Promise.resolve([
        { id: "a1", name: "a.json", contentType: "application/json", sizeBytes: 1, createdAt: 5 },
      ]);
    },
    signArtifactUrl: (id, ttl) => {
      signed.push({ id, ttl });
      return Promise.resolve({ signedUrl: "https://cdn/y", expiresAt: 7 });
    },
  };
  return { t, writes, presigns, uploads, commits, signed, lists, order };
}

describe("BrokerArtifactStore", () => {
  it("proxies a SMALL write inline through the broker (no presign / upload / commit)", async () => {
    const { t, writes, presigns, uploads, commits } = transport();
    const r = await new BrokerArtifactStore(t).write({
      name: "r.json",
      contentType: "application/json",
      body: "{}",
    });
    expect(writes[0]?.name).toBe("r.json");
    expect(presigns).toHaveLength(0);
    expect(uploads).toHaveLength(0);
    expect(commits).toHaveLength(0);
    expect(r.id).toBe("art_proxy");
  });

  it("routes a LARGE write through presign → direct S3 PUT → commit, in that order", async () => {
    const { t, writes, presigns, uploads, commits, order } = transport();
    const body = "a".repeat(ARTIFACT_PROXY_MAX_BYTES + 1); // utf8 → > proxy ceiling
    const r = await new BrokerArtifactStore(t).write({
      name: "big.csv",
      contentType: "text/csv",
      body,
    });
    expect(writes).toHaveLength(0); // never proxied inline
    // The catalog row is registered (commit) AFTER the bytes land (upload), not before.
    expect(order).toEqual(["presign", "upload", "commit"]);
    expect(presigns[0]).toEqual({
      name: "big.csv",
      contentType: "text/csv",
      sizeBytes: ARTIFACT_PROXY_MAX_BYTES + 1,
    });
    // The bytes go straight to S3 with the broker-supplied (pinned) headers.
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.url).toBe("https://s3/upload?sig=put");
    expect(uploads[0]?.headers).toEqual({ "content-type": "text/csv" });
    expect(uploads[0]?.byteLength).toBe(ARTIFACT_PROXY_MAX_BYTES + 1);
    // Commit echoes the presign's s3Key + the true byte size.
    expect(commits[0]).toMatchObject({
      s3Key: "orgs/o/runs/r/TOKEN.csv",
      name: "big.csv",
      contentType: "text/csv",
      sizeBytes: ARTIFACT_PROXY_MAX_BYTES + 1,
    });
    // The result is shaped from the commit response.
    expect(r.id).toBe("art_committed");
    expect(r.signedUrl).toBe("https://cdn/big");
  });

  it("does NOT commit (no dangling row) when the S3 upload fails", async () => {
    const { t, commits, order } = transport();
    // Make the direct S3 PUT fail (still record that the upload was attempted).
    t.uploadBytes = () => {
      order.push("upload");
      return Promise.reject(new Error("S3 503"));
    };
    await expect(
      new BrokerArtifactStore(t).write({
        name: "big.csv",
        contentType: "text/csv",
        body: "a".repeat(ARTIFACT_PROXY_MAX_BYTES + 1),
      }),
    ).rejects.toThrow(/S3 503/);
    expect(commits).toHaveLength(0); // the row is never registered
    expect(order).toEqual(["presign", "upload"]); // stops before commit
  });

  it("measures the DECODED size for routing (a base64 body under the ceiling still proxies)", async () => {
    const { t, writes, presigns } = transport();
    // A base64 string longer than the ceiling but whose DECODED bytes are tiny → proxy.
    await new BrokerArtifactStore(t).write({
      name: "small.bin",
      contentType: "application/octet-stream",
      body: Buffer.from("hello").toString("base64"),
      encoding: "base64",
    });
    expect(presigns).toHaveLength(0);
    expect(writes).toHaveLength(1);
  });

  it("forwards the write metadata to commit on the large path", async () => {
    const { t, commits } = transport();
    await new BrokerArtifactStore(t).write({
      name: "big.csv",
      contentType: "text/csv",
      body: "a".repeat(ARTIFACT_PROXY_MAX_BYTES + 1),
      metadata: { kind: "report" },
    });
    expect(commits[0]?.metadata).toEqual({ kind: "report" });
  });

  it("forwards list", async () => {
    const { t, lists } = transport();
    const r = await new BrokerArtifactStore(t).list();
    expect(lists).toHaveLength(1);
    expect(r[0]?.id).toBe("a1");
  });

  it("forwards signedUrl with the ttl", async () => {
    const { t, signed } = transport();
    const r = await new BrokerArtifactStore(t).signedUrl("art_1", 300);
    expect(signed).toEqual([{ id: "art_1", ttl: 300 }]);
    expect(r.signedUrl).toBe("https://cdn/y");
  });
});
