import { describe, it, expect } from "vitest";
import {
  WorkspaceStore,
  type WorkspaceArchiver,
  type WorkspaceBrokerTransport,
  type WorkspaceFileUrls,
  type WorkspaceFs,
  type WorkspacePersistGrant,
} from "./workspace_store.js";
import {
  serializeWorkspaceManifest,
  WORKSPACE_MANIFEST_VERSION,
  type WorkspaceFileEntry,
} from "./workspace_delta.js";

/** A fake remote scope: per-path objects plus the manifest, as the broker would hold them. */
interface Remote {
  objects: Map<string, Uint8Array>;
  manifest: Uint8Array | null;
}

interface Harness {
  broker: WorkspaceBrokerTransport;
  fs: WorkspaceFs;
  archiver: WorkspaceArchiver;
  remote: Remote;
  /** The local tree the fake fs reports. */
  local: Map<string, WorkspaceFileEntry>;
  /** Files written back to disk by hydrate. */
  written: string[];
  puts: string[];
  deletes: string[];
  manifestGrant: WorkspacePersistGrant | null;
}

function harness(opts: { delta?: boolean } = {}): Harness {
  const delta = opts.delta ?? true;
  const remote: Remote = { objects: new Map(), manifest: null };
  const local = new Map<string, WorkspaceFileEntry>();
  const written: string[] = [];
  const puts: string[] = [];
  const deletes: string[] = [];
  const h: Partial<Harness> = { manifestGrant: null };

  const urlsFor = (op: "put" | "get", paths: readonly string[]): WorkspaceFileUrls => {
    const out: WorkspaceFileUrls = {};
    for (const p of paths) out[p] = `https://s3/${op}/${encodeURIComponent(p)}`;
    return out;
  };

  const base = {
    workspaceHydrateUrl: () => Promise.resolve("https://s3/legacy-get"),
    workspacePersistUrl: () =>
      Promise.resolve<WorkspacePersistGrant>({
        url: "https://s3/legacy-put",
        contentType: "application/gzip",
      }),
    uploadBytes: (url: string, _h: Record<string, string>, body: Uint8Array) => {
      if (url === "https://s3/manifest-put") {
        remote.manifest = body;
      } else if (url.startsWith("https://s3/put/")) {
        const p = decodeURIComponent(url.slice("https://s3/put/".length));
        puts.push(p);
        remote.objects.set(p, body);
      }
      // Anything else is the legacy tarball PUT — not a per-file object.
      return Promise.resolve();
    },
    downloadBytes: (url: string) => {
      if (url === "https://s3/manifest-get") return Promise.resolve(remote.manifest);
      if (url === "https://s3/legacy-get") return Promise.resolve(null);
      const p = decodeURIComponent(url.replace("https://s3/get/", ""));
      return Promise.resolve(remote.objects.get(p) ?? null);
    },
  };

  const deltaOps = {
    workspaceManifestGetUrl: () => Promise.resolve("https://s3/manifest-get"),
    workspaceManifestPutUrl: (): Promise<WorkspacePersistGrant> =>
      Promise.resolve(
        h.manifestGrant ?? { url: "https://s3/manifest-put", contentType: "application/json" },
      ),
    workspaceFileUrls: (op: "put" | "get", paths: readonly string[]) =>
      Promise.resolve(urlsFor(op, paths)),
    workspaceDeleteFiles: (paths: readonly string[]) => {
      for (const p of paths) {
        deletes.push(p);
        remote.objects.delete(p);
      }
      return Promise.resolve();
    },
  };

  const broker: WorkspaceBrokerTransport = delta ? { ...base, ...deltaOps } : base;

  const fs: WorkspaceFs = {
    readFile: (path: string) => Promise.resolve(new TextEncoder().encode(`body:${path}`)),
    writeFile: () => Promise.resolve(),
    rm: () => Promise.resolve(),
    exists: () => Promise.resolve(true),
    walk: () => Promise.resolve([...local.values()]),
    writeUnder: (_root: string, rel: string) => {
      written.push(rel);
      return Promise.resolve();
    },
  };

  const archiver: WorkspaceArchiver = {
    archive: () => Promise.resolve(42),
    extract: () => Promise.resolve(),
  };

  Object.assign(h, { broker, fs, archiver, remote, local, written, puts, deletes });
  return h as Harness;
}

function store(h: Harness): WorkspaceStore {
  return new WorkspaceStore({
    broker: h.broker,
    archiver: h.archiver,
    fs: h.fs,
    workspaceRoot: "/workspace",
    tmpPath: "/tmp/ws.tgz",
    selection: () => true,
    events: { emit: () => undefined },
  });
}

const set = (h: Harness, p: string, s: number, m: number): void => {
  h.local.set(p, { p, s, m });
};

describe("WorkspaceStore delta persist", () => {
  it("uploads every file on a first persist and stores a manifest", async () => {
    const h = harness();
    set(h, "a.txt", 3, 100);
    set(h, "b.txt", 4, 200);
    expect(await store(h).persist()).toBe(7);
    expect(h.puts.sort()).toEqual(["a.txt", "b.txt"]);
    expect(h.remote.manifest).not.toBeNull();
  });

  // The reason this feature exists: persist runs before every sleep and freeze, so an agent that
  // touches one file must not re-upload the other 99.
  it("uploads ONLY the changed file on a later persist", async () => {
    const h = harness();
    set(h, "small.txt", 3, 100);
    set(h, "big.bin", 5_000_000, 200);
    const s = store(h);
    await s.persist();
    h.puts.length = 0;

    set(h, "small.txt", 4, 300); // edited
    expect(await s.persist()).toBe(5_000_004);
    expect(h.puts).toEqual(["small.txt"]);
  });

  it("uploads nothing at all when the tree is unchanged", async () => {
    const h = harness();
    set(h, "a.txt", 3, 100);
    const s = store(h);
    await s.persist();
    const manifestAfterFirst = h.remote.manifest;
    h.puts.length = 0;

    await s.persist();
    expect(h.puts).toEqual([]);
    // Not even the manifest is rewritten — the whole persist is a no-op.
    expect(h.remote.manifest).toBe(manifestAfterFirst);
  });

  it("deletes the remote object for a file the run removed", async () => {
    const h = harness();
    set(h, "keep.txt", 1, 1);
    set(h, "scratch.txt", 1, 1);
    const s = store(h);
    await s.persist();

    h.local.delete("scratch.txt");
    await s.persist();
    expect(h.deletes).toEqual(["scratch.txt"]);
    expect(h.remote.objects.has("scratch.txt")).toBe(false);
    expect(h.remote.objects.has("keep.txt")).toBe(true);
  });

  it("reports a storage-limit refusal and writes nothing", async () => {
    const h = harness();
    set(h, "a.txt", 3, 100);
    h.manifestGrant = { url: null, reason: "storage_limit" };
    const events: unknown[] = [];
    const s = new WorkspaceStore({
      broker: h.broker,
      archiver: h.archiver,
      fs: h.fs,
      workspaceRoot: "/workspace",
      tmpPath: "/tmp/ws.tgz",
      selection: () => true,
      events: { emit: (b) => events.push(b) },
    });
    expect(await s.persist()).toBe(0);
    expect(h.puts).toEqual([]);
    expect(h.remote.manifest).toBeNull();
    expect(events).toEqual([
      { kind: "workspace_persist_skipped", reason: "storage_limit", bytes: 3 },
    ]);
  });

  // An older control plane has no delta endpoints. A runner ahead of it must still persist.
  it("falls back to the whole-tarball path when the broker lacks the seams", async () => {
    const h = harness({ delta: false });
    set(h, "a.txt", 3, 100);
    expect(await store(h).persist()).toBe(42); // the archiver's size — the legacy path ran
    expect(h.puts).toEqual([]);
  });

  // The deploy-order hazard: the client implements these methods, so a runner that reaches a backend
  // without the routes gets a 404. That must cost a full tarball persist, never a lost one.
  it("falls back to the tarball when a delta endpoint throws (404 from an undeployed broker)", async () => {
    const h = harness();
    h.broker.workspaceManifestPutUrl = () => Promise.reject(new Error("404 Not Found"));
    set(h, "a.txt", 3, 100);
    const events: unknown[] = [];
    const s = new WorkspaceStore({
      broker: h.broker,
      archiver: h.archiver,
      fs: h.fs,
      workspaceRoot: "/workspace",
      tmpPath: "/tmp/ws.tgz",
      selection: () => true,
      events: { emit: (b) => events.push(b) },
    });
    expect(await s.persist()).toBe(42); // the tarball ran
    // And it is NOT reported as dropped state — nothing was lost.
    expect(events).toEqual([]);
  });

  it("falls back to the tarball when hydrate's delta path throws", async () => {
    const h = harness();
    h.broker.workspaceManifestGetUrl = () => Promise.reject(new Error("404 Not Found"));
    let extracted = false;
    h.archiver.extract = () => {
      extracted = true;
      return Promise.resolve();
    };
    h.broker.downloadBytes = () => Promise.resolve(new Uint8Array([1, 2, 3]));
    await store(h).hydrate();
    expect(extracted).toBe(true);
  });
});

// The bug this closes, found live on dev 2026-07-25: node-tar aborts a gzip stream past its 1000:1
// maxDecompressionRatio, so a zero-filled or highly repetitive workspace half-extracts. The damage
// was never the bad read — the run's next persist wrote that half-extracted tree back as the new
// stored baseline, making a failed restore permanent.
describe("WorkspaceStore — a partial restore disarms persistence", () => {
  function storeWithEvents(h: Harness, events: unknown[]): WorkspaceStore {
    return new WorkspaceStore({
      broker: h.broker,
      archiver: h.archiver,
      fs: h.fs,
      workspaceRoot: "/workspace",
      tmpPath: "/tmp/ws.tgz",
      selection: () => true,
      events: { emit: (b) => events.push(b) },
    });
  }

  /** A scope with only a legacy tarball, whose extract blows up the way node-tar does. */
  function tarballHarnessWithFailingExtract(): Harness {
    const h = harness();
    h.broker.workspaceManifestGetUrl = () => Promise.resolve(null); // no manifest → tarball path
    h.broker.downloadBytes = () => Promise.resolve(new Uint8Array([1, 2, 3]));
    h.archiver.extract = () =>
      Promise.reject(new Error("TAR_ABORT: max decompression ratio exceeded: 1000.57 > 1000"));
    return h;
  }

  it("does NOT persist after a restore died partway", async () => {
    const h = tarballHarnessWithFailingExtract();
    const events: unknown[] = [];
    const s = storeWithEvents(h, events);
    await s.hydrate();
    set(h, "a.txt", 3, 100);

    // The stored snapshot must survive: keeping it and losing this run's changes is the safe trade.
    expect(await s.persist()).toBe(0);
    expect(h.puts).toEqual([]);
    expect(h.remote.manifest).toBeNull();
  });

  it("tells the author, naming the cause and what it means", async () => {
    const h = tarballHarnessWithFailingExtract();
    const events: { kind?: string; reason?: string; detail?: string }[] = [];
    await storeWithEvents(h, events).hydrate();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("workspace_persist_skipped");
    expect(events[0]?.detail).toContain("TAR_ABORT");
    expect(events[0]?.detail).toContain("will not save");
  });

  it("stays disarmed for EVERY later persist, not just the first", async () => {
    const h = tarballHarnessWithFailingExtract();
    const s = storeWithEvents(h, []);
    await s.hydrate();
    // persist() runs before every sleep and freeze; one of them slipping through would be enough
    // to overwrite the stored snapshot.
    expect(await s.persist()).toBe(0);
    expect(await s.persist()).toBe(0);
    expect(h.puts).toEqual([]);
  });

  it("a restore that merely finds NOTHING leaves persistence armed", async () => {
    const h = harness();
    h.broker.workspaceManifestGetUrl = () => Promise.resolve(null);
    h.broker.downloadBytes = () => Promise.resolve(null); // 404 — first run, nothing stored
    const s = storeWithEvents(h, []);
    await s.hydrate();
    set(h, "a.txt", 3, 100);
    // Nothing was half-written, so this run's state is real and must be saved.
    expect(await s.persist()).toBeGreaterThan(0);
  });
});

describe("WorkspaceStore delta hydrate", () => {
  it("restores every file the manifest lists", async () => {
    const h = harness();
    set(h, "a.txt", 3, 100);
    set(h, "dir/b.txt", 4, 200);
    await store(h).persist();

    const fresh = harness();
    fresh.remote.manifest = h.remote.manifest;
    for (const [k, v] of h.remote.objects) fresh.remote.objects.set(k, v);
    await store(fresh).hydrate();
    expect(fresh.written.sort()).toEqual(["a.txt", "dir/b.txt"]);
  });

  // An emptied scope is a real restorable state. Falling through to the tarball here would restore
  // files the previous run deliberately deleted.
  it("treats an empty manifest as restored, not as missing", async () => {
    const h = harness();
    h.remote.manifest = serializeWorkspaceManifest({ v: WORKSPACE_MANIFEST_VERSION, files: [] });
    await store(h).hydrate();
    expect(h.written).toEqual([]);
  });

  it("falls back to the legacy tarball when the scope has no manifest", async () => {
    const h = harness();
    let extracted = false;
    h.archiver.extract = () => {
      extracted = true;
      return Promise.resolve();
    };
    h.broker.downloadBytes = (url: string) =>
      Promise.resolve(url === "https://s3/manifest-get" ? null : new Uint8Array([1, 2, 3]));
    await store(h).hydrate();
    expect(extracted).toBe(true);
  });

  it("survives an object that vanished — the run re-creates it", async () => {
    const h = harness();
    set(h, "a.txt", 3, 100);
    set(h, "b.txt", 3, 100);
    await store(h).persist();
    h.remote.objects.delete("a.txt");

    const fresh = harness();
    fresh.remote.manifest = h.remote.manifest;
    for (const [k, v] of h.remote.objects) fresh.remote.objects.set(k, v);
    await store(fresh).hydrate();
    expect(fresh.written).toEqual(["b.txt"]);
  });
});
