import { describe, it, expect } from "vitest";
import * as os from "node:os";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { create as tarCreate } from "tar";
import {
  WorkspaceStore,
  WORKSPACE_SNAPSHOT_MAX_BYTES,
  TarWorkspaceArchiver,
  resolvePersistSelection,
  type PersistSelection,
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
  archives: { dir: string; dest: string; paths?: readonly string[] | undefined }[];
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
    /** Workspace-relative paths the fake fs reports as ABSENT (a declared-but-never-written dir). */
    absentPaths?: readonly string[];
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
    archive: (dir, dest, paths) => {
      if (over.archiveThrows === true) return Promise.reject(new Error("tar failed"));
      archives.push({ dir, dest, paths });
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
    // Every declared dir exists unless a test says otherwise.
    exists: (path) => Promise.resolve(!(over.absentPaths ?? []).some((p) => path.endsWith(p))),
  };
  return { broker, archiver, fs, uploads, downloads, extracts, archives, writes, rms };
}

/** `selection` defaults to `true` (persist the whole workspace) — the form these tests predate the
 *  list for, and the only one the store used to support. */
function store(r: Recorder, selection: PersistSelection = true): WorkspaceStore {
  return new WorkspaceStore({
    broker: r.broker,
    archiver: r.archiver,
    fs: r.fs,
    workspaceRoot: "/workspace",
    tmpPath: "/tmp/ws.tgz",
    selection: () => selection,
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
      selection: () => true,
    });
    expect(await s.persist()).toBe(0);
    expect(r.uploads).toEqual([]);
  });
});

describe("WorkspaceStore default scratch path", () => {
  it("defaults the tarball under os.tmpdir() (per-run TMPDIR), not machine-global /tmp", async () => {
    const r = recorder();
    const s = new WorkspaceStore({
      broker: r.broker,
      archiver: r.archiver,
      fs: r.fs,
      workspaceRoot: "/workspace",
      selection: () => true,
      // no tmpPath → default
    });
    await s.persist();
    const dest = r.archives[0]?.dest ?? "";
    // Lands inside os.tmpdir() (honors TMPDIR on a self-hosted runner), NOT the old shared constant.
    expect(dest.startsWith(os.tmpdir())).toBe(true);
    expect(dest).not.toBe("/tmp/workspace-snapshot.tgz");
  });
});

describe("TarWorkspaceArchiver (real tar) — extraction hardening", () => {
  it("round-trips a nested tree", async () => {
    const src = await mkdtemp(path.join(os.tmpdir(), "bw-arc-src-"));
    await mkdir(path.join(src, "sub"), { recursive: true });
    await writeFile(path.join(src, "sub", "a.txt"), "hello");
    const archiver = new TarWorkspaceArchiver();
    const tgz = path.join(os.tmpdir(), `bw-arc-${path.basename(src)}.tgz`);
    await archiver.archive(src, tgz);
    const out = await mkdtemp(path.join(os.tmpdir(), "bw-arc-out-"));
    await archiver.extract(tgz, out);
    expect(await readFile(path.join(out, "sub", "a.txt"), "utf8")).toBe("hello");
    await rm(src, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
    await rm(tgz, { force: true });
  });

  it("does NOT let a `..` member escape the extraction dir", async () => {
    // Forge a malicious tarball whose member path is literally `../escape.txt`: stage a file in the
    // PARENT of `inner`, then create the archive from cwd=inner naming `../escape.txt`, with
    // preservePaths:true so node-tar's create keeps the traversal in the recorded entry name.
    const stage = await mkdtemp(path.join(os.tmpdir(), "bw-arc-mal-"));
    const inner = path.join(stage, "inner");
    await mkdir(inner, { recursive: true });
    await writeFile(path.join(stage, "escape.txt"), "pwned");
    const tgz = path.join(os.tmpdir(), `bw-arc-mal-${path.basename(stage)}.tgz`);
    await tarCreate({ file: tgz, cwd: inner, gzip: true, preservePaths: true }, ["../escape.txt"]);

    // Extract into a nested target with the archiver under test.
    const parent = await mkdtemp(path.join(os.tmpdir(), "bw-arc-parent-"));
    const target = path.join(parent, "run", "workspace");
    await new TarWorkspaceArchiver().extract(tgz, target);

    // node-tar (preservePaths:false on extract) strips the `..`, so nothing lands in target's parent.
    expect(existsSync(path.join(parent, "escape.txt"))).toBe(false);
    expect(existsSync(path.join(parent, "run", "escape.txt"))).toBe(false);

    await rm(stage, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
    await rm(tgz, { force: true });
  });
});

// The selection is the half of the contract the hosted runner never implemented: the SDK validates
// and documents `persist: ["cache"]`, the engine honors it, and the runner dropped it on the floor
// at a `=== true` construction gate — so a workflow that declared a list persisted NOTHING, silently.
// Memory dirs are the same defect from the other side: undeclared by design, so a manifest-shaped
// gate could never see them. See docs/WORKSPACE_PERSISTENCE.md §3 + §8.
describe("resolvePersistSelection", () => {
  it("persists nothing when nothing is declared and no memory was used", () => {
    expect(resolvePersistSelection(undefined, new Set())).toEqual([]);
    expect(resolvePersistSelection(false, new Set())).toEqual([]);
  });

  it("persists the declared list", () => {
    expect(resolvePersistSelection(["cache", "index"], new Set())).toEqual(["cache", "index"]);
  });

  it("persists a memory dir with NO declaration at all (memory is undeclared by design)", () => {
    expect(resolvePersistSelection(undefined, new Set(["triager"]))).toEqual(["triager"]);
  });

  it("unions the declared list with the run's memory dirs, deduplicated", () => {
    expect(resolvePersistSelection(["cache", "triager"], new Set(["triager", "notes"]))).toEqual([
      "cache",
      "triager",
      "notes",
    ]);
  });

  it("lets `true` swallow the list — the whole workspace already contains every memory dir", () => {
    expect(resolvePersistSelection(true, new Set(["triager"]))).toBe(true);
  });
});

describe("WorkspaceStore.persist — honoring the selection", () => {
  it("archives the WHOLE workspace for `true` (no member list)", async () => {
    const r = recorder();
    await store(r, true).persist();
    expect(r.archives).toEqual([{ dir: "/workspace", dest: "/tmp/ws.tgz", paths: undefined }]);
  });

  it("archives ONLY the selected dirs for a list", async () => {
    const r = recorder();
    await store(r, ["cache", "memory/triager"]).persist();
    expect(r.archives[0]?.paths).toEqual(["cache", "memory/triager"]);
  });

  it("does no fs, tar, or broker work at all when nothing is selected", async () => {
    const r = recorder();
    expect(await store(r, []).persist()).toBe(0);
    expect(r.archives).toEqual([]);
    expect(r.uploads).toEqual([]);
    // The common case (a workflow using no persistence) must cost a run precisely nothing.
    expect(r.writes).toEqual([]);
  });

  it("drops a declared-but-never-written dir rather than failing the whole archive", async () => {
    // `tar` fails the entire archive on one missing member, and declaring `["cache", "index"]` while
    // only ever writing `cache` is ordinary — so the absent member is filtered, not fatal.
    const r = recorder({ absentPaths: ["index"] });
    await store(r, ["cache", "index"]).persist();
    expect(r.archives[0]?.paths).toEqual(["cache"]);
  });

  it("skips the upload when every selected dir is absent", async () => {
    const r = recorder({ absentPaths: ["cache"] });
    expect(await store(r, ["cache"]).persist()).toBe(0);
    expect(r.uploads).toEqual([]);
  });
});
