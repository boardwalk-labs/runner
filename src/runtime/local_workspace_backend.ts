// LocalWorkspaceBackend — {@link WorkspaceBackend} over a directory on the runner's own disk.
//
// The self-hosted half of docs/WORKSPACE_PERSISTENCE.md I3: persistence has the same semantics on every
// substrate, and only the STORE changes. `runs_on` decides WHERE the bytes live, never WHETHER
// persistence happens. A self-hosted runner's workspace is the customer's data on the customer's disk,
// so we never upload it — but "don't upload it" used to be implemented as "don't persist it", and then
// as a `rm -rf` + `cp -r` that had a data-loss window the hosted path did not (§8, path 8):
//
//     rm -rf <scopeDir>      <-- crash here and the whole scope is gone
//     cp -r <workspace> <scopeDir>
//
// Persist runs before every sleep and freeze, so that window opened repeatedly through a long run. This
// backend has no destructive in-place step to crash inside: packs are immutable, content-addressed
// objects, the manifest is written by atomic rename, and reclamation happens only after the manifest
// naming the survivors has landed.
//
// Layout, mirroring the hosted scope prefix exactly:
//     <scopeDir>/manifest.json
//     <scopeDir>/packs/<digest>

import { mkdir, readFile, writeFile, rename, rm, stat, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "./support/index.js";
import type {
  WorkspaceBackend,
  WorkspaceReservation,
  ManifestWriteResult,
} from "./workspace_sync.js";

const log = createLogger("LocalWorkspaceBackend");

/** Directory name standing in for the BASE scope (a run with no environment). An environment id is a
 *  ULID, so it can never collide with this. */
const BASE_SCOPE_DIR = "_base";

/** How long to wait for the manifest lock before treating the write as a conflict. The lock is held
 *  only across a stat + rename, so anything approaching this means a crashed holder. */
const LOCK_TIMEOUT_MS = 2000;
const LOCK_RETRY_MS = 20;

/** The durable directory for one scope, under the runner's persist root. */
export function localScopeDir(
  persistRoot: string,
  workflowId: string,
  environmentId: string | null,
  workspaceKey: string | null,
): string {
  const scope = environmentId ?? BASE_SCOPE_DIR;
  return workspaceKey === null
    ? join(persistRoot, workflowId, scope)
    : join(persistRoot, workflowId, scope, "keys", workspaceKey);
}

export class LocalWorkspaceBackend implements WorkspaceBackend {
  private readonly manifestPath: string;
  private readonly packsDir: string;
  private readonly lockPath: string;

  constructor(private readonly scopeDir: string) {
    this.manifestPath = join(scopeDir, "manifest.json");
    this.packsDir = join(scopeDir, "packs");
    this.lockPath = join(scopeDir, "manifest.lock");
  }

  /** The customer's own disk, so there is no ceiling of ours to enforce and nothing to meter. A local
   *  run is fully eligible — that is I3: only the store changes. */
  reserve(): Promise<WorkspaceReservation> {
    return Promise.resolve({ ok: true });
  }

  async readManifest(): Promise<{ bytes: Uint8Array | null; generation: string | null }> {
    try {
      const bytes = await readFile(this.manifestPath);
      return { bytes: new Uint8Array(bytes), generation: await this.generation() };
    } catch (err) {
      if (isMissing(err)) return { bytes: null, generation: null };
      throw err;
    }
  }

  /**
   * Compare-and-swap the manifest.
   *
   * The generation is the file's (mtime, size). Two runs of one workflow can share a scope on a single
   * daemon, so the read-modify-write really can interleave, and a plain overwrite would silently drop
   * one run's merge. The check and the rename happen under an exclusive lock file, so there is no
   * window between them — the lock is held for microseconds, never across the pack uploads.
   */
  async writeManifest(bytes: Uint8Array, expected: string | null): Promise<ManifestWriteResult> {
    await mkdir(this.scopeDir, { recursive: true });
    const release = await this.lock();
    try {
      if ((await this.generation()) !== expected) return { ok: false, conflict: true };
      // Temp + rename: a reader either sees the whole previous manifest or the whole new one, never a
      // partial write. This is the property the old rm -rf + cp -r had no way to offer.
      const tmp = `${this.manifestPath}.${process.pid.toString(36)}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, this.manifestPath);
      return { ok: true, generation: await this.generation() };
    } finally {
      await release();
    }
  }

  async existingPacks(digests: readonly string[]): Promise<ReadonlySet<string>> {
    const present = new Set<string>();
    await Promise.all(
      digests.map(async (digest) => {
        try {
          await stat(this.packPath(digest));
          present.add(digest);
        } catch (err) {
          if (!isMissing(err)) throw err;
        }
      }),
    );
    return present;
  }

  /** Written by temp + rename, so a crash can never leave a short pack under a digest that promises
   *  its full contents. A concurrent writer producing the same digest writes identical bytes, so the
   *  rename racing itself is harmless. */
  async writePack(digest: string, bytes: Uint8Array): Promise<void> {
    const target = this.packPath(digest);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid.toString(36)}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, target);
  }

  async readPack(digest: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.packPath(digest)));
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async deletePacks(digests: readonly string[]): Promise<void> {
    await Promise.all(digests.map((d) => rm(this.packPath(d), { force: true })));
  }

  private packPath(digest: string): string {
    // The digest is validated as sha256 hex before it reaches here (manifest parsing rejects anything
    // else), so it cannot contain a separator and cannot escape the packs directory.
    return join(this.packsDir, digest);
  }

  /** `(mtimeMs, size)` of the manifest, or null when there is none. Cheap, and enough to detect that
   *  someone else wrote — the lock is what makes it safe to act on. */
  private async generation(): Promise<string | null> {
    try {
      const s = await stat(this.manifestPath);
      return `${String(s.mtimeMs)}:${String(s.size)}`;
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  /** Exclusive-create lock. Returns the release function. A stale lock (a crashed holder) times out
   *  into a conflict rather than blocking the run forever — losing one persist is recoverable, hanging
   *  a run is not. */
  private async lock(): Promise<() => Promise<void>> {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const handle = await open(this.lockPath, "wx");
        await handle.close();
        return async () => {
          await rm(this.lockPath, { force: true });
        };
      } catch (err) {
        if (!isExists(err)) throw err;
        if (Date.now() >= deadline) {
          log.warn("workspace_manifest_lock_timeout", { path: this.lockPath });
          // Break the stale lock rather than fail every subsequent persist of this scope forever.
          await rm(this.lockPath, { force: true });
          continue;
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
  }
}

function isMissing(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "ENOENT";
}

function isExists(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "EEXIST";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
