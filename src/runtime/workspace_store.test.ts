import { describe, it, expect } from "vitest";
import {
  WorkspaceStore,
  WORKSPACE_SNAPSHOT_MAX_BYTES,
  type WorkspaceArchiver,
  type WorkspaceBrokerTransport,
  type WorkspaceFs,
} from "./workspace_store.js";

interface Recorder {
  broker: WorkspaceBrokerTransport;
  archiver: WorkspaceArchiver;
  fs: WorkspaceFs;
  uploads: { url: string; headers: Record<string, string>; bytes: number }[];
  downloads: string[];
  extracts: { src: string; dir: string }[];
  archives: { dir: string; dest: string }[];
  writes: { path: string; bytes: number }[];
  rms: string[];
}

function recorder(
  over: {
    hydrateUrl?: string | null;
    download?: Uint8Array | null;
    persistUrl?: { url: string; contentType: string } | null;
    archiveThrows?: boolean;
    archiveSize?: number;
  } = {},
): Recorder {
  const uploads: Recorder["uploads"] = [];
  const downloads: string[] = [];
  const extracts: Recorder["extracts"] = [];
  const archives: Recorder["archives"] = [];
  const writes: Recorder["writes"] = [];
  const rms: string[] = [];
  const broker: WorkspaceBrokerTransport = {
    workspaceHydrateUrl: () =>
      Promise.resolve(over.hydrateUrl === undefined ? "https://s3/get" : over.hydrateUrl),
    workspacePersistUrl: () =>
      Promise.resolve(
        over.persistUrl === undefined
          ? { url: "https://s3/put", contentType: "application/gzip" }
          : over.persistUrl,
      ),
    uploadBytes: (url, headers, body) => {
      uploads.push({ url, headers, bytes: body.length });
      return Promise.resolve();
    },
    downloadBytes: (url) => {
      downloads.push(url);
      return Promise.resolve(
        over.download === undefined ? new Uint8Array([1, 2, 3]) : over.download,
      );
    },
  };
  const archiver: WorkspaceArchiver = {
    archive: (dir, dest) => {
      if (over.archiveThrows === true) return Promise.reject(new Error("tar failed"));
      archives.push({ dir, dest });
      return Promise.resolve(over.archiveSize ?? 42);
    },
    extract: (src, dir) => {
      extracts.push({ src, dir });
      return Promise.resolve();
    },
  };
  const fs: WorkspaceFs = {
    readFile: () => Promise.resolve(new Uint8Array([9, 9, 9, 9])),
    writeFile: (path, data) => {
      writes.push({ path, bytes: data.length });
      return Promise.resolve();
    },
    rm: (path) => {
      rms.push(path);
      return Promise.resolve();
    },
  };
  return { broker, archiver, fs, uploads, downloads, extracts, archives, writes, rms };
}

function store(r: Recorder): WorkspaceStore {
  return new WorkspaceStore({
    broker: r.broker,
    archiver: r.archiver,
    fs: r.fs,
    workspaceRoot: "/workspace",
    tmpPath: "/tmp/ws.tgz",
  });
}

describe("WorkspaceStore.hydrate", () => {
  it("downloads the snapshot and extracts it into the workspace root", async () => {
    const r = recorder();
    await store(r).hydrate();
    expect(r.downloads).toEqual(["https://s3/get"]);
    expect(r.writes).toEqual([{ path: "/tmp/ws.tgz", bytes: 3 }]);
    expect(r.extracts).toEqual([{ src: "/tmp/ws.tgz", dir: "/workspace" }]);
    expect(r.rms).toEqual(["/tmp/ws.tgz"]);
  });

  it("no-ops when the run isn't eligible (null hydrate URL)", async () => {
    const r = recorder({ hydrateUrl: null });
    await store(r).hydrate();
    expect(r.downloads).toEqual([]);
    expect(r.extracts).toEqual([]);
  });

  it("no-ops when there's no snapshot yet (download 404 → null)", async () => {
    const r = recorder({ download: null });
    await store(r).hydrate();
    expect(r.downloads).toHaveLength(1);
    expect(r.extracts).toEqual([]); // nothing to extract
  });
});

describe("WorkspaceStore.persist", () => {
  it("archives the workspace and uploads it with the pinned content type", async () => {
    const r = recorder();
    expect(await store(r).persist()).toBe(42); // returns the snapshot byte size
    expect(r.archives).toEqual([{ dir: "/workspace", dest: "/tmp/ws.tgz" }]);
    expect(r.uploads).toEqual([
      { url: "https://s3/put", headers: { "content-type": "application/gzip" }, bytes: 4 },
    ]);
    expect(r.rms).toEqual(["/tmp/ws.tgz"]);
  });

  it("no-ops when the run isn't eligible (null persist URL), returning 0 bytes", async () => {
    const r = recorder({ persistUrl: null });
    expect(await store(r).persist()).toBe(0);
    // The archive is built BEFORE the presign (its size travels on the request), then discarded when
    // the URL comes back null (e.g. self-hosted) — so it's archived + cleaned up, but never uploaded.
    expect(r.archives).toEqual([{ dir: "/workspace", dest: "/tmp/ws.tgz" }]);
    expect(r.uploads).toEqual([]);
    expect(r.rms).toEqual(["/tmp/ws.tgz"]);
  });

  it("is best-effort: a failure (e.g. tar throws) is swallowed, returning 0", async () => {
    const r = recorder({ archiveThrows: true });
    await expect(store(r).persist()).resolves.toBe(0);
    expect(r.uploads).toEqual([]);
  });

  it("skips (no upload) when the snapshot exceeds the size cap, cleaning up the tarball", async () => {
    const r = recorder({ archiveSize: WORKSPACE_SNAPSHOT_MAX_BYTES + 1 });
    expect(await store(r).persist()).toBe(0);
    expect(r.archives).toEqual([{ dir: "/workspace", dest: "/tmp/ws.tgz" }]); // archived...
    expect(r.uploads).toEqual([]); // ...but never uploaded
    expect(r.rms).toEqual(["/tmp/ws.tgz"]); // and the scratch tarball is removed
  });

  it("persists a snapshot exactly at the cap (boundary is inclusive)", async () => {
    const r = recorder({ archiveSize: WORKSPACE_SNAPSHOT_MAX_BYTES });
    expect(await store(r).persist()).toBe(WORKSPACE_SNAPSHOT_MAX_BYTES);
    expect(r.uploads).toHaveLength(1);
  });

  it("honors an injected maxSnapshotBytes override", async () => {
    const r = recorder({ archiveSize: 100 });
    const s = new WorkspaceStore({
      broker: r.broker,
      archiver: r.archiver,
      fs: r.fs,
      workspaceRoot: "/workspace",
      tmpPath: "/tmp/ws.tgz",
      maxSnapshotBytes: 50,
    });
    expect(await s.persist()).toBe(0);
    expect(r.uploads).toEqual([]);
  });
});
