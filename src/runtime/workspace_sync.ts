// Workspace sync — the ONE hydrate/persist algorithm (docs/WORKSPACE_PERSISTENCE.md I6).
//
// Written against a {@link WorkspaceBackend} seam so hosted (broker-presigned S3) and self-hosted (a
// directory on the runner's own disk) run the *same code*. Size and file count change throughput here;
// they never change semantics. That invariant is the reason this module exists: the three stores it
// replaces had three different behaviours, and the two rarely-taken ones were where every silent
// data-loss path hid (§2.1).
//
// The load-bearing distinction, and the bug it fixes (§6): a run holds a BASELINE — the manifest it last
// agreed with the store about — which is NOT the store's current state. Conflating them is what made a
// run emit deletions for a concurrent run's files: every path in the baseline that isn't on my disk
// looks like something I deleted, when it may be something another run created and I simply never had.
// Every write here is a three-way merge of (baseline, local tree, current remote).
//
// Ordering rules, all load-bearing:
//   - packs land BEFORE the manifest  (a crash between leaves unreferenced bytes, healed by the next
//     diff; the reverse leaves a manifest pointing at objects that do not exist — a failed hydrate)
//   - deletes land AFTER the manifest (same reason, other direction)
//   - nothing is ever written in place, so no step can be torn

import { createLogger } from "./support/index.js";
import {
  diffIntent,
  mergeIntent,
  planPacks,
  packDigest,
  decideRepack,
  unreferencedPacks,
  referencedPacks,
  parseWorkspaceManifest,
  serializeWorkspaceManifest,
  emptyManifest,
  WORKSPACE_MANIFEST_VERSION,
  type WorkspaceManifest,
  type WorkspacePackEntry,
  type WorkspaceWalkEntry,
  type WorkspaceIntent,
  type WorkspaceConflict,
} from "./workspace_format.js";

const log = createLogger("WorkspaceSync");

/** Hard ceiling on one scope's live bytes. A cost guardrail, not a security boundary (tenant isolation
 *  is the server-derived scope prefix). The old 512 MiB was sized by the tarball's need to be read whole
 *  into memory; packs stream, so this is free to be generous. */
export const WORKSPACE_SCOPE_MAX_BYTES = 4 * 1024 * 1024 * 1024;

/** Packs built (and held in memory) at once. Bounds peak RSS to roughly this times the pack target. */
const PACK_BUILD_BATCH = 8;

/** Parallel pack transfers. Bounded so a wide change set can't open a socket per pack. */
const PACK_TRANSFER_CONCURRENCY = 8;

/** Conditional-write attempts before giving up. A conflict means another run wrote first; we re-read
 *  and re-merge, which is cheap because our packs are content-addressed and already stored. Bounded so
 *  two runs writing in a tight loop can't spin here forever. */
const MANIFEST_WRITE_ATTEMPTS = 4;

// ============================================================================
// Seams
// ============================================================================

/** A refusal carries WHY, because "not eligible" (self-hosted — nothing was lost) and "refused" (we
 *  threw away a snapshot the run made) are not interchangeable, and a wire that conflated them is
 *  exactly how persistence stopped silently once before (§8, path 6). */
export type WorkspaceReservation =
  | { ok: true }
  | { ok: false; reason: "not_eligible" | "storage_limit"; maxBytes?: number };

export type ManifestWriteResult =
  | { ok: true; generation: string | null }
  /** Someone else wrote since our read. Re-read, re-merge, retry. */
  | { ok: false; conflict: true };

/**
 * Everything the algorithm needs from a place to keep bytes. Two implementations; no third, and no
 * capability negotiation — a backend that cannot do one of these is broken, not "different".
 */
export interface WorkspaceBackend {
  /** Gate the scope's projected footprint before any bytes move, so a refusal costs no upload. */
  reserve(totalBytes: number): Promise<WorkspaceReservation>;
  /** The stored manifest plus the token needed to write it back conditionally. `bytes: null` = nothing
   *  stored for this scope. */
  readManifest(): Promise<{ bytes: Uint8Array | null; generation: string | null }>;
  /** Conditional write. `expected` is the generation from the last read; `null` means "must not exist". */
  writeManifest(bytes: Uint8Array, expected: string | null): Promise<ManifestWriteResult>;
  /** Which of these digests the store already holds — one round trip that turns a retried or resumed
   *  persist into "upload only what didn't land". */
  existingPacks(digests: readonly string[]): Promise<ReadonlySet<string>>;
  writePack(digest: string, bytes: Uint8Array): Promise<void>;
  /** `null` when the object is missing. */
  readPack(digest: string): Promise<Uint8Array | null>;
  deletePacks(digests: readonly string[]): Promise<void>;
}

/** Pack compression. Injected so tests can use identity and assert framing independently of zstd. */
export interface PackCodec {
  compress(bytes: Uint8Array): Promise<Uint8Array>;
  decompress(bytes: Uint8Array): Promise<Uint8Array>;
}

/** The filesystem surface, narrow enough to fake in a unit test. */
export interface WorkspaceSyncFs {
  /** Every regular file under the selection (`undefined` = the whole root), with size + mtime. */
  walk(root: string, paths: readonly string[] | undefined): Promise<WorkspaceWalkEntry[]>;
  readFile(root: string, relPath: string): Promise<Uint8Array>;
  /** Write to a workspace-relative path, creating parents. `mtimeMs` restores the recorded time, which
   *  is what keeps the next diff from seeing every restored file as changed. */
  writeUnder(root: string, relPath: string, data: Uint8Array, mtimeMs: number): Promise<void>;
}

/** Why a persist stored nothing. Mirrors the SDK's `workspace_persist_skipped` reasons (§7.1). */
export type PersistSkipReason = "not_eligible" | "storage_limit" | "too_large" | "error";

export interface PersistOutcome {
  /** The scope's live bytes after this persist (0 when nothing was stored). */
  bytes: number;
  packsWritten: number;
  packsDeleted: number;
  repacked: boolean;
  /** Paths where a concurrent run's version was overwritten by ours (§6). */
  conflicts: WorkspaceConflict[];
  /** Set when nothing was stored. `undefined` means the persist succeeded (possibly as a no-op). */
  skipped?: { reason: PersistSkipReason; detail?: string; maxBytes?: number };
}

export interface WorkspaceSyncDeps {
  backend: WorkspaceBackend;
  fs: WorkspaceSyncFs;
  codec: PackCodec;
  workspaceRoot: string;
  /** Per-scope byte ceiling. Defaults to {@link WORKSPACE_SCOPE_MAX_BYTES}. */
  maxScopeBytes?: number;
}

// ============================================================================
// The algorithm
// ============================================================================

export class WorkspaceSync {
  private readonly maxScopeBytes: number;
  /** What this run last agreed with the store about. Seeded at hydrate, advanced by each persist.
   *  `null` = unknown, which makes the next diff write everything and delete NOTHING. */
  private baseline: WorkspaceManifest | null = null;
  /** Generation token for the conditional manifest write. */
  private generation: string | null = null;
  /** Set when a restore died partway through writing. Non-null disarms persist for the rest of the run:
   *  the tree on disk is not this scope's state, and storing it would turn a failed restore into
   *  permanent corruption. */
  private restoreFailure: string | null = null;

  constructor(private readonly deps: WorkspaceSyncDeps) {
    this.maxScopeBytes = deps.maxScopeBytes ?? WORKSPACE_SCOPE_MAX_BYTES;
  }

  /**
   * Restore the scope into the workspace at run start.
   *
   * An EMPTY manifest is a restored state, not a missing one: a scope that was deliberately emptied must
   * hydrate as empty and must set a baseline, or the run's first persist would treat every path as new
   * and resurrect what was deleted.
   */
  async hydrate(): Promise<{ files: number; packs: number }> {
    try {
      const read = await this.deps.backend.readManifest();
      this.generation = read.generation;
      if (read.bytes === null) return { files: 0, packs: 0 }; // nothing stored yet

      const manifest = parseWorkspaceManifest(read.bytes);
      if (manifest === null) {
        // Unreadable or a version we don't know. Treat the scope as unknown rather than guessing:
        // the next persist re-uploads (work), and never deletes (data).
        log.warn("workspace_manifest_unreadable");
        return { files: 0, packs: 0 };
      }

      const byPack = new Map<string, typeof manifest.files>();
      for (const file of manifest.files) {
        const bucket = byPack.get(file.k);
        if (bucket === undefined) byPack.set(file.k, [file]);
        else bucket.push(file);
      }

      let restored = 0;
      await this.forEachBounded([...byPack.entries()], PACK_TRANSFER_CONCURRENCY, async (entry) => {
        const [digest, files] = entry;
        const stored = await this.deps.backend.readPack(digest);
        if (stored === null) {
          // A referenced pack that isn't there is corruption, and a pack can hold many files. Failing
          // loudly disarms persist, which preserves the stored state; the tempting alternative — skip
          // the files and carry on — would leave them absent from disk but present in our baseline, so
          // the next persist would delete them. Silent deletion is the worse outcome.
          throw new Error(`workspace pack ${digest.slice(0, 12)} is referenced but missing`);
        }
        // Verify BEFORE decompressing: content addressing is what makes this possible, so a truncated
        // or corrupted download must fail loudly here rather than restore as a plausible-looking tree.
        const actual = packDigest(stored);
        if (actual !== digest) {
          throw new Error(`workspace pack ${digest.slice(0, 12)} failed its integrity check`);
        }
        const body = await this.deps.codec.decompress(stored);
        for (const file of files) {
          const slice = body.subarray(file.o, file.o + file.s);
          if (slice.length !== file.s) {
            throw new Error(`workspace pack ${digest.slice(0, 12)} is short for ${file.p}`);
          }
          await this.deps.fs.writeUnder(this.deps.workspaceRoot, file.p, slice, file.m);
          restored += 1;
        }
      });

      // Only now is the baseline true: it describes what is actually on disk.
      this.baseline = manifest;
      log.info("workspace_hydrated", { files: restored, packs: byPack.size });
      return { files: restored, packs: byPack.size };
    } catch (err) {
      // Anything that threw may have left a partially written tree, and a partial tree must never be
      // stored back over good state.
      this.restoreFailure = errMsg(err);
      log.warn("workspace_restore_partial", { error: this.restoreFailure });
      return { files: 0, packs: 0 };
    }
  }

  /** Why persistence is disarmed, or null. The caller reports this to the author once. */
  get disarmedReason(): string | null {
    return this.restoreFailure;
  }

  /**
   * Store the selection. `paths === undefined` means the whole workspace (`persist: true`).
   *
   * Costs O(changed bytes), not O(scope): unchanged files keep their existing pack placement and are
   * never re-read, re-compressed, or re-uploaded. That is what makes an agent appending one line per
   * iteration cheap, and it is why packs are append-only rather than rewritten in place.
   */
  async persist(paths: readonly string[] | undefined): Promise<PersistOutcome> {
    const empty: PersistOutcome = {
      bytes: 0,
      packsWritten: 0,
      packsDeleted: 0,
      repacked: false,
      conflicts: [],
    };

    if (this.restoreFailure !== null) {
      return { ...empty, skipped: { reason: "error", detail: this.restoreFailure } };
    }

    try {
      const local = await this.deps.fs.walk(this.deps.workspaceRoot, paths);
      const intent = diffIntent(local, this.baseline);

      // Nothing of ours moved. Skipping is exact rather than heuristic — this is what replaced the old
      // (path, size, mtime) fingerprint, which answered the same question less precisely.
      if (intent.write.length === 0 && intent.delete.length === 0 && this.baseline !== null) {
        return { ...empty, bytes: this.baseline.files.reduce((n, f) => n + f.s, 0) };
      }

      let read = await this.deps.backend.readManifest();
      let remote = read.bytes === null ? null : parseWorkspaceManifest(read.bytes);
      this.generation = read.generation;

      // Repack: rewrite every locally-held file into fresh packs instead of appending. Files that exist
      // only in the remote (a concurrent run's) keep their packs — we don't have their bytes and won't
      // download them to reclaim space. So a repack after a concurrent merge is partial, which reclaims
      // less but is never wrong.
      const decision = decideRepack(remote ?? emptyManifest());
      const effective: WorkspaceIntent = decision.repack
        ? { write: local, keep: [], delete: intent.delete }
        : intent;
      if (decision.repack) {
        log.info("workspace_repack", {
          reason: decision.reason,
          liveBytes: decision.liveBytes,
          storedBytes: decision.storedUncompressedBytes,
          packs: decision.packCount,
        });
      }

      // Project the footprint before moving bytes, so a refusal costs no upload. Placements don't
      // affect the total, so a placeholder is enough to run the merge for its file SET.
      const projected = mergeIntent(effective, this.baseline, remote, placeholders(effective));
      const totalBytes = projected.files.reduce((n, f) => n + f.s, 0);

      if (totalBytes > this.maxScopeBytes) {
        return {
          ...empty,
          skipped: {
            reason: "too_large",
            detail: `${String(totalBytes)} bytes`,
            maxBytes: this.maxScopeBytes,
          },
        };
      }

      const reservation = await this.deps.backend.reserve(totalBytes);
      if (!reservation.ok) {
        return {
          ...empty,
          // Spread rather than assign: under `exactOptionalPropertyTypes` an absent ceiling and a
          // present-but-undefined one are different types, and only the backend knows which it has.
          skipped: {
            reason: reservation.reason,
            ...(reservation.maxBytes === undefined ? {} : { maxBytes: reservation.maxBytes }),
          },
        };
      }

      const built = await this.buildAndUploadPacks(effective.write);

      // Merge for real, then conditionally write. On conflict the packs stay valid — they are
      // content-addressed and already stored — so a retry only redoes the merge.
      let merged = mergeIntent(effective, this.baseline, remote, built.placements);
      let next = this.assemble(merged.files, remote, built.packs);

      let attempt = 0;
      for (;;) {
        attempt += 1;
        const result = await this.deps.backend.writeManifest(
          serializeWorkspaceManifest(next),
          this.generation,
        );
        if (result.ok) {
          this.generation = result.generation;
          break;
        }
        if (attempt >= MANIFEST_WRITE_ATTEMPTS) {
          return {
            ...empty,
            skipped: {
              reason: "error",
              detail: `another run kept writing this workspace; gave up after ${String(attempt)} attempts`,
            },
          };
        }
        read = await this.deps.backend.readManifest();
        remote = read.bytes === null ? null : parseWorkspaceManifest(read.bytes);
        this.generation = read.generation;
        merged = mergeIntent(effective, this.baseline, remote, built.placements);
        next = this.assemble(merged.files, remote, built.packs);
      }

      // Manifest has landed, so nothing points at these any more. Reclaiming after the write is what
      // keeps a crash from leaving the manifest referencing deleted objects.
      const garbage = unreferencedPacks(remote, next);
      if (garbage.length > 0) await this.deps.backend.deletePacks(garbage);

      // The baseline is "what I have on disk AND agreed with the store about" — NOT the store's whole
      // state. `next` deliberately carries a concurrent run's files (that is the merge working), and
      // adopting those wholesale would put paths in our baseline that were never on our disk, so the
      // NEXT diff would report them as our deletions. That is precisely the bug §6 exists to fix, one
      // step later in the loop.
      this.baseline = this.narrowToLocal(next, local);
      log.info("workspace_persisted", {
        bytes: totalBytes,
        packsWritten: built.uploaded,
        packsDeleted: garbage.length,
        repacked: decision.repack,
        conflicts: merged.conflicts.length,
      });

      return {
        bytes: totalBytes,
        packsWritten: built.uploaded,
        packsDeleted: garbage.length,
        repacked: decision.repack,
        conflicts: merged.conflicts,
      };
    } catch (err) {
      return { ...empty, skipped: { reason: "error", detail: errMsg(err) } };
    }
  }

  /** Restrict a manifest to the paths this run actually holds on disk — see the call site for why the
   *  distinction matters. Packs are recomputed so the baseline never references one it doesn't need. */
  private narrowToLocal(
    manifest: WorkspaceManifest,
    local: readonly WorkspaceWalkEntry[],
  ): WorkspaceManifest {
    const mine = new Set(local.map((e) => e.p));
    const files = manifest.files.filter((f) => mine.has(f.p));
    return { v: WORKSPACE_MANIFEST_VERSION, files, packs: referencedPacks(files, manifest.packs) };
  }

  /** Files + the packs those files reference, drawn from what the remote held plus what we just wrote.
   *  `referencedPacks` is what drops a pack nothing points into, which is what makes it collectable. */
  private assemble(
    files: WorkspaceManifest["files"],
    remote: WorkspaceManifest | null,
    fresh: readonly WorkspacePackEntry[],
  ): WorkspaceManifest {
    const known = [...(remote?.packs ?? []), ...fresh];
    return { v: WORKSPACE_MANIFEST_VERSION, files, packs: referencedPacks(files, known) };
  }

  /**
   * Build packs for the changed files and upload the ones the store doesn't already have.
   *
   * Batched so peak memory is bounded by the batch size times the pack target rather than by the size
   * of the change set — a `persist: true` over a large tree must not need the tree in RAM.
   */
  private async buildAndUploadPacks(files: readonly WorkspaceWalkEntry[]): Promise<{
    placements: Map<string, { k: string; o: number }>;
    packs: WorkspacePackEntry[];
    uploaded: number;
  }> {
    const placements = new Map<string, { k: string; o: number }>();
    const packs: WorkspacePackEntry[] = [];
    let uploaded = 0;

    const plans = planPacks(files);
    for (let i = 0; i < plans.length; i += PACK_BUILD_BATCH) {
      const batch = plans.slice(i, i + PACK_BUILD_BATCH);
      const builtBatch = await Promise.all(
        batch.map(async (plan) => {
          const parts: Uint8Array[] = [];
          for (const { entry } of plan.entries) {
            parts.push(await this.deps.fs.readFile(this.deps.workspaceRoot, entry.p));
          }
          const body = concat(parts, plan.uncompressedBytes);
          const stored = await this.deps.codec.compress(body);
          return { plan, stored, digest: packDigest(stored) };
        }),
      );

      const existing = await this.deps.backend.existingPacks(builtBatch.map((b) => b.digest));

      await this.forEachBounded(builtBatch, PACK_TRANSFER_CONCURRENCY, async (b) => {
        if (existing.has(b.digest)) return;
        await this.deps.backend.writePack(b.digest, b.stored);
        uploaded += 1;
      });

      for (const b of builtBatch) {
        packs.push({ d: b.digest, s: b.stored.length, u: b.plan.uncompressedBytes });
        for (const { entry, offset } of b.plan.entries) {
          placements.set(entry.p, { k: b.digest, o: offset });
        }
      }
    }

    return { placements, packs, uploaded };
  }

  /** Run `fn` over `items` with at most `limit` in flight. The first rejection propagates. */
  private async forEachBounded<T>(
    items: readonly T[],
    limit: number,
    fn: (item: T) => Promise<void>,
  ): Promise<void> {
    const queue = [...items];
    const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.pop(); item !== undefined; item = queue.pop()) await fn(item);
    });
    await Promise.all(workers);
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Stand-in placements for the projection pass. Only the file SET and its sizes are read from the
 *  result, never the pack refs, so these values never leave {@link WorkspaceSync.persist}. */
function placeholders(intent: WorkspaceIntent): Map<string, { k: string; o: number }> {
  const k = "0".repeat(64);
  return new Map(intent.write.map((e) => [e.p, { k, o: 0 }]));
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
