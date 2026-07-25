import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { LocalWorkspaceBackend, localScopeDir } from "./local_workspace_backend.js";
import { NodeWorkspaceFs } from "./node_workspace_fs.js";
import { WorkspaceSync, type PackCodec, type WorkspaceBackend } from "./workspace_sync.js";
import { parseWorkspaceManifest } from "./workspace_format.js";

const zstd: PackCodec = {
  compress: (b) => Promise.resolve(new Uint8Array(zstdCompressSync(b))),
  decompress: (b) => Promise.resolve(new Uint8Array(zstdDecompressSync(b))),
};

let dir: string;
let scopeDir: string;
let workspace: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bw-ws-"));
  scopeDir = join(dir, "scope");
  workspace = join(dir, "workspace");
  await mkdir(workspace, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const syncFor = (backend: WorkspaceBackend) =>
  new WorkspaceSync({ backend, fs: new NodeWorkspaceFs(), codec: zstd, workspaceRoot: workspace });

const write = async (rel: string, text: string): Promise<void> => {
  const target = join(workspace, rel);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, text);
};

const read = async (rel: string): Promise<string> => await readFile(join(workspace, rel), "utf8");

const storedManifest = async () => {
  const bytes = await readFile(join(scopeDir, "manifest.json"));
  return parseWorkspaceManifest(new Uint8Array(bytes));
};

describe("localScopeDir", () => {
  it("separates base, environment, and key scopes", () => {
    expect(localScopeDir("/p", "wf", null, null)).toBe("/p/wf/_base");
    expect(localScopeDir("/p", "wf", "env1", null)).toBe("/p/wf/env1");
    expect(localScopeDir("/p", "wf", null, "acme")).toBe("/p/wf/_base/keys/acme");
  });
});

describe("round trip on real disk", () => {
  it("persists and hydrates content, directory structure, and mtimes", async () => {
    await write("notes.md", "hello");
    await write("cache/data.json", '{"a":1}');
    const out = await syncFor(new LocalWorkspaceBackend(scopeDir)).persist(undefined);
    expect(out.skipped).toBeUndefined();

    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    const result = await syncFor(new LocalWorkspaceBackend(scopeDir)).hydrate();

    expect(result.files).toBe(2);
    expect(await read("notes.md")).toBe("hello");
    expect(await read("cache/data.json")).toBe('{"a":1}');
  });

  it("a restored file is seen as UNCHANGED by the next diff", async () => {
    // If mtimes weren't restored, every run would re-upload the whole workspace and the incremental
    // property would only ever apply within a single run.
    await write("a.txt", "x");
    await syncFor(new LocalWorkspaceBackend(scopeDir)).persist(undefined);

    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    const s = syncFor(new LocalWorkspaceBackend(scopeDir));
    await s.hydrate();
    const out = await s.persist(undefined);
    expect(out.packsWritten).toBe(0);
  });

  it("persists only the declared selection", async () => {
    await write("cache/keep.txt", "k");
    await write("scratch/drop.txt", "d");
    await syncFor(new LocalWorkspaceBackend(scopeDir)).persist(["cache"]);
    expect((await storedManifest())?.files.map((f) => f.p)).toEqual(["cache/keep.txt"]);
  });

  it("ignores a symlink rather than persisting what it points at", async () => {
    await write("real.txt", "real");
    const secret = join(dir, "outside.txt");
    await writeFile(secret, "secret");
    await symlink(secret, join(workspace, "link.txt"));
    await syncFor(new LocalWorkspaceBackend(scopeDir)).persist(undefined);
    expect((await storedManifest())?.files.map((f) => f.p)).toEqual(["real.txt"]);
  });
});

describe("path 8 — no destructive window", () => {
  it("a crash mid-persist leaves the PREVIOUS scope fully intact", async () => {
    // The old store did `rm -rf scopeDir` then `cp -r`. A crash between them lost everything, and
    // persist runs before every sleep and freeze, so the window opened repeatedly through a long run.
    await write("important.txt", "v1");
    await syncFor(new LocalWorkspaceBackend(scopeDir)).persist(undefined);

    // Now simulate dying partway through the NEXT persist, at the worst moment: after packs are
    // written and before the manifest lands.
    const backend = new LocalWorkspaceBackend(scopeDir);
    const exploding: WorkspaceBackend = {
      reserve: backend.reserve.bind(backend),
      readManifest: backend.readManifest.bind(backend),
      existingPacks: backend.existingPacks.bind(backend),
      writePack: backend.writePack.bind(backend),
      readPack: backend.readPack.bind(backend),
      deletePacks: backend.deletePacks.bind(backend),
      writeManifest: () => Promise.reject(new Error("power loss")),
    };
    await write("important.txt", "v2");
    await write("new.txt", "n");
    const out = await syncFor(exploding).persist(undefined);
    expect(out.skipped?.reason).toBe("error");

    // The previous state is still completely recoverable.
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    await syncFor(new LocalWorkspaceBackend(scopeDir)).hydrate();
    expect(await read("important.txt")).toBe("v1");
  });

  it("a crash before the manifest leaves only unreferenced bytes, never a broken scope", async () => {
    await write("a.txt", "v1");
    await syncFor(new LocalWorkspaceBackend(scopeDir)).persist(undefined);
    const packsBefore = (await readdir(join(scopeDir, "packs"))).length;

    const backend = new LocalWorkspaceBackend(scopeDir);
    const exploding: WorkspaceBackend = Object.create(backend) as WorkspaceBackend;
    exploding.writeManifest = () => Promise.reject(new Error("power loss"));
    await write("a.txt", "v2-longer");
    await syncFor(exploding).persist(undefined);

    // Orphan bytes are acceptable (the next persist's diff reclaims them); a manifest pointing at
    // objects that don't exist would not be.
    expect((await readdir(join(scopeDir, "packs"))).length).toBeGreaterThanOrEqual(packsBefore);
    const manifest = await storedManifest();
    expect(manifest).not.toBeNull();
    for (const pack of manifest?.packs ?? []) {
      await expect(stat(join(scopeDir, "packs", pack.d))).resolves.toBeTruthy();
    }
  });

  it("never leaves a partially written manifest", async () => {
    // Written by temp + rename, so a reader sees the whole previous manifest or the whole new one.
    await write("a.txt", "x".repeat(50_000));
    await syncFor(new LocalWorkspaceBackend(scopeDir)).persist(undefined);
    expect(await storedManifest()).not.toBeNull();
    const leftovers = (await readdir(scopeDir)).filter((n) => n.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("compare-and-swap", () => {
  it("detects a concurrent write instead of silently dropping it", async () => {
    const backend = new LocalWorkspaceBackend(scopeDir);
    await write("a.txt", "x");
    await syncFor(backend).persist(undefined);
    const { generation } = await backend.readManifest();

    // Someone else writes, advancing the generation.
    await new Promise((r) => setTimeout(r, 10));
    const other = await backend.writeManifest(new TextEncoder().encode("{}"), generation);
    expect(other.ok).toBe(true);

    // Our stale generation must now be refused.
    const stale = await backend.writeManifest(new TextEncoder().encode("{}"), generation);
    expect(stale).toEqual({ ok: false, conflict: true });
  });

  it("refuses a first write that expected an existing manifest", async () => {
    const backend = new LocalWorkspaceBackend(scopeDir);
    const result = await backend.writeManifest(new TextEncoder().encode("{}"), "1:1");
    expect(result).toEqual({ ok: false, conflict: true });
  });

  it("two concurrent runs of one workflow both keep their files", async () => {
    // Two runs can share a scope on a single daemon; this is the local mirror of the hosted merge.
    const wsA = join(dir, "wsA");
    const wsB = join(dir, "wsB");
    await mkdir(wsA, { recursive: true });
    await mkdir(wsB, { recursive: true });
    const mk = (root: string) =>
      new WorkspaceSync({
        backend: new LocalWorkspaceBackend(scopeDir),
        fs: new NodeWorkspaceFs(),
        codec: zstd,
        workspaceRoot: root,
      });

    await writeFile(join(wsA, "a.txt"), "a");
    const a = mk(wsA);
    await a.persist(undefined);

    const b = mk(wsB);
    await b.hydrate();
    await writeFile(join(wsB, "b.txt"), "b");
    await b.persist(undefined);

    await writeFile(join(wsA, "a.txt"), "a2");
    await a.persist(undefined);

    expect((await storedManifest())?.files.map((f) => f.p).sort()).toEqual(["a.txt", "b.txt"]);
  });
});

describe("pack storage", () => {
  it("reports a pack it already holds so a retried persist re-uploads nothing", async () => {
    const backend = new LocalWorkspaceBackend(scopeDir);
    await write("a.txt", "hello");
    await syncFor(backend).persist(undefined);
    const digests = await readdir(join(scopeDir, "packs"));
    expect(await backend.existingPacks(digests)).toEqual(new Set(digests));
  });

  it("reads back a missing pack as null rather than throwing", async () => {
    const backend = new LocalWorkspaceBackend(scopeDir);
    expect(await backend.readPack("0".repeat(64))).toBeNull();
  });

  it("deletes idempotently", async () => {
    const backend = new LocalWorkspaceBackend(scopeDir);
    await expect(backend.deletePacks(["0".repeat(64)])).resolves.toBeUndefined();
  });
});
