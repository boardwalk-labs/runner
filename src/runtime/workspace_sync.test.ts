import { describe, it, expect } from "vitest";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import {
  WorkspaceSync,
  type WorkspaceBackend,
  type WorkspaceSyncFs,
  type PackCodec,
  type ManifestWriteResult,
  type WorkspaceReservation,
} from "./workspace_sync.js";
import { packDigest, parseWorkspaceManifest, TARGET_PACK_BYTES } from "./workspace_format.js";
import type { WorkspaceWalkEntry } from "./workspace_format.js";

// ============================================================================
// Fakes — the contract every real backend must also satisfy
// ============================================================================

/** In-memory store with real generation semantics, so conditional-write behaviour is exercised. */
class FakeBackend implements WorkspaceBackend {
  manifest: Uint8Array | null = null;
  private gen = 0;
  packs = new Map<string, Uint8Array>();
  reservation: WorkspaceReservation = { ok: true };
  /** Force this many conditional writes to report a conflict before succeeding. */
  conflictsToInject = 0;
  uploaded: string[] = [];
  deleted: string[] = [];
  reserved: number[] = [];

  reserve(totalBytes: number): Promise<WorkspaceReservation> {
    this.reserved.push(totalBytes);
    return Promise.resolve(this.reservation);
  }

  readManifest(): Promise<{ bytes: Uint8Array | null; generation: string | null }> {
    return Promise.resolve({
      bytes: this.manifest,
      generation: this.manifest === null ? null : String(this.gen),
    });
  }

  writeManifest(bytes: Uint8Array, expected: string | null): Promise<ManifestWriteResult> {
    if (this.conflictsToInject > 0) {
      this.conflictsToInject -= 1;
      return Promise.resolve({ ok: false, conflict: true });
    }
    const current = this.manifest === null ? null : String(this.gen);
    if (current !== expected) return Promise.resolve({ ok: false, conflict: true });
    this.manifest = bytes;
    this.gen += 1;
    return Promise.resolve({ ok: true, generation: String(this.gen) });
  }

  existingPacks(digests: readonly string[]): Promise<ReadonlySet<string>> {
    return Promise.resolve(new Set(digests.filter((d) => this.packs.has(d))));
  }

  writePack(digest: string, bytes: Uint8Array): Promise<void> {
    this.uploaded.push(digest);
    this.packs.set(digest, bytes);
    return Promise.resolve();
  }

  readPack(digest: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.packs.get(digest) ?? null);
  }

  deletePacks(digests: readonly string[]): Promise<void> {
    for (const d of digests) {
      this.deleted.push(d);
      this.packs.delete(d);
    }
    return Promise.resolve();
  }
}

class FakeFs implements WorkspaceSyncFs {
  files = new Map<string, { data: Uint8Array; mtime: number }>();

  set(path: string, text: string, mtime: number): void {
    this.files.set(path, { data: new TextEncoder().encode(text), mtime });
  }

  text(path: string): string | undefined {
    const f = this.files.get(path);
    return f === undefined ? undefined : new TextDecoder().decode(f.data);
  }

  walk(_root: string, paths: readonly string[] | undefined): Promise<WorkspaceWalkEntry[]> {
    const out: WorkspaceWalkEntry[] = [];
    for (const [p, f] of this.files) {
      if (paths !== undefined && !paths.some((dir) => p === dir || p.startsWith(`${dir}/`)))
        continue;
      out.push({ p, s: f.data.length, m: f.mtime });
    }
    return Promise.resolve(out);
  }

  readFile(_root: string, relPath: string): Promise<Uint8Array> {
    const f = this.files.get(relPath);
    if (f === undefined) throw new Error(`missing ${relPath}`);
    return Promise.resolve(f.data);
  }

  writeUnder(_root: string, relPath: string, data: Uint8Array, mtimeMs: number): Promise<void> {
    this.files.set(relPath, { data: new Uint8Array(data), mtime: mtimeMs });
    return Promise.resolve();
  }
}

/** Identity codec, so framing is asserted independently of compression. */
const identity: PackCodec = {
  compress: (b) => Promise.resolve(b),
  decompress: (b) => Promise.resolve(b),
};

const zstd: PackCodec = {
  compress: (b) => Promise.resolve(new Uint8Array(zstdCompressSync(b))),
  decompress: (b) => Promise.resolve(new Uint8Array(zstdDecompressSync(b))),
};

const sync = (backend: WorkspaceBackend, fs: WorkspaceSyncFs, codec: PackCodec = identity) =>
  new WorkspaceSync({ backend, fs, codec, workspaceRoot: "/workspace" });

const storedFiles = (backend: FakeBackend): string[] => {
  if (backend.manifest === null) return [];
  return (parseWorkspaceManifest(backend.manifest)?.files ?? []).map((f) => f.p);
};

// ============================================================================

describe("hydrate", () => {
  it("restores nothing when the scope has never been written", async () => {
    const backend = new FakeBackend();
    const fs = new FakeFs();
    expect(await sync(backend, fs).hydrate()).toEqual({ files: 0, packs: 0 });
  });

  it("round-trips content and restores the recorded mtime", async () => {
    // The mtime matters: without it every restored file looks new to the next diff and the whole
    // workspace re-uploads on every run.
    const backend = new FakeBackend();
    const writer = new FakeFs();
    writer.set("a.txt", "hello", 111);
    writer.set("dir/b.txt", "world", 222);
    await sync(backend, writer).persist(undefined);

    const reader = new FakeFs();
    const result = await sync(backend, reader).hydrate();
    expect(result.files).toBe(2);
    expect(reader.text("a.txt")).toBe("hello");
    expect(reader.text("dir/b.txt")).toBe("world");
    expect(reader.files.get("a.txt")?.mtime).toBe(111);
  });

  it("round-trips through real zstd", async () => {
    const backend = new FakeBackend();
    const writer = new FakeFs();
    writer.set("a.txt", "x".repeat(10_000), 1);
    await sync(backend, writer, zstd).persist(undefined);

    const reader = new FakeFs();
    await sync(backend, reader, zstd).hydrate();
    expect(reader.text("a.txt")).toBe("x".repeat(10_000));
  });

  it("treats an EMPTY manifest as a restored state and does not resurrect deleted files", async () => {
    const backend = new FakeBackend();
    const fs = new FakeFs();
    fs.set("gone.txt", "x", 1);
    const first = sync(backend, fs);
    await first.persist(undefined);
    fs.files.delete("gone.txt");
    await first.persist(undefined);
    expect(storedFiles(backend)).toEqual([]);

    const next = new FakeFs();
    const s = sync(backend, next);
    await s.hydrate();
    await s.persist(undefined);
    expect(storedFiles(backend)).toEqual([]);
  });

  it("fails loudly on a corrupted pack instead of restoring a plausible tree", async () => {
    const backend = new FakeBackend();
    const writer = new FakeFs();
    writer.set("a.txt", "hello", 1);
    await sync(backend, writer).persist(undefined);
    const digest = [...backend.packs.keys()][0] ?? "";
    backend.packs.set(digest, new TextEncoder().encode("tampered"));

    const reader = new FakeFs();
    const s = sync(backend, reader);
    await s.hydrate();
    expect(s.disarmedReason).toMatch(/integrity check/);
  });

  it("fails loudly when a referenced pack is missing", async () => {
    const backend = new FakeBackend();
    const writer = new FakeFs();
    writer.set("a.txt", "hello", 1);
    await sync(backend, writer).persist(undefined);
    backend.packs.clear();

    const s = sync(backend, new FakeFs());
    await s.hydrate();
    expect(s.disarmedReason).toMatch(/missing/);
  });

  it("disarms persist after a partial restore so a broken tree can't overwrite good state", async () => {
    const backend = new FakeBackend();
    const writer = new FakeFs();
    writer.set("a.txt", "hello", 1);
    await sync(backend, writer).persist(undefined);
    const before = backend.manifest;
    backend.packs.clear();

    const reader = new FakeFs();
    const s = sync(backend, reader);
    await s.hydrate();
    const outcome = await s.persist(undefined);
    expect(outcome.skipped?.reason).toBe("error");
    expect(backend.manifest).toBe(before); // untouched
  });
});

describe("persist", () => {
  it("stores everything on a first persist", async () => {
    const backend = new FakeBackend();
    const fs = new FakeFs();
    fs.set("a.txt", "one", 1);
    fs.set("b.txt", "two", 2);
    const outcome = await sync(backend, fs).persist(undefined);
    expect(outcome.skipped).toBeUndefined();
    expect(storedFiles(backend)).toEqual(["a.txt", "b.txt"]);
    expect(outcome.bytes).toBe(6);
  });

  it("writes nothing at all when nothing changed", async () => {
    const backend = new FakeBackend();
    const fs = new FakeFs();
    fs.set("a.txt", "one", 1);
    const s = sync(backend, fs);
    await s.persist(undefined);
    const uploadsBefore = backend.uploaded.length;
    await s.persist(undefined);
    expect(backend.uploaded.length).toBe(uploadsBefore);
    expect(backend.reserved).toHaveLength(1); // second persist didn't even reserve
  });

  it("uploads only a pack for the changed file, leaving the other file's pack alone", async () => {
    // The property that makes a long loop cheap: an agent appending one line per iteration must not
    // re-upload the pack that its large untouched file lives in.
    const backend = new FakeBackend();
    const fs = new FakeFs();
    fs.set("big.bin", "B".repeat(200_000), 1);
    fs.set("log.txt", "line", 1);
    const s = sync(backend, fs);
    await s.persist(undefined);
    const packsAfterFirst = new Set(backend.packs.keys());

    fs.set("log.txt", "line\nline2", 2);
    const outcome = await s.persist(undefined);

    expect(outcome.packsWritten).toBe(1);
    // The original pack survives because `big.bin` still points into it.
    const still = [...backend.packs.keys()].filter((d) => packsAfterFirst.has(d));
    expect(still.length).toBeGreaterThan(0);
    expect(storedFiles(backend)).toEqual(["big.bin", "log.txt"]);
  });

  it("removes a deleted path and reclaims the pack nothing points into", async () => {
    const backend = new FakeBackend();
    const fs = new FakeFs();
    fs.set("keep.txt", "k", 1);
    const s = sync(backend, fs);
    await s.persist(undefined);
    fs.set("temp.txt", "t", 2);
    await s.persist(undefined);

    fs.files.delete("temp.txt");
    await s.persist(undefined);
    expect(storedFiles(backend)).toEqual(["keep.txt"]);
    expect(backend.deleted.length).toBeGreaterThan(0);
  });

  it("honors a narrowed selection", async () => {
    const backend = new FakeBackend();
    const fs = new FakeFs();
    fs.set("cache/x", "x", 1);
    fs.set("scratch/y", "y", 1);
    await sync(backend, fs).persist(["cache"]);
    expect(storedFiles(backend)).toEqual(["cache/x"]);
  });

  it("skips a re-upload when the store already holds that exact pack", async () => {
    const backend = new FakeBackend();
    const fs = new FakeFs();
    fs.set("a.txt", "same", 1);
    await sync(backend, fs).persist(undefined);
    backend.uploaded = [];

    // A fresh run with identical content: the digests already exist, so nothing moves.
    await sync(backend, fs).persist(undefined);
    expect(backend.uploaded).toEqual([]);
  });
});

describe("refusals are reported, never silent", () => {
  it("reports a storage-limit refusal and uploads nothing", async () => {
    const backend = new FakeBackend();
    backend.reservation = { ok: false, reason: "storage_limit", maxBytes: 10 };
    const fs = new FakeFs();
    fs.set("a.txt", "hello", 1);
    const outcome = await sync(backend, fs).persist(undefined);
    expect(outcome.skipped).toEqual({ reason: "storage_limit", maxBytes: 10 });
    expect(backend.uploaded).toEqual([]);
  });

  it("reports not_eligible distinctly from a refusal", async () => {
    const backend = new FakeBackend();
    backend.reservation = { ok: false, reason: "not_eligible" };
    const fs = new FakeFs();
    fs.set("a.txt", "hello", 1);
    const outcome = await sync(backend, fs).persist(undefined);
    expect(outcome.skipped?.reason).toBe("not_eligible");
  });

  it("reports too_large before reserving anything", async () => {
    const backend = new FakeBackend();
    const fs = new FakeFs();
    fs.set("a.txt", "hello", 1);
    const s = new WorkspaceSync({
      backend,
      fs,
      codec: identity,
      workspaceRoot: "/workspace",
      maxScopeBytes: 2,
    });
    const outcome = await s.persist(undefined);
    expect(outcome.skipped?.reason).toBe("too_large");
    expect(backend.reserved).toEqual([]);
  });

  it("reports an fs failure rather than throwing into the run", async () => {
    const backend = new FakeBackend();
    const fs = new FakeFs();
    fs.walk = () => Promise.reject(new Error("disk gone"));
    const outcome = await sync(backend, fs).persist(undefined);
    expect(outcome.skipped).toEqual({ reason: "error", detail: "disk gone" });
  });
});

describe("concurrent runs (§6)", () => {
  it("does not delete a file created by a concurrent run", async () => {
    // A and B share a scope. B is not in A's baseline at all, so A must not treat B's file as its
    // own deletion — the exact failure the three-way merge exists to prevent.
    const backend = new FakeBackend();
    const fsA = new FakeFs();
    fsA.set("a.txt", "from-a", 1);
    const a = sync(backend, fsA);
    await a.persist(undefined);

    const fsB = new FakeFs();
    const b = sync(backend, fsB);
    await b.hydrate();
    fsB.set("b.txt", "from-b", 2);
    await b.persist(undefined);
    expect(storedFiles(backend)).toEqual(["a.txt", "b.txt"]);

    // A persists again, having never seen b.txt.
    fsA.set("a.txt", "from-a-v2", 3);
    await a.persist(undefined);
    expect(storedFiles(backend)).toEqual(["a.txt", "b.txt"]);
  });

  it("still deletes a path the run genuinely removed", async () => {
    const backend = new FakeBackend();
    const fs = new FakeFs();
    fs.set("mine.txt", "m", 1);
    const s = sync(backend, fs);
    await s.persist(undefined);
    fs.files.delete("mine.txt");
    await s.persist(undefined);
    expect(storedFiles(backend)).toEqual([]);
  });

  it("reports a genuine same-path collision", async () => {
    const backend = new FakeBackend();
    const fsA = new FakeFs();
    fsA.set("x.txt", "a1", 1);
    const a = sync(backend, fsA);
    await a.persist(undefined);

    const fsB = new FakeFs();
    const b = sync(backend, fsB);
    await b.hydrate();
    fsB.set("x.txt", "b1", 2);
    await b.persist(undefined);

    fsA.set("x.txt", "a2", 3);
    const outcome = await a.persist(undefined);
    expect(outcome.conflicts).toEqual([{ path: "x.txt", ours: "wrote" }]);
  });

  it("retries a conflicting manifest write without re-uploading packs", async () => {
    const backend = new FakeBackend();
    const fs = new FakeFs();
    fs.set("a.txt", "hello", 1);
    backend.conflictsToInject = 2;
    const outcome = await sync(backend, fs).persist(undefined);
    expect(outcome.skipped).toBeUndefined();
    expect(backend.uploaded).toHaveLength(1); // uploaded once, merged three times
    expect(storedFiles(backend)).toEqual(["a.txt"]);
  });

  it("gives up rather than clobbering when conflicts never clear", async () => {
    const backend = new FakeBackend();
    const fs = new FakeFs();
    fs.set("a.txt", "hello", 1);
    backend.conflictsToInject = 999;
    const outcome = await sync(backend, fs).persist(undefined);
    expect(outcome.skipped?.reason).toBe("error");
    expect(backend.manifest).toBeNull();
  });

  it("a run that persisted a merge does not then delete the other run's files", async () => {
    // Regression guard for the subtle one: adopting the MERGED manifest as our baseline would put
    // paths we never had on disk into it, so the next diff would report them as our deletions.
    const backend = new FakeBackend();
    const fsA = new FakeFs();
    fsA.set("a.txt", "a", 1);
    const a = sync(backend, fsA);
    await a.persist(undefined);

    const fsB = new FakeFs();
    const b = sync(backend, fsB);
    await b.hydrate();
    fsB.set("b.txt", "b", 2);
    await b.persist(undefined);

    fsA.set("a.txt", "a2", 3);
    await a.persist(undefined); // A merges, picking up b.txt into the stored manifest
    fsA.set("a.txt", "a3", 4);
    await a.persist(undefined); // ...and must STILL not claim b.txt as its own deletion
    expect(storedFiles(backend)).toEqual(["a.txt", "b.txt"]);
  });
});

describe("repack", () => {
  it("reclaims dead bytes once the live fraction drops", async () => {
    const backend = new FakeBackend();
    const fs = new FakeFs();
    const big = "B".repeat(TARGET_PACK_BYTES);
    fs.set("churn.bin", big, 1);
    const s = sync(backend, fs);
    await s.persist(undefined);

    // Rewrite the same file repeatedly. Append-only packing leaves each previous copy dead, but its
    // pack is dropped as soon as nothing points into it, so the scope stays tight.
    for (let i = 2; i < 5; i++) {
      fs.set("churn.bin", "C".repeat(TARGET_PACK_BYTES), i);
      await s.persist(undefined);
    }
    const stored = parseWorkspaceManifest(backend.manifest ?? new Uint8Array());
    expect(stored?.files).toHaveLength(1);
    expect(stored?.packs).toHaveLength(1);
  });

  it("reports when a repack fires", async () => {
    const backend = new FakeBackend();
    const fs = new FakeFs();
    // Many tiny files, each in its own persist, drives the pack COUNT up without any dead bytes.
    const s = sync(backend, fs);
    let fired = false;
    for (let i = 0; i < 20; i++) {
      fs.set(`f${String(i)}.txt`, `v${String(i)}`, i);
      const outcome = await s.persist(undefined);
      if (outcome.repacked) fired = true;
    }
    expect(fired).toBe(true);
    const stored = parseWorkspaceManifest(backend.manifest ?? new Uint8Array());
    expect(stored?.files).toHaveLength(20);
    // After a repack the scope is consolidated rather than one pack per iteration.
    expect(stored?.packs.length).toBeLessThan(20);
  });
});

describe("integrity of stored bytes", () => {
  it("names every pack by the digest of what is actually stored", async () => {
    const backend = new FakeBackend();
    const fs = new FakeFs();
    fs.set("a.txt", "hello", 1);
    await sync(backend, fs, zstd).persist(undefined);
    for (const [digest, bytes] of backend.packs) {
      expect(packDigest(bytes)).toBe(digest);
    }
  });
});
