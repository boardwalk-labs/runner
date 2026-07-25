// Delta workspace sync — the file-level diff that decides what a persist actually uploads.
//
// The whole-tarball model rewrote every persisted byte on every persist, and persist runs before
// EVERY sleep and freeze (docs/WORKSPACE_PERSISTENCE.md §5.1), so a long agent that writes each
// iteration paid O(total workspace) per wait. This module reduces that to O(changed).
//
// Objects are addressed BY PATH, not by content hash. Content addressing would dedup, but it needs a
// reaper for unreferenced blobs and an orphan class to reason about; path addressing makes a deletion
// an explicit DELETE of a known key, so there is no GC to build and nothing can leak. Dedup was never
// the goal — cutting upload bytes was.

import { createHash } from "node:crypto";

/** Manifest schema version. Bump only for a change an older runner cannot read; hydrate treats an
 *  unknown version as "no manifest" and falls back to the legacy tarball. */
export const WORKSPACE_MANIFEST_VERSION = 1;

/**
 * Above this many files a scope stays on the legacy whole-tarball path. Per-path objects mean one
 * request per file, so a `persist: true` over a node_modules tree would turn one upload into tens of
 * thousands — strictly worse than what it replaces. That tree is already the documented anti-pattern
 * (§3: "the convenient one and the one that hurts"), so the bound degrades it to today's behavior
 * rather than optimizing for it.
 */
export const MAX_DELTA_FILES = 2000;

/** One persisted file. Short keys because this JSON is uploaded on every persist. */
export interface WorkspaceFileEntry {
  /** Workspace-relative POSIX path. */
  p: string;
  /** Size in bytes. */
  s: number;
  /** mtime in ms. */
  m: number;
}

export interface WorkspaceManifest {
  v: number;
  files: WorkspaceFileEntry[];
}

/** What a persist must do to bring the remote scope in line with the local tree. */
export interface WorkspaceDelta {
  /** Files to upload (added, or changed by size/mtime). */
  upload: WorkspaceFileEntry[];
  /** Workspace-relative paths whose remote object must be deleted. */
  delete: string[];
  /** The manifest to store once the uploads and deletes land. */
  next: WorkspaceManifest;
  /** Total bytes the scope will occupy — the storage footprint the broker records. */
  totalBytes: number;
}

/**
 * Diff the local tree against the manifest of what is already stored.
 *
 * Change detection is (size, mtime), the same heuristic as the unchanged-persist skip and as rsync
 * and incremental tar by default. It inherits the same caveat: a file rewritten to the same length
 * whose mtime is then restored reads as unchanged. Hashing every byte before every sleep is the only
 * alternative, and it reintroduces the O(total bytes) cost this exists to remove.
 *
 * `previous === null` (a first persist, or a scope still on the legacy tarball) uploads everything,
 * which is correct: nothing of this scope is known to be stored yet.
 */
export function diffWorkspace(
  local: readonly WorkspaceFileEntry[],
  previous: WorkspaceManifest | null,
): WorkspaceDelta {
  const before = new Map<string, WorkspaceFileEntry>();
  if (previous !== null) for (const e of previous.files) before.set(e.p, e);

  const upload: WorkspaceFileEntry[] = [];
  const files: WorkspaceFileEntry[] = [];
  let totalBytes = 0;

  for (const entry of local) {
    files.push(entry);
    totalBytes += entry.s;
    const prior = before.get(entry.p);
    if (prior === undefined || prior.s !== entry.s || prior.m !== entry.m) upload.push(entry);
    before.delete(entry.p);
  }

  // Whatever is left in `before` is no longer on disk. Deleting it is what keeps a persisted
  // workspace from growing monotonically as an agent creates and removes scratch files across runs.
  const remove = [...before.keys()];

  return { upload, delete: remove, next: { v: WORKSPACE_MANIFEST_VERSION, files }, totalBytes };
}

/**
 * Parse a stored manifest. Returns null for anything unreadable or of an unknown version — the
 * caller then treats the scope as unknown and re-uploads, which costs work but never data.
 */
export function parseWorkspaceManifest(bytes: Uint8Array): WorkspaceManifest | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as { v?: unknown; files?: unknown };
    if (obj.v !== WORKSPACE_MANIFEST_VERSION || !Array.isArray(obj.files)) return null;
    const files: WorkspaceFileEntry[] = [];
    for (const raw of obj.files) {
      if (typeof raw !== "object" || raw === null) return null;
      const e = raw as { p?: unknown; s?: unknown; m?: unknown };
      if (typeof e.p !== "string" || typeof e.s !== "number" || typeof e.m !== "number")
        return null;
      files.push({ p: e.p, s: e.s, m: e.m });
    }
    return { v: WORKSPACE_MANIFEST_VERSION, files };
  } catch {
    return null;
  }
}

export function serializeWorkspaceManifest(manifest: WorkspaceManifest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(manifest));
}

/**
 * The S3 key suffix for one workspace file, under the scope's `workspace-files/` prefix.
 *
 * The path is hashed rather than embedded. A workspace path is arbitrary author-controlled text —
 * spaces, unicode, `..`, control characters, or something long enough to breach S3's 1024-byte key
 * limit — and every one of those is a way to write outside the intended prefix or to make a key that
 * cannot be round-tripped. Hashing yields a fixed-width, always-safe suffix, and the manifest is what
 * maps it back to a path, so nothing needs to be decoded from the key itself.
 */
export function workspaceFileKeySuffix(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}
