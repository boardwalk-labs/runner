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
import { stat, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLogger } from "./support/index.js";

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

/** tar+gzip a directory to a file / extract one. Shells out to `tar` in production; injected in tests. */
export interface WorkspaceArchiver {
  /** Create a gzipped tar of `dir`'s CONTENTS at `destPath`; resolve to the archive's byte size. */
  archive(dir: string, destPath: string): Promise<number>;
  /** Extract a gzipped tar `srcPath` into `dir` (created if absent). */
  extract(srcPath: string, dir: string): Promise<void>;
}

/** The broker surface the store needs (RunnerControlClient satisfies it). */
export interface WorkspaceBrokerTransport {
  workspaceHydrateUrl(): Promise<string | null>;
  /** `sizeBytes` is the archive's on-disk size — the worker tars BEFORE presigning so the broker can
   *  record the workflow's storage footprint. `null` when the run isn't eligible. */
  workspacePersistUrl(sizeBytes: number): Promise<{ url: string; contentType: string } | null>;
  uploadBytes(url: string, headers: Record<string, string>, body: Uint8Array): Promise<void>;
  downloadBytes(url: string): Promise<Uint8Array | null>;
}

/** Minimal fs surface (so the store is unit-tested without touching disk). */
export interface WorkspaceFs {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  rm(path: string): Promise<void>;
}

export interface WorkspaceStoreDeps {
  broker: WorkspaceBrokerTransport;
  archiver: WorkspaceArchiver;
  fs: WorkspaceFs;
  /** The `/workspace` root to snapshot/restore. */
  workspaceRoot: string;
  /** Scratch path for the in-flight tarball. */
  tmpPath?: string;
  /** Snapshot tarballs larger than this are skipped (logged). Defaults to {@link WORKSPACE_SNAPSHOT_MAX_BYTES}. */
  maxSnapshotBytes?: number;
}

export class WorkspaceStore {
  private readonly tmpPath: string;
  private readonly maxSnapshotBytes: number;
  constructor(private readonly deps: WorkspaceStoreDeps) {
    // Scratch tarball path. Default to os.tmpdir() (which honors TMPDIR) rather than a machine-global
    // `/tmp/workspace-snapshot.tgz`: on a self-hosted runner the daemon points TMPDIR at the PER-RUN
    // dir, so the snapshot can't collide between concurrent daemons and doesn't sit in world-shared
    // `/tmp` where the crashed-window archive of a whole workspace would be readable. On the hosted
    // single-tenant worker it's the container's own `/tmp` (one run per container).
    this.tmpPath = deps.tmpPath ?? join(tmpdir(), "bw-workspace-snapshot.tgz");
    this.maxSnapshotBytes = deps.maxSnapshotBytes ?? WORKSPACE_SNAPSHOT_MAX_BYTES;
  }

  /** Restore the workflow's last `/workspace` snapshot at run start. No-op (logged) on any failure or
   *  when there's nothing to restore (not eligible, or a first run with no snapshot yet). */
  async hydrate(): Promise<void> {
    try {
      const url = await this.deps.broker.workspaceHydrateUrl();
      if (url === null) return; // not eligible (not opted-in / self-hosted)
      const bytes = await this.deps.broker.downloadBytes(url);
      if (bytes === null) return; // 404 — no snapshot yet (the workflow's first run)
      await mkdir(dirname(this.tmpPath), { recursive: true }); // per-run TMPDIR may not exist yet
      await this.deps.fs.writeFile(this.tmpPath, bytes);
      await this.deps.archiver.extract(this.tmpPath, this.deps.workspaceRoot);
      await this.deps.fs.rm(this.tmpPath);
      log.info("workspace_hydrated", { bytes: bytes.length });
    } catch (err) {
      log.warn("workspace_hydrate_failed", { error: errMsg(err) });
    }
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
    try {
      await mkdir(dirname(this.tmpPath), { recursive: true }); // per-run TMPDIR may not exist yet
      const size = await this.deps.archiver.archive(this.deps.workspaceRoot, this.tmpPath);
      // Guardrail: an oversized snapshot is dropped (logged), never read into memory or uploaded — the
      // workflow re-does filesystem work next run, as it would without persistence. Checked on the
      // on-disk archive size so the big tarball never hits the worker's heap.
      if (size > this.maxSnapshotBytes) {
        await this.deps.fs.rm(this.tmpPath);
        log.warn("workspace_persist_too_large", { bytes: size, maxBytes: this.maxSnapshotBytes });
        return 0;
      }
      const presign = await this.deps.broker.workspacePersistUrl(size);
      if (presign === null) {
        // Not eligible (e.g. self-hosted) — discard the archive we speculatively built.
        await this.deps.fs.rm(this.tmpPath);
        return 0;
      }
      const bytes = await this.deps.fs.readFile(this.tmpPath);
      await this.deps.broker.uploadBytes(
        presign.url,
        { "content-type": presign.contentType },
        bytes,
      );
      await this.deps.fs.rm(this.tmpPath);
      log.info("workspace_persisted", { bytes: size });
      return size;
    } catch (err) {
      log.warn("workspace_persist_failed", { error: errMsg(err) });
      return 0;
    }
  }
}

/** Production archiver — shells out to the runner image's `tar` (the runner has full shell tooling). */
export class TarWorkspaceArchiver implements WorkspaceArchiver {
  async archive(dir: string, destPath: string): Promise<number> {
    // `-C dir .` archives the CONTENTS of dir (not the dir itself), so extract restores it in place.
    await exec("tar", ["czf", destPath, "-C", dir, "."]);
    return (await stat(destPath)).size;
  }

  async extract(srcPath: string, dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await exec("tar", ["xzf", srcPath, "-C", dir]);
  }
}

/** Production fs — node's fs/promises. */
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
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
