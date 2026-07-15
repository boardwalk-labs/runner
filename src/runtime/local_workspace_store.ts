// LocalWorkspaceStore — per-(workflow, environment) persistent `/workspace` on the RUNNER's OWN disk.
//
// The self-hosted half of docs/WORKSPACE_PERSISTENCE.md I3: persistence has the same semantics on
// every substrate, and only the STORE changes. `runs_on` decides WHERE the bytes live, never WHETHER
// persistence happens.
//
// Hosted runs push a tarball through broker-presigned S3 URLs (workspace_store.ts). A self-hosted
// runner must never do that — its workspace is the customer's data on the customer's disk, and we
// don't store it (the broker returns null URLs for self-hosted runs, by design). But the answer to
// "don't upload it" was "don't persist it at all", so `workspace.persist` and `agent({ memory })`
// were SILENT no-ops on self-hosted: the same workflow compounded state on dev and hosted, and
// quietly forgot everything on a self-hosted runner. This is the missing third store — a plain
// directory tree the daemon owns, mirroring what the OSS engine does locally (boardwalk's
// run_dir.ts), with no network and no tarball.
//
// Layout: <persistRoot>/<workflowId>/<environmentId ?? _base>. Same scope key as the hosted S3 key,
// for the same reason — one workflow program runs against N environments (§4).

import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "./support/index.js";
import type { PersistSelection } from "./workspace_store.js";

const log = createLogger("LocalWorkspaceStore");

/** Directory name standing in for the BASE scope (a run with no environment). An environment id is a
 *  ULID, so it can never collide with this. */
const BASE_SCOPE_DIR = "_base";

/** The durable directory for one scope, under the runner's persist root. */
export function localScopeDir(
  persistRoot: string,
  workflowId: string,
  environmentId: string | null,
): string {
  return join(persistRoot, workflowId, environmentId ?? BASE_SCOPE_DIR);
}

export interface LocalWorkspaceStoreDeps {
  /** This scope's durable directory ({@link localScopeDir}). */
  scopeDir: string;
  /** The run's `/workspace` — hydrated into at start, snapshotted from at terminal. */
  workspaceRoot: string;
  /** What to persist, read AT PERSIST TIME: the manifest's declaration ∪ the run's memory dirs. */
  selection: () => PersistSelection;
}

export class LocalWorkspaceStore {
  constructor(private readonly deps: LocalWorkspaceStoreDeps) {}

  /** Copy this scope's durable state into the run's workspace. No-op on the first run (nothing
   *  persisted yet). Best-effort, like the hosted store: a restore miss must not fail the run — the
   *  workflow just re-does filesystem work, exactly as it would without persistence. */
  async hydrate(): Promise<void> {
    try {
      if (!(await exists(this.deps.scopeDir))) return; // first run of this scope
      // The durable root only ever holds what a previous run persisted (declared dirs + memory
      // dirs), so all of it belongs in the workspace.
      await cp(this.deps.scopeDir, this.deps.workspaceRoot, { recursive: true });
      log.info("workspace_hydrated_local", { scopeDir: this.deps.scopeDir });
    } catch (err) {
      log.warn("workspace_hydrate_local_failed", { error: errMsg(err) });
    }
  }

  /** Replace this scope's durable state with the run's. Returns the bytes written for the caller's
   *  logging — 0 on a no-op/failure, mirroring the hosted store's contract. */
  async persist(): Promise<number> {
    try {
      const selection = this.deps.selection();
      if (selection === true) {
        // The whole workspace compounds: replace the scope wholesale, so a file the run DELETED is
        // actually gone next run rather than resurrected from the old copy.
        await rm(this.deps.scopeDir, { recursive: true, force: true });
        await mkdir(dirname(this.deps.scopeDir), { recursive: true });
        await cp(this.deps.workspaceRoot, this.deps.scopeDir, { recursive: true });
        return await dirSize(this.deps.scopeDir);
      }
      if (selection.length === 0) return 0; // nothing declared, no memory used — the common case
      for (const dir of selection) {
        const source = join(this.deps.workspaceRoot, dir);
        const target = join(this.deps.scopeDir, dir);
        // Replace per-dir (not merge) for the same reason as above: a deletion inside a persisted
        // dir must survive. A declared dir the run never created is simply skipped.
        await rm(target, { recursive: true, force: true });
        if (!(await exists(source))) continue;
        await mkdir(dirname(target), { recursive: true });
        await cp(source, target, { recursive: true });
      }
      return await dirSize(this.deps.scopeDir);
    } catch (err) {
      log.warn("workspace_persist_local_failed", { error: errMsg(err) });
      return 0;
    }
  }
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

/** Bytes on disk under `dir` — reported for parity with the hosted store's return, never metered
 *  (self-hosted storage is the customer's own disk, so it is not our storage counter's business). */
async function dirSize(dir: string): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const s = await stat(join(entry.parentPath, entry.name)).catch(() => null);
    total += s?.size ?? 0;
  }
  return total;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
