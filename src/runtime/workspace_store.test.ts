import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceStore,
  resolvePersistSelection,
  zstdPackCodec,
  type WorkspaceEventSink,
} from "./workspace_store.js";
import { LocalWorkspaceBackend } from "./local_workspace_backend.js";
import type { WorkspaceBackend, WorkspaceReservation } from "./workspace_sync.js";

// ============================================================================
// Selection — the manifest declaration ∪ the run's memory dirs, resolved at PERSIST time
// ============================================================================

describe("resolvePersistSelection", () => {
  it("persists nothing when nothing is declared and no memory was used", () => {
    expect(resolvePersistSelection(undefined, new Set())).toEqual([]);
    expect(resolvePersistSelection(false, new Set())).toEqual([]);
  });

  it("honors the LIST form", () => {
    // The form that silently persisted nothing for a whole release, because a `=== true` gate read a
    // list as "not opted in" (§8, path 2).
    expect(resolvePersistSelection(["cache", "index"], new Set())).toEqual(["cache", "index"]);
  });

  it("persists a memory dir with NO manifest declaration at all", () => {
    // `agent({ memory })` declares nothing by design, so a manifest-shaped gate could never authorize
    // it (§3.1). A workflow whose manifest says nothing still persists, iff it used memory.
    expect(resolvePersistSelection(undefined, new Set(["triager"]))).toEqual(["triager"]);
  });

  it("unions the declaration with the memory dirs, deduped", () => {
    expect(resolvePersistSelection(["cache"], new Set(["cache", "notes"]))).toEqual([
      "cache",
      "notes",
    ]);
  });

  it("lets `true` swallow the list — the whole workspace already contains every memory dir", () => {
    expect(resolvePersistSelection(true, new Set(["notes"]))).toBe(true);
  });
});

// ============================================================================
// Reporting — every drop reaches the author (§7.1)
// ============================================================================

const sink = (): WorkspaceEventSink & { emitted: { kind: string; reason?: string }[] } => {
  const emitted: { kind: string; reason?: string }[] = [];
  return {
    emitted,
    emit: (body) => emitted.push(body),
  };
};

/** A backend that answers `reservation` at the gate and otherwise succeeds trivially. */
const stubBackend = (reservation: WorkspaceReservation): WorkspaceBackend => ({
  reserve: () => Promise.resolve(reservation),
  readManifest: () => Promise.resolve({ bytes: null, generation: null }),
  writeManifest: () => Promise.resolve({ ok: true, generation: "g" }),
  existingPacks: () => Promise.resolve(new Set<string>()),
  writePack: () => Promise.resolve(),
  readPack: () => Promise.resolve(null),
  deletePacks: () => Promise.resolve(),
});

async function withWorkspace(
  fn: (dirs: { root: string; workspace: string; scope: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "bw-store-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  try {
    await fn({ root, workspace, scope: join(root, "scope") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("WorkspaceStore reporting", () => {
  it("costs a run that persists nothing precisely nothing", async () => {
    await withWorkspace(async ({ workspace }) => {
      const backend = stubBackend({ ok: true });
      const reserve = vi.spyOn(backend, "reserve");
      const events = sink();
      const store = new WorkspaceStore({
        backend,
        workspaceRoot: workspace,
        selection: () => [],
        events,
      });
      expect(await store.persist()).toBe(0);
      expect(reserve).not.toHaveBeenCalled();
      expect(events.emitted).toEqual([]);
    });
  });

  it("reports a storage-limit refusal", async () => {
    await withWorkspace(async ({ workspace }) => {
      await writeFile(join(workspace, "a.txt"), "x");
      const events = sink();
      const store = new WorkspaceStore({
        backend: stubBackend({ ok: false, reason: "storage_limit", maxBytes: 10 }),
        workspaceRoot: workspace,
        selection: () => true,
        events,
      });
      expect(await store.persist()).toBe(0);
      expect(events.emitted[0]).toMatchObject({
        kind: "workspace_persist_skipped",
        reason: "storage_limit",
        maxBytes: 10,
      });
    });
  });

  // The asymmetry IS the point: warning when nothing was lost trains authors to ignore the event, and
  // costs it its meaning in the case that matters.
  it("stays SILENT for an ordinary not-eligible no-op", async () => {
    await withWorkspace(async ({ workspace }) => {
      await writeFile(join(workspace, "a.txt"), "x");
      const events = sink();
      const store = new WorkspaceStore({
        backend: stubBackend({ ok: false, reason: "not_eligible" }),
        workspaceRoot: workspace,
        selection: () => true,
        events,
      });
      expect(await store.persist()).toBe(0);
      expect(events.emitted).toEqual([]);
    });
  });

  it("reports a thrown persist rather than swallowing it", async () => {
    await withWorkspace(async ({ workspace }) => {
      await writeFile(join(workspace, "a.txt"), "x");
      const backend = stubBackend({ ok: true });
      backend.writeManifest = () => Promise.reject(new Error("s3 exploded"));
      const events = sink();
      const store = new WorkspaceStore({
        backend,
        workspaceRoot: workspace,
        selection: () => true,
        events,
      });
      expect(await store.persist()).toBe(0);
      expect(events.emitted[0]).toMatchObject({
        kind: "workspace_persist_skipped",
        reason: "error",
      });
    });
  });

  it("never fails the run when the event sink throws", async () => {
    await withWorkspace(async ({ workspace }) => {
      await writeFile(join(workspace, "a.txt"), "x");
      const store = new WorkspaceStore({
        backend: stubBackend({ ok: false, reason: "storage_limit" }),
        workspaceRoot: workspace,
        selection: () => true,
        events: {
          emit: () => {
            throw new Error("sink is down");
          },
        },
      });
      await expect(store.persist()).resolves.toBe(0);
    });
  });

  it("reports overwriting a concurrent run's version of a file", async () => {
    await withWorkspace(async ({ root, workspace, scope }) => {
      const a = new WorkspaceStore({
        backend: new LocalWorkspaceBackend(scope),
        workspaceRoot: workspace,
        selection: () => true,
        events: sink(),
        codec: zstdPackCodec,
      });
      await writeFile(join(workspace, "x.txt"), "from-a-v1");
      await a.persist();

      // B hydrates, so its baseline is v1.
      const wsB = join(root, "wsB");
      await mkdir(wsB, { recursive: true });
      const events = sink();
      const b = new WorkspaceStore({
        backend: new LocalWorkspaceBackend(scope),
        workspaceRoot: wsB,
        selection: () => true,
        events,
        codec: zstdPackCodec,
      });
      await b.hydrate();

      // A writes the same path AGAIN, so the store moves under B. Only now is there a genuine
      // collision: B's baseline says v1, the store says v2, and B is about to write v3.
      await writeFile(join(workspace, "x.txt"), "from-a-v2-longer");
      await a.persist();

      await writeFile(join(wsB, "x.txt"), "from-b-longer-still");
      await b.persist();

      expect(events.emitted[0]).toMatchObject({
        kind: "workspace_persist_skipped",
        reason: "overwritten",
      });
    });
  });

  it("disarms and reports ONCE after a partial restore", async () => {
    await withWorkspace(async ({ workspace, scope }) => {
      await writeFile(join(workspace, "a.txt"), "v1");
      const first = new WorkspaceStore({
        backend: new LocalWorkspaceBackend(scope),
        workspaceRoot: workspace,
        selection: () => true,
        events: sink(),
        codec: zstdPackCodec,
      });
      await first.persist();
      // Corrupt the store so the restore fails.
      await rm(join(scope, "packs"), { recursive: true, force: true });

      const events = sink();
      const store = new WorkspaceStore({
        backend: new LocalWorkspaceBackend(scope),
        workspaceRoot: workspace,
        selection: () => true,
        events,
        codec: zstdPackCodec,
      });
      await store.hydrate();
      await store.persist();
      await store.persist();
      // One report, not one per suspend point — and the tree on disk is never written back over the
      // stored state, which is what turns a failed restore into permanent corruption.
      expect(events.emitted).toHaveLength(1);
      expect(events.emitted[0]).toMatchObject({ reason: "error" });
    });
  });
});

describe("zstdPackCodec", () => {
  it("round-trips", async () => {
    const bytes = new TextEncoder().encode("hello ".repeat(1000));
    expect(await zstdPackCodec.decompress(await zstdPackCodec.compress(bytes))).toEqual(bytes);
  });

  it("actually compresses repetitive content", async () => {
    const bytes = new TextEncoder().encode("a".repeat(100_000));
    expect((await zstdPackCodec.compress(bytes)).length).toBeLessThan(bytes.length / 10);
  });
});
