// Workspace storage format — the pure planning layer under `/workspace` persistence.
//
// One algorithm, no size- or count-dependent branches (docs/WORKSPACE_PERSISTENCE.md I6). A scope is a
// MANIFEST plus a set of immutable, content-addressed PACK objects. A pack is a plain concatenation of
// file bodies; the manifest addresses a file as (pack digest, offset) and carries the length as the
// file's own size. Nothing is ever written in place, so a torn write is impossible and a retry is free.
//
// Why packs rather than one object per file: per-file objects cost O(changed) on persist, which is
// ideal, but O(total files) round trips on HYDRATE — and hydrate runs at the start of EVERY run. At
// 16-way concurrency and a ~20ms round trip that is ~60s per run for a 50k-file tree. Packs make
// hydrate O(packs), which is tens of objects rather than tens of thousands. The whole-tarball path this
// replaces was simply the degenerate one-pack case, which is why deleting it costs nothing.
//
// Why packs are APPEND-ONLY: rewriting the pack a changed file lives in would make an agent that
// appends one line per iteration re-upload that pack every time. A changed file goes into a NEW pack
// instead, so a persist costs the bytes that actually changed. Superseded bytes accumulate inside older
// packs and are reclaimed by a whole-scope repack once the live fraction drops (see {@link decideRepack}).
//
// Nothing here does I/O. Reading bodies, compressing, uploading, and the conditional manifest write all
// live in the sync layer, so every rule below is unit-testable without a backend.

import { createHash } from "node:crypto";

/** Manifest schema version. An unknown version reads as "no manifest", which costs a re-upload of the
 *  scope but never data — the caller treats the scope as unknown rather than guessing at its shape. */
export const WORKSPACE_MANIFEST_VERSION = 2;

/** Byte target for one pack. Small enough that a repack is cheap and a single pack is a quick fetch;
 *  large enough that hydrate is tens of objects rather than thousands. A file larger than this becomes
 *  a pack of one, which is the correct degenerate case and needs no special branch. */
export const TARGET_PACK_BYTES = 4 * 1024 * 1024;

/** Repack when live bytes fall below this fraction of stored bytes. The one knob bounding dead weight;
 *  below it a scope is paying to store bytes no live file references. */
export const REPACK_MIN_LIVE_FRACTION = 0.75;

/** Repack when the pack count exceeds this multiple of the ideal count for the scope's size. Without
 *  it, a long run appending a tiny pack per iteration would drift toward thousands of small packs and
 *  quietly re-create the round-trip problem packs exist to remove. */
export const REPACK_MAX_PACK_COUNT_FACTOR = 3;

/** Floor for the pack-count check, so a small scope is never repacked merely for having a few packs. */
export const REPACK_MIN_PACK_COUNT = 8;

/** One persisted file. Short keys because this JSON is written on every persist. */
export interface WorkspaceFileEntry {
  /** Workspace-relative POSIX path. */
  p: string;
  /** Size in bytes. Doubles as the file's length within its pack. */
  s: number;
  /** mtime in ms. Restored on hydrate, so the next diff doesn't see every file as changed. */
  m: number;
  /** Digest of the pack holding this file's bytes. */
  k: string;
  /** Byte offset of this file within its pack's UNCOMPRESSED stream. */
  o: number;
}

/** One stored pack. */
export interface WorkspacePackEntry {
  /** sha256 hex of the pack's STORED bytes — what the object is named and what a read verifies
   *  against. Digesting the stored form (rather than the contents) is what makes verification exact:
   *  a truncated or corrupted download fails the check without needing to be decompressed first. */
  d: string;
  /** Stored size in bytes (post-compression). */
  s: number;
  /** Uncompressed size in bytes — the denominator for this pack's live fraction. */
  u: number;
}

export interface WorkspaceManifest {
  v: number;
  files: WorkspaceFileEntry[];
  packs: WorkspacePackEntry[];
}

/** A scope with nothing stored. Distinct from "no manifest": an empty manifest is a RESTORED state (the
 *  scope was deliberately emptied) and must hydrate as empty, never as "fall back to something else". */
export function emptyManifest(): WorkspaceManifest {
  return { v: WORKSPACE_MANIFEST_VERSION, files: [], packs: [] };
}

// ============================================================================
// Intent — what THIS run changed, relative to what it last agreed with the store
// ============================================================================

/**
 * What one run's local tree changed relative to its baseline.
 *
 * The separation of `baseline` from the store's CURRENT state is the whole point (§6). With no
 * concurrency they are identical. Under concurrency they diverge, and conflating them is what makes a
 * run emit deletes for a concurrent run's files: every path in the baseline that isn't on my disk looks
 * like something I deleted, when it may be something the other run created and I simply never had.
 */
export interface WorkspaceIntent {
  /** Files whose bytes must be written: new, or changed by size/mtime. No pack ref yet. */
  write: readonly Omit<WorkspaceFileEntry, "k" | "o">[];
  /** Files unchanged since the baseline — their bytes are already in a live pack, carried forward
   *  as-is. This is what makes an unchanged file cost nothing, even during a repack decision. */
  keep: readonly WorkspaceFileEntry[];
  /** Paths present in the baseline and gone from disk: deletions this run genuinely made. */
  delete: readonly string[];
}

/** A local walk entry, before it is assigned to a pack. */
export type WorkspaceWalkEntry = Omit<WorkspaceFileEntry, "k" | "o">;

/**
 * Diff the local tree against the baseline to produce this run's INTENT.
 *
 * Change detection is (size, mtime) — rsync's and incremental tar's default, with the same caveat: a
 * file rewritten to the same length whose mtime is then restored reads as unchanged. Hashing every byte
 * before every suspend point is the only alternative and reintroduces the cost packs exist to remove.
 *
 * A null baseline (first persist of this run, or an unreadable manifest) writes everything and deletes
 * nothing, which is correct: nothing of this scope is known to be ours yet, and inventing deletions
 * from an unknown baseline is how a run destroys state it never saw.
 */
export function diffIntent(
  local: readonly WorkspaceWalkEntry[],
  baseline: WorkspaceManifest | null,
): WorkspaceIntent {
  const before = new Map<string, WorkspaceFileEntry>();
  if (baseline !== null) for (const e of baseline.files) before.set(e.p, e);

  const write: WorkspaceWalkEntry[] = [];
  const keep: WorkspaceFileEntry[] = [];

  for (const entry of local) {
    const prior = before.get(entry.p);
    if (prior === undefined || prior.s !== entry.s || prior.m !== entry.m) {
      write.push(entry);
    } else {
      keep.push(prior);
    }
    before.delete(entry.p);
  }

  // Whatever is left was in the baseline and is not on disk: this run removed it. Without this a
  // persisted workspace grows monotonically as an agent creates and removes scratch files.
  return { write, keep, delete: [...before.keys()] };
}

// ============================================================================
// Merge — apply this run's intent onto the store's current state
// ============================================================================

/** A path both this run and a concurrent one wrote. Resolved in favor of this run, and REPORTED — a
 *  clobber that nobody is told about is the failure mode this system exists to eliminate. */
export interface WorkspaceConflict {
  path: string;
  /** What this run did to it. */
  ours: "wrote" | "deleted";
}

export interface WorkspaceMerge {
  /** The file set to store: this run's intent applied over the remote's current files. */
  files: WorkspaceFileEntry[];
  /** Paths where the remote moved under us since our baseline. */
  conflicts: WorkspaceConflict[];
}

/**
 * Apply an intent onto the store's CURRENT file set (§6's three-way merge).
 *
 * The guarantee: a path this run never touched is never disturbed, so a concurrent run's work survives
 * even though this run has no idea it happened. The non-guarantee, stated plainly in §6.1: per-file
 * resolution can interleave two runs into a set where every file is intact and the set is collectively
 * inconsistent. This function cannot fix that and should not pretend to.
 *
 * `remote === null` means the scope has nothing stored, so the intent stands alone.
 */
export function mergeIntent(
  intent: WorkspaceIntent,
  baseline: WorkspaceManifest | null,
  remote: WorkspaceManifest | null,
  written: ReadonlyMap<string, { k: string; o: number }>,
): WorkspaceMerge {
  const base = new Map<string, WorkspaceFileEntry>();
  if (baseline !== null) for (const e of baseline.files) base.set(e.p, e);

  const merged = new Map<string, WorkspaceFileEntry>();
  if (remote !== null) for (const e of remote.files) merged.set(e.p, e);

  const conflicts: WorkspaceConflict[] = [];

  /** Did the remote change this path since our baseline? Absent-from-both is not a conflict. */
  const remoteMoved = (path: string): boolean => {
    const mine = base.get(path);
    const theirs = merged.get(path);
    if (mine === undefined && theirs === undefined) return false;
    if (mine === undefined || theirs === undefined) return true;
    return mine.s !== theirs.s || mine.m !== theirs.m;
  };

  for (const entry of intent.write) {
    const placement = written.get(entry.p);
    // A file whose bytes did not get placed (the backend declined it) keeps whatever the store already
    // has rather than being recorded against a pack that doesn't hold it. Silently listing it would
    // produce a manifest that fails to hydrate.
    if (placement === undefined) continue;
    if (remoteMoved(entry.p)) conflicts.push({ path: entry.p, ours: "wrote" });
    merged.set(entry.p, { p: entry.p, s: entry.s, m: entry.m, k: placement.k, o: placement.o });
  }

  for (const entry of intent.keep) {
    // Unchanged for us. If the remote changed it, THEIRS wins: we have nothing newer to offer, and
    // overwriting a concurrent run's edit with a byte-identical-to-our-baseline copy would be pure
    // data loss. This asymmetry with `write` is deliberate.
    if (!merged.has(entry.p)) merged.set(entry.p, entry);
  }

  for (const path of intent.delete) {
    if (remoteMoved(path)) conflicts.push({ path, ours: "deleted" });
    merged.delete(path);
  }

  const files = [...merged.values()].sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  return { files, conflicts };
}

// ============================================================================
// Pack planning
// ============================================================================

/** One pack to be built: which files go in it, at which offsets, in this order. */
export interface PackPlan {
  entries: { entry: WorkspaceWalkEntry; offset: number }[];
  /** Total uncompressed bytes this pack will hold. */
  uncompressedBytes: number;
}

/**
 * Group the files that need bytes written into packs.
 *
 * Files are ordered by path first, which puts a directory's files adjacent, so files that tend to change
 * together tend to land in the same pack — that is what keeps the repack threshold from firing early on
 * a workload that edits one subtree. A file at or over the target becomes a pack of one; no branch is
 * needed for it, because closing a full pack before adding produces exactly that.
 */
export function planPacks(
  files: readonly WorkspaceWalkEntry[],
  targetBytes: number = TARGET_PACK_BYTES,
): PackPlan[] {
  const ordered = [...files].sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  const plans: PackPlan[] = [];
  let current: PackPlan = { entries: [], uncompressedBytes: 0 };

  for (const entry of ordered) {
    if (current.entries.length > 0 && current.uncompressedBytes + entry.s > targetBytes) {
      plans.push(current);
      current = { entries: [], uncompressedBytes: 0 };
    }
    current.entries.push({ entry, offset: current.uncompressedBytes });
    current.uncompressedBytes += entry.s;
  }
  if (current.entries.length > 0) plans.push(current);
  return plans;
}

/** Digest naming a pack's stored bytes. Also the object's name, so a client can name a digest but never
 *  a key — the scope prefix is always derived server-side. */
export function packDigest(storedBytes: Uint8Array): string {
  return createHash("sha256").update(storedBytes).digest("hex");
}

// ============================================================================
// Repack + reclamation
// ============================================================================

/** Packs referenced by `previous` and not by `next`: nothing live points into them, so they are deleted
 *  in the same explicit step that already handles vanished paths. There is exactly ONE live manifest per
 *  scope and every persist diffs previous against next, which is why this needs no reaper and can leak
 *  nothing. */
export function unreferencedPacks(
  previous: WorkspaceManifest | null,
  next: WorkspaceManifest,
): string[] {
  if (previous === null) return [];
  const live = new Set(next.packs.map((p) => p.d));
  return previous.packs.map((p) => p.d).filter((d) => !live.has(d));
}

/**
 * The pack entries `files` actually reference, carried over from the packs we know about. A pack no
 * file points into is dropped here, which is what makes {@link unreferencedPacks} see it as garbage.
 *
 * DEDUPED by digest, which is not cosmetic. The caller's `known` set is the remote's packs concatenated
 * with the ones just built, and those overlap whenever a rebuilt pack is byte-identical to a stored one
 * (the same content re-packed produces the same digest, so the upload is skipped but the entry is still
 * produced). Keeping both copies would inflate the manifest and, worse, double-count
 * `storedUncompressedBytes` in {@link decideRepack} — firing a full repack on a scope that has no dead
 * bytes at all.
 */
export function referencedPacks(
  files: readonly WorkspaceFileEntry[],
  known: readonly WorkspacePackEntry[],
): WorkspacePackEntry[] {
  const used = new Set(files.map((f) => f.k));
  const byDigest = new Map<string, WorkspacePackEntry>();
  for (const p of known) {
    if (!used.has(p.d) || byDigest.has(p.d)) continue;
    byDigest.set(p.d, p);
  }
  return [...byDigest.values()].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
}

export interface RepackDecision {
  repack: boolean;
  /** Why, for the event stream — a repack is the expensive operation in this design, so when it fires
   *  it must be visible rather than inferred from a latency graph. */
  reason: "live_fraction" | "pack_count" | null;
  liveBytes: number;
  storedUncompressedBytes: number;
  packCount: number;
}

/**
 * Should the next persist rewrite every pack instead of appending?
 *
 * Two triggers, both bounding a way the append-only rule degrades: dead bytes accumulating inside packs
 * whose files have been superseded, and pack COUNT drifting up as a long run appends a small pack per
 * iteration. The second matters as much as the first — thousands of tiny packs would re-create the
 * round-trip cost that packs exist to remove, without ever tripping a live-fraction check.
 */
export function decideRepack(manifest: WorkspaceManifest): RepackDecision {
  const liveBytes = manifest.files.reduce((n, f) => n + f.s, 0);
  const storedUncompressedBytes = manifest.packs.reduce((n, p) => n + p.u, 0);
  const packCount = manifest.packs.length;

  const base: Omit<RepackDecision, "repack" | "reason"> = {
    liveBytes,
    storedUncompressedBytes,
    packCount,
  };

  // Nothing stored, or nothing live: no dead weight to reclaim and no packs to consolidate.
  if (storedUncompressedBytes === 0 || packCount === 0) {
    return { repack: false, reason: null, ...base };
  }

  if (liveBytes / storedUncompressedBytes < REPACK_MIN_LIVE_FRACTION) {
    return { repack: true, reason: "live_fraction", ...base };
  }

  const idealPacks = Math.max(1, Math.ceil(liveBytes / TARGET_PACK_BYTES));
  const maxPacks = Math.max(REPACK_MIN_PACK_COUNT, idealPacks * REPACK_MAX_PACK_COUNT_FACTOR);
  if (packCount > maxPacks) {
    return { repack: true, reason: "pack_count", ...base };
  }

  return { repack: false, reason: null, ...base };
}

// ============================================================================
// Serialization
// ============================================================================

/**
 * Parse a stored manifest. Returns null for anything unreadable or of an unknown version — the caller
 * then treats the scope as unknown, which costs a re-upload but never data.
 *
 * The manifest is ours, but it round-trips through storage, so nothing here trusts its shape. Path
 * SAFETY is enforced at restore time against the workspace root (a `..` in a stored path must not
 * escape), deliberately not here: this layer has no notion of where the workspace lives.
 */
export function parseWorkspaceManifest(bytes: Uint8Array): WorkspaceManifest | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as { v?: unknown; files?: unknown; packs?: unknown };
    if (obj.v !== WORKSPACE_MANIFEST_VERSION) return null;
    if (!Array.isArray(obj.files) || !Array.isArray(obj.packs)) return null;

    const packs: WorkspacePackEntry[] = [];
    for (const raw of obj.packs) {
      if (typeof raw !== "object" || raw === null) return null;
      const p = raw as { d?: unknown; s?: unknown; u?: unknown };
      if (typeof p.d !== "string" || !isDigest(p.d)) return null;
      if (!isSize(p.s) || !isSize(p.u)) return null;
      packs.push({ d: p.d, s: p.s, u: p.u });
    }

    const known = new Set(packs.map((p) => p.d));
    const files: WorkspaceFileEntry[] = [];
    for (const raw of obj.files) {
      if (typeof raw !== "object" || raw === null) return null;
      const e = raw as { p?: unknown; s?: unknown; m?: unknown; k?: unknown; o?: unknown };
      if (typeof e.p !== "string" || e.p === "") return null;
      if (!isSize(e.s) || typeof e.m !== "number" || !Number.isFinite(e.m)) return null;
      if (typeof e.k !== "string" || !known.has(e.k)) return null; // dangling pack ref
      if (!isSize(e.o)) return null;
      files.push({ p: e.p, s: e.s, m: e.m, k: e.k, o: e.o });
    }

    return { v: WORKSPACE_MANIFEST_VERSION, files, packs };
  } catch {
    return null;
  }
}

export function serializeWorkspaceManifest(manifest: WorkspaceManifest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(manifest));
}

/** sha256 hex — the only shape a digest may take, so a digest can never smuggle a key separator. */
function isDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function isSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
