// WorkspaceStore — per-workflow persistent /workspace, broker-mediated (the Runner Credential Broker model).
//
// Hosted runs that opt in (manifest `workspace.persist`) get a `/workspace` that survives ACROSS runs
// of the workflow + across a crash-restart. It is NOT a mounted shared filesystem — that would be
// readable by the untrusted in-process program across tenants (the program is arbitrary JS with raw
// `fs` access). Instead the worker tars `/workspace` and pushes/pulls it through BROKER-scoped S3
// URLs keyed PER WORKFLOW (the broker derives the key from the run token), so even raw `fs` can't
// reach another tenant's snapshot. The broker also gates eligibility server-side (hosted + opt-in)
// and returns null URLs otherwise — so this store no-ops cleanly when not eligible.
//
// Best-effort by design: hydrate/persist failures are logged, never thrown — a snapshot miss must not
// fail the run (worst case the workflow re-does filesystem work, as it would without persistence).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat, lstat, readdir, mkdir, readFile, writeFile, rm, utimes } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";
import { extract as tarExtract } from "tar";
import { createLogger } from "./support/index.js";
import type { RunEventBody } from "./agent/events.js";
import {
  diffWorkspace,
  parseWorkspaceManifest,
  serializeWorkspaceManifest,
  MAX_DELTA_FILES,
  type WorkspaceFileEntry,
  type WorkspaceManifest,
} from "./workspace_delta.js";

const log = createLogger("WorkspaceStore");
const exec = promisify(execFile);

/** Hard ceiling on a persisted `/workspace` snapshot (the gzipped tarball). A run whose snapshot
 *  exceeds this SKIPS persisting (logged) rather than uploading — a cost/abuse guardrail on both
 *  unbounded S3 growth and the worker's own in-memory read of the tarball (the worker task has 2 GiB;
 *  this keeps the read buffer to ~1/4 of it). Generous: 512 MiB COMPRESSED is a large amount of
 *  compounding state. The check is on the ON-DISK archive size, BEFORE the read, so an oversized
 *  workspace never enters memory. NOT a security boundary (tenant isolation is the per-workflow key);
 *  purely a guardrail, like the run budget's `max_usd`. */
export const WORKSPACE_SNAPSHOT_MAX_BYTES = 512 * 1024 * 1024;

/** Parallel per-file transfers in a delta. Bounded so a wide delta can't open a socket per file. */
const DELTA_UPLOAD_CONCURRENCY = 16;

/** Per-path workspace objects are opaque bytes — the manifest, not the object, carries the metadata. */
const WORKSPACE_FILE_CONTENT_TYPE = "application/octet-stream";

/** What a run persists: the WHOLE workspace, or exactly these workspace-relative dirs (possibly none). */
export type PersistSelection = true | readonly string[];

/**
 * Resolve what this run persists (docs/WORKSPACE_PERSISTENCE.md §3): the manifest's declaration
 * UNIONED with every `agent({ memory })` dir the run actually used.
 *
 * The union is why this is resolved at PERSIST time, not construction time: memory dirs are
 * undeclared by design (`sdk/src/types.ts` — "`mcp` servers, `skills`, and `memory` — the manifest
 * declares none of them"), so they are only known once the run has made the agent calls. A workflow
 * whose manifest says nothing at all still persists, iff it used memory.
 *
 * `true` swallows the list: the whole workspace already contains every memory dir. An empty array
 * means persist nothing, which is the common case and must stay cheap.
 */
export function resolvePersistSelection(
  declared: boolean | readonly string[] | undefined,
  memoryDirs: ReadonlySet<string>,
): PersistSelection {
  if (declared === true) return true;
  const list = declared === undefined || declared === false ? [] : declared;
  return [...new Set([...list, ...memoryDirs])];
}

/** tar+gzip a directory to a file / extract one. Shells out to `tar` in production; injected in tests. */
export interface WorkspaceArchiver {
  /** Create a gzipped tar of `dir`'s CONTENTS at `destPath`; resolve to the archive's byte size.
   *  `paths` (workspace-relative, already filtered to those that exist) narrows the archive to
   *  exactly those entries — the `persist: [...]` form. Omitted ⇒ the whole tree (`persist: true`). */
  archive(dir: string, destPath: string, paths?: readonly string[]): Promise<number>;
  /** Extract a gzipped tar `srcPath` into `dir` (created if absent). */
  extract(srcPath: string, dir: string): Promise<void>;
}

/**
 * The broker's answer: a grant, or a refusal that says WHY. A union rather than `| null` because the
 * two refusals are not interchangeable — `not_eligible` is an ordinary no-op (self-hosted keeps the
 * workspace on the customer's disk), while `storage_limit` means the run produced a snapshot and the
 * platform threw it away, which the author has to be told about.
 */
export type WorkspacePersistGrant =
  | { url: string; contentType: string }
  | { url: null; reason: "not_eligible" | "storage_limit" };

/** Presigned URLs for a batch of per-path workspace objects, keyed by workspace-relative path. */
export type WorkspaceFileUrls = Record<string, string>;

/** The broker surface the store needs (RunnerControlClient satisfies it). */
export interface WorkspaceBrokerTransport {
  workspaceHydrateUrl(): Promise<string | null>;
  /** `sizeBytes` is the archive's on-disk size — the worker tars BEFORE presigning so the broker can
   *  record the workflow's storage footprint. */
  workspacePersistUrl(sizeBytes: number): Promise<WorkspacePersistGrant>;
  uploadBytes(url: string, headers: Record<string, string>, body: Uint8Array): Promise<void>;
  downloadBytes(url: string): Promise<Uint8Array | null>;

  // ---- Delta sync (docs/WORKSPACE_PERSISTENCE.md §5.2) ----
  // Absent on an older broker; the store feature-detects and falls back to the whole-tarball path,
  // so a runner ahead of the control plane still persists correctly, just not incrementally.

  /** Presign a GET for this scope's manifest. `null` when the run isn't eligible. */
  workspaceManifestGetUrl?(): Promise<string | null>;
  /** Presign a PUT for this scope's manifest. `totalBytes` is the scope's whole footprint (the sum
   *  of its files), which the broker gates and records exactly as it does a tarball's size. */
  workspaceManifestPutUrl?(totalBytes: number): Promise<WorkspacePersistGrant>;
  /** Presign PUT or GET for a batch of per-path objects. Batched because a delta touches many. */
  workspaceFileUrls?(op: "put" | "get", paths: readonly string[]): Promise<WorkspaceFileUrls>;
  /** Delete the objects for paths no longer on disk. Without this a persisted workspace grows
   *  monotonically as an agent creates and removes scratch files. */
  workspaceDeleteFiles?(paths: readonly string[]): Promise<void>;
}

/**
 * Emit-only view of the run's event emitter, for telling the AUTHOR a snapshot was dropped. Required
 * rather than optional on purpose: an optional sink is one a future construction site forgets to
 * pass, which reintroduces the exact invisibility this seam exists to fix.
 */
export interface WorkspaceEventSink {
  emit(body: RunEventBody): unknown;
}

/**
 * Cheap summary of what a selection currently holds, used to skip a persist that would rewrite bytes
 * we already stored. `null` means "could not tell" — the caller then persists rather than risk
 * skipping a real change, so a broken walk costs work, never data.
 */
export interface WorkspaceFingerprinter {
  fingerprint(root: string, paths: readonly string[] | undefined): Promise<string | null>;
}

/** Minimal fs surface (so the store is unit-tested without touching disk). */
export interface WorkspaceFs {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  rm(path: string): Promise<void>;
  /** Does this path exist? Used to narrow a `persist: [...]` selection to the dirs the run actually
   *  created — `tar` fails the whole archive on one missing member, and a declared-but-unused dir is
   *  normal (a workflow declares `["cache", "index"]` and only writes `cache` on its first run). */
  exists(path: string): Promise<boolean>;
  /** Every regular file under the selection, with the size + mtime the delta diffs on. Absent ⇒ the
   *  store stays on the whole-tarball path. */
  walk?(root: string, paths: readonly string[] | undefined): Promise<WorkspaceFileEntry[]>;
  /** Write `data` to a workspace-relative path, creating parent dirs (delta hydrate). `mtimeMs`
   *  restores the recorded modification time, which is what keeps the next diff from seeing every
   *  restored file as changed. */
  writeUnder?(root: string, relPath: string, data: Uint8Array, mtimeMs?: number): Promise<void>;
}

export interface WorkspaceStoreDeps {
  broker: WorkspaceBrokerTransport;
  archiver: WorkspaceArchiver;
  fs: WorkspaceFs;
  /** Where a dropped snapshot is reported to the author (see {@link WorkspaceEventSink}). */
  events: WorkspaceEventSink;
  /** Change detection for the unchanged-persist skip. Omit to disable the skip (always persist). */
  fingerprinter?: WorkspaceFingerprinter;
  /** The `/workspace` root to snapshot/restore. */
  workspaceRoot: string;
  /** What to persist, read AT PERSIST TIME (see {@link resolvePersistSelection}) — the run's memory
   *  dirs aren't known until its agent calls have run, so this cannot be a construction-time value. */
  selection: () => PersistSelection;
  /** Scratch path for the in-flight tarball. */
  tmpPath?: string;
  /** Snapshot tarballs larger than this are skipped (logged). Defaults to {@link WORKSPACE_SNAPSHOT_MAX_BYTES}. */
  maxSnapshotBytes?: number;
}

export class WorkspaceStore {
  private readonly tmpPath: string;
  private readonly maxSnapshotBytes: number;
  /** Fingerprint of the last snapshot THIS run actually stored. Seeded only from a persist we
   *  performed — never from hydrate, where the selection isn't known yet (memory dirs register as
   *  the run's agent calls happen), so a hydrate-time fingerprint could cover the wrong file set. */
  private lastStoredFingerprint: string | null = null;
  /** This run's view of the stored manifest. `undefined` = not read yet; `null` = no manifest for
   *  this scope (a first persist, or one still on the tarball). */
  private storedManifest: WorkspaceManifest | null | undefined = undefined;
  /** Set when a restore died partway through writing the workspace. Non-null DISARMS persist for the
   *  rest of the run — see {@link hydrate}. */
  private restoreFailure: string | null = null;
  constructor(private readonly deps: WorkspaceStoreDeps) {
    // Scratch tarball path. Default to os.tmpdir() (which honors TMPDIR) rather than a machine-global
    // `/tmp/workspace-snapshot.tgz`: on a self-hosted runner the daemon points TMPDIR at the PER-RUN
    // dir, so the snapshot can't collide between concurrent daemons and doesn't sit in world-shared
    // `/tmp` where the crashed-window archive of a whole workspace would be readable. On the hosted
    // single-tenant worker it's the container's own `/tmp` (one run per container).
    this.tmpPath = deps.tmpPath ?? join(tmpdir(), "bw-workspace-snapshot.tgz");
    this.maxSnapshotBytes = deps.maxSnapshotBytes ?? WORKSPACE_SNAPSHOT_MAX_BYTES;
  }

  /**
   * Restore the workflow's last `/workspace` snapshot at run start. A no-op when there is nothing to
   * restore (not eligible, or a first run with no snapshot yet).
   *
   * A restore that fails AFTER it began writing is the dangerous case, and it is not hypothetical:
   * node-tar aborts a gzip stream past `maxDecompressionRatio` (1000:1), which a zero-filled or
   * highly repetitive workspace can trip, leaving the tree half-extracted. The damage was never the
   * bad read — it was that the run's next persist wrote that half-extracted tree back as the new
   * stored baseline, turning a failed restore into permanent corruption. So a partial restore now
   * DISARMS persistence for the rest of the run (§5.3).
   */
  async hydrate(): Promise<void> {
    try {
      // A scope written by the delta path has a manifest; one written before it (or by the
      // too-many-files fallback) has only the tarball. Try the manifest first and fall through, so
      // an upgrade migrates a scope on its next persist with no restore gap in between. A failure
      // here (e.g. a control plane without the endpoints) also falls through rather than aborting.
      try {
        if (await this.hydrateDelta()) return;
      } catch (err) {
        log.warn("workspace_delta_hydrate_failed_falling_back", { error: errMsg(err) });
      }

      const url = await this.deps.broker.workspaceHydrateUrl();
      if (url === null) return; // not eligible (not opted-in / self-hosted)
      const bytes = await this.deps.broker.downloadBytes(url);
      if (bytes === null) return; // 404 — no snapshot yet (the workflow's first run)
      await mkdir(dirname(this.tmpPath), { recursive: true }); // per-run TMPDIR may not exist yet
      await this.deps.fs.writeFile(this.tmpPath, bytes);
      // Everything above is safe to fail — nothing has touched the workspace yet. The extract is the
      // first step that WRITES there, so a throw past this point may leave a half-restored tree.
      try {
        await this.deps.archiver.extract(this.tmpPath, this.deps.workspaceRoot);
      } catch (err) {
        this.disarmAfterPartialRestore(err);
        return;
      }
      await this.deps.fs.rm(this.tmpPath);
      log.info("workspace_hydrated", { bytes: bytes.length });
    } catch (err) {
      log.warn("workspace_hydrate_failed", { error: errMsg(err) });
    }
  }

  /** A restore died partway through writing the workspace. Refuse to persist for the rest of the run
   *  so the half-restored tree can't overwrite the good stored snapshot, and tell the author. */
  private disarmAfterPartialRestore(err: unknown): void {
    this.restoreFailure = errMsg(err);
    log.warn("workspace_restore_partial", { error: this.restoreFailure });
    this.reportSkipped({
      reason: "error",
      detail: `restore failed partway (${this.restoreFailure}); this run will not save its workspace, to avoid overwriting the stored snapshot with a partially restored one`,
    });
  }

  /** Snapshot `/workspace` to durable storage. Best-effort; no-op when the run isn't eligible.
   *  Returns the snapshot's byte size (0 on a no-op / failure) for the caller's logging.
   *
   *  Archives FIRST so the snapshot's exact byte size travels to the broker on the presign request
   *  (the broker records it for the org storage counter + daily meter — the snapshot overwrites one
   *  per-workflow key, so it IS the workflow's footprint). This store is only constructed when the
   *  manifest opts into persistence, so archiving-first never runs for a non-persist workflow; the
   *  only redundant archive is a self-hosted+persist run, where the broker returns a null URL. */
  async persist(): Promise<number> {
    // A restore that died partway left a tree that is NOT this scope's state. Writing it back would
    // convert a failed restore into permanent corruption, so the stored snapshot wins: we keep it and
    // lose this run's changes. hydrate() already told the author why (§5.3).
    if (this.restoreFailure !== null) {
      log.warn("workspace_persist_disarmed", { reason: this.restoreFailure });
      return 0;
    }
    try {
      // What this run actually compounds: the manifest's declaration ∪ the memory dirs it used.
      // Nothing selected is the common case (a workflow that opted into neither) — return before any
      // fs or broker work, so persistence costs a run that doesn't use it precisely nothing.
      const selection = this.deps.selection();
      const paths = selection === true ? undefined : await this.presentPaths(selection);
      if (paths !== undefined && paths.length === 0) return 0;

      // Delta path: upload only what changed. Falls through to the whole-tarball path below when the
      // broker or fs lacks the seam, when the tree is too large to address per-file, or when the
      // delta itself fails — a runner whose control plane hasn't deployed the endpoints yet gets
      // 404s here, and that must cost a full tarball persist, never a lost one.
      let delta: number | null = null;
      try {
        delta = await this.persistDelta(paths);
      } catch (err) {
        log.warn("workspace_delta_failed_falling_back", { error: errMsg(err) });
      }
      if (delta !== null) return delta;

      // persist() runs before EVERY sleep and freeze, not just at the end, so a long agent that
      // sleeps in a loop re-tars and re-uploads its whole workspace once per iteration. Skip when
      // nothing changed since the snapshot we already stored: identical bytes, and on the freeze
      // path this copy is only crash insurance anyway (the VM snapshot carries the real workspace).
      const fingerprint = await this.fingerprintNow(paths);
      if (fingerprint !== null && fingerprint === this.lastStoredFingerprint) {
        log.info("workspace_persist_unchanged");
        return 0;
      }

      await mkdir(dirname(this.tmpPath), { recursive: true }); // per-run TMPDIR may not exist yet
      const size = await this.deps.archiver.archive(this.deps.workspaceRoot, this.tmpPath, paths);
      // Guardrail: an oversized snapshot is dropped (logged), never read into memory or uploaded — the
      // workflow re-does filesystem work next run, as it would without persistence. Checked on the
      // on-disk archive size so the big tarball never hits the worker's heap.
      if (size > this.maxSnapshotBytes) {
        await this.deps.fs.rm(this.tmpPath);
        log.warn("workspace_persist_too_large", { bytes: size, maxBytes: this.maxSnapshotBytes });
        this.reportSkipped({ reason: "too_large", bytes: size, maxBytes: this.maxSnapshotBytes });
        return 0;
      }
      const presign = await this.deps.broker.workspacePersistUrl(size);
      if (presign.url === null) {
        // Discard the archive we speculatively built. Only a REFUSAL is worth reporting —
        // `not_eligible` is self-hosted, where the workspace lives on the customer's disk.
        await this.deps.fs.rm(this.tmpPath);
        if (presign.reason === "storage_limit") {
          log.warn("workspace_persist_over_storage_limit", { bytes: size });
          this.reportSkipped({ reason: "storage_limit", bytes: size });
        }
        return 0;
      }
      const bytes = await this.deps.fs.readFile(this.tmpPath);
      await this.deps.broker.uploadBytes(
        presign.url,
        { "content-type": presign.contentType },
        bytes,
      );
      await this.deps.fs.rm(this.tmpPath);
      this.lastStoredFingerprint = fingerprint;
      log.info("workspace_persisted", { bytes: size });
      return size;
    } catch (err) {
      // Best-effort must never fail the run — but that was being used to justify swallowing the
      // failure outright. The run still succeeds; the author now learns state didn't carry forward.
      log.warn("workspace_persist_failed", { error: errMsg(err) });
      this.reportSkipped({ reason: "error", detail: errMsg(err) });
      return 0;
    }
  }

  /**
   * Restore from the per-path objects a manifest describes. Returns true when it handled the
   * restore; false means "no manifest for this scope" and the caller falls back to the tarball.
   */
  private async hydrateDelta(): Promise<boolean> {
    const b = this.deps.broker;
    if (b.workspaceFileUrls === undefined || this.deps.fs.writeUnder === undefined) return false;
    const manifest = await this.loadStoredManifest();
    if (manifest === null) return false;
    // An empty manifest is a real, restorable state (the scope was emptied), not a missing one — and
    // it must not fall through to the tarball, which would restore files the run deleted.
    if (manifest.files.length === 0) {
      log.info("workspace_hydrated", { mode: "delta", files: 0 });
      return true;
    }

    const urls = await b.workspaceFileUrls(
      "get",
      manifest.files.map((e) => e.p),
    );
    const queue = [...manifest.files];
    let restored = 0;
    const workers = Array.from({ length: Math.min(DELTA_UPLOAD_CONCURRENCY, queue.length) }, () =>
      (async (): Promise<void> => {
        for (let e = queue.pop(); e !== undefined; e = queue.pop()) {
          const url = urls[e.p];
          if (url === undefined) continue;
          const bytes = await this.deps.broker.downloadBytes(url);
          if (bytes === null) continue; // object vanished — the run re-creates it, as with no snapshot
          try {
            // Restore the recorded mtime with the bytes. Without it every restored file looks NEW to
            // the next diff — the whole workspace re-uploads on every run and the delta only ever
            // saves work WITHIN a run, which is most of the point gone. `tar` preserves mtimes, so
            // the tarball path never had this; per-file writes have to do it explicitly.
            await this.deps.fs.writeUnder?.(this.deps.workspaceRoot, e.p, bytes, e.m);
          } catch (err) {
            // Same rule as the tarball path: once a restore has begun writing, a failure leaves a
            // tree that must never be persisted back over the stored snapshot.
            this.disarmAfterPartialRestore(err);
            return;
          }
          restored += 1;
        }
      })(),
    );
    await Promise.all(workers);
    log.info("workspace_hydrated", { mode: "delta", files: restored, of: manifest.files.length });
    return true;
  }

  /**
   * Persist by uploading only what changed. Returns the scope's byte size, or `null` meaning "not
   * applicable — use the whole-tarball path".
   *
   * Returns null (rather than throwing) for every reason the delta can't run: an older broker
   * without the seams, an fs without `walk`, or a tree past {@link MAX_DELTA_FILES}. Falling back
   * keeps a runner that is ahead of its control plane persisting correctly, just not incrementally.
   */
  private async persistDelta(paths: readonly string[] | undefined): Promise<number | null> {
    const b = this.deps.broker;
    if (
      b.workspaceManifestGetUrl === undefined ||
      b.workspaceManifestPutUrl === undefined ||
      b.workspaceFileUrls === undefined ||
      b.workspaceDeleteFiles === undefined ||
      this.deps.fs.walk === undefined
    ) {
      return null;
    }

    const local = await this.deps.fs.walk(this.deps.workspaceRoot, paths);
    if (local.length > MAX_DELTA_FILES) {
      // One request per file would turn a single upload into tens of thousands. Degrade to the
      // tarball rather than optimize for the documented anti-pattern (persist: true over a
      // dependency tree).
      log.info("workspace_delta_too_many_files", { files: local.length, max: MAX_DELTA_FILES });
      return null;
    }

    const previous = await this.loadStoredManifest();
    const delta = diffWorkspace(local, previous);

    // Nothing moved: skip the manifest write too. This is the delta's own version of the unchanged
    // skip, and it subsumes the fingerprint one whenever the delta path is live.
    if (delta.upload.length === 0 && delta.delete.length === 0 && previous !== null) {
      log.info("workspace_persist_unchanged", { mode: "delta" });
      return delta.totalBytes;
    }

    // Gate + record the scope's FULL footprint before writing anything, so an over-limit scope is
    // refused exactly as an over-limit tarball is — and reported to the author the same way.
    const grant = await b.workspaceManifestPutUrl(delta.totalBytes);
    if (grant.url === null) {
      if (grant.reason === "storage_limit") {
        log.warn("workspace_persist_over_storage_limit", { bytes: delta.totalBytes });
        this.reportSkipped({ reason: "storage_limit", bytes: delta.totalBytes });
      }
      return 0;
    }

    if (delta.upload.length > 0) {
      const urls = await b.workspaceFileUrls(
        "put",
        delta.upload.map((e) => e.p),
      );
      await this.uploadFiles(delta.upload, urls);
    }
    // Delete BEFORE the manifest lands: a crash between them leaves objects the next manifest no
    // longer references, which is wasted bytes. The reverse order would leave the manifest pointing
    // at objects that are already gone, which is a failed hydrate.
    if (delta.delete.length > 0) await b.workspaceDeleteFiles(delta.delete);

    await b.uploadBytes(
      grant.url,
      { "content-type": grant.contentType },
      serializeWorkspaceManifest(delta.next),
    );
    this.storedManifest = delta.next;
    log.info("workspace_persisted", {
      mode: "delta",
      bytes: delta.totalBytes,
      uploaded: delta.upload.length,
      deleted: delta.delete.length,
    });
    return delta.totalBytes;
  }

  /** Upload each changed file, bounded so a wide delta can't open thousands of sockets at once. */
  private async uploadFiles(
    entries: readonly WorkspaceFileEntry[],
    urls: WorkspaceFileUrls,
  ): Promise<void> {
    const queue = [...entries];
    const workers = Array.from({ length: Math.min(DELTA_UPLOAD_CONCURRENCY, queue.length) }, () =>
      (async (): Promise<void> => {
        for (let e = queue.pop(); e !== undefined; e = queue.pop()) {
          const url = urls[e.p];
          if (url === undefined) continue; // broker declined this path — the manifest still lists it
          const body = await this.deps.fs.readFile(join(this.deps.workspaceRoot, e.p));
          await this.deps.broker.uploadBytes(
            url,
            { "content-type": WORKSPACE_FILE_CONTENT_TYPE },
            body,
          );
        }
      })(),
    );
    await Promise.all(workers);
  }

  /** This run's view of what is stored: the manifest read at hydrate, or written by the last persist.
   *  `null` means unknown, which makes the next diff upload everything — work, never data loss. */
  private async loadStoredManifest(): Promise<WorkspaceManifest | null> {
    if (this.storedManifest !== undefined) return this.storedManifest;
    const b = this.deps.broker;
    if (b.workspaceManifestGetUrl === undefined) return null;
    try {
      const url = await b.workspaceManifestGetUrl();
      if (url === null) return null;
      const bytes = await this.deps.broker.downloadBytes(url);
      const parsed = bytes === null ? null : parseWorkspaceManifest(bytes);
      this.storedManifest = parsed;
      return parsed;
    } catch (err) {
      log.warn("workspace_manifest_read_failed", { error: errMsg(err) });
      return null;
    }
  }

  /** Fingerprint the selection, or `null` when we can't (no fingerprinter, or the walk failed).
   *  `null` always means "persist" — never skip on a fingerprint we don't trust. */
  private async fingerprintNow(paths: readonly string[] | undefined): Promise<string | null> {
    if (this.deps.fingerprinter === undefined) return null;
    try {
      return await this.deps.fingerprinter.fingerprint(this.deps.workspaceRoot, paths);
    } catch (err) {
      log.warn("workspace_fingerprint_failed", { error: errMsg(err) });
      return null;
    }
  }

  /** Put a dropped snapshot on the run's event stream. Swallows its own errors: failing to REPORT a
   *  failure must not escalate into failing the run. The `log.warn` at each call site is the backstop. */
  private reportSkipped(detail: {
    reason: "too_large" | "storage_limit" | "error";
    bytes?: number;
    maxBytes?: number;
    detail?: string;
  }): void {
    try {
      this.deps.events.emit({ kind: "workspace_persist_skipped", ...detail });
    } catch (err) {
      log.warn("workspace_persist_skipped_report_failed", { error: errMsg(err) });
    }
  }

  /** Narrow a selection to the dirs that exist: `tar` fails the whole archive on one missing member,
   *  and declaring a dir the run hasn't written yet is ordinary (first run of `persist: ["cache"]`). */
  private async presentPaths(selection: readonly string[]): Promise<string[]> {
    const checked = await Promise.all(
      selection.map(async (p) =>
        (await this.deps.fs.exists(join(this.deps.workspaceRoot, p))) ? p : null,
      ),
    );
    return checked.filter((p): p is string => p !== null);
  }
}

/** Production archiver — shells out to the runner image's `tar` (the runner has full shell tooling). */
export class TarWorkspaceArchiver implements WorkspaceArchiver {
  async archive(dir: string, destPath: string, paths?: readonly string[]): Promise<number> {
    // `-C dir <members>` archives relative to dir, so extract restores in place either way: `.` for
    // the whole tree (`persist: true`), or exactly the named dirs (`persist: [...]` ∪ memory dirs).
    // Members are workspace-relative and schema-validated (no `..`, no absolute, no backslashes —
    // sdk/src/manifest.ts `persistPath`) and pre-filtered to those that exist; `--` keeps a name
    // that starts with `-` from being read as a flag.
    const members = paths === undefined ? ["."] : [...paths];
    await exec("tar", ["czf", destPath, "-C", dir, "--", ...members]);
    return (await stat(destPath)).size;
  }

  async extract(srcPath: string, dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    // Extract via node-tar, NOT `tar xzf`: extraction reads UNTRUSTED input (a program artifact
    // from an arbitrary control plane on a self-hosted runner, or a prior run's workspace snapshot),
    // and node-tar is hardened + portable — with default `preservePaths: false` it strips absolute
    // paths and `..` members, and refuses to write THROUGH a symlink (unlinking it first), closing
    // the traversal/symlink-escape gaps that differ between GNU tar and bsdtar. Same behavior on
    // macOS and Linux, no dependency on which `tar` the OS ships.
    await tarExtract({ file: srcPath, cwd: dir });
  }
}

/** Production fs — node's fs/promises. */
/**
 * Fingerprints a selection as the sorted set of (relative path, size, mtime) over its files.
 *
 * Same change-detection heuristic rsync and incremental tar use by default, and it inherits the same
 * caveat: a file rewritten to the SAME byte length whose mtime is then restored reads as unchanged.
 * That needs deliberate effort (agents append, create, and rewrite, all of which move mtime), and the
 * alternative — hashing every byte before every sleep — reintroduces the O(total bytes) cost this
 * exists to remove. Any failure returns null, which persists rather than skips.
 */
export class StatWorkspaceFingerprinter implements WorkspaceFingerprinter {
  async fingerprint(root: string, paths: readonly string[] | undefined): Promise<string | null> {
    try {
      const roots = paths === undefined ? [root] : paths.map((p) => join(root, p));
      const entries: string[] = [];
      for (const dir of roots) await collectEntries(dir, root, entries);
      entries.sort();
      return createHash("sha256").update(entries.join("\n")).digest("hex");
    } catch {
      return null; // unreadable tree — persist rather than risk skipping a real change
    }
  }
}

/** Walk `target` (file or dir), appending one `path\0size\0mtime` line per regular file. Symlinks are
 *  recorded by their own metadata and never followed, so a link loop can't hang the walk. */
async function collectEntries(target: string, root: string, out: string[]): Promise<void> {
  const st = await lstat(target).catch(() => null);
  if (st === null) return; // vanished mid-walk — the archive step is the source of truth
  if (st.isDirectory()) {
    const names = await readdir(target);
    for (const name of names) await collectEntries(join(target, name), root, out);
    return;
  }
  out.push(`${relative(root, target)}\0${st.size}\0${st.mtimeMs}`);
}

export class NodeWorkspaceFs implements WorkspaceFs {
  readFile(path: string): Promise<Uint8Array> {
    return readFile(path);
  }
  writeFile(path: string, data: Uint8Array): Promise<void> {
    return writeFile(path, data);
  }
  rm(path: string): Promise<void> {
    return rm(path, { force: true });
  }
  async exists(path: string): Promise<boolean> {
    return (await stat(path).catch(() => null)) !== null;
  }

  async walk(root: string, paths: readonly string[] | undefined): Promise<WorkspaceFileEntry[]> {
    const roots = paths === undefined ? [root] : paths.map((p) => join(root, p));
    const out: WorkspaceFileEntry[] = [];
    for (const dir of roots) await collectFiles(dir, root, out);
    // Sorted so a manifest is stable across walks — a reordered file list would otherwise churn the
    // stored JSON on every persist even when nothing changed.
    out.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
    return out;
  }

  async writeUnder(
    root: string,
    relPath: string,
    data: Uint8Array,
    mtimeMs?: number,
  ): Promise<void> {
    const target = join(root, relPath);
    // The manifest is ours, but it round-trips through S3, so treat its paths as untrusted: a `..`
    // entry must not let a restore write outside the workspace.
    const rel = relative(root, target);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`workspace path escapes the workspace root: ${relPath}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
    if (mtimeMs !== undefined) {
      const seconds = mtimeMs / 1000;
      await utimes(target, seconds, seconds);
    }
  }
}

/** Walk `target`, appending one entry per regular file. Symlinks are skipped rather than followed:
 *  a link's target is either inside the selection (already walked) or outside it (not ours to copy),
 *  and following one is how a link loop hangs the walk. */
async function collectFiles(
  target: string,
  root: string,
  out: WorkspaceFileEntry[],
): Promise<void> {
  const st = await lstat(target).catch(() => null);
  if (st === null) return; // vanished mid-walk
  if (st.isDirectory()) {
    for (const name of await readdir(target)) await collectFiles(join(target, name), root, out);
    return;
  }
  if (!st.isFile()) return;
  out.push({ p: relative(root, target), s: st.size, m: st.mtimeMs });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
