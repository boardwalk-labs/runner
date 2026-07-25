// WorkspaceStore — the run-facing wrapper over {@link WorkspaceSync}.
//
// The algorithm and the storage layout live in workspace_sync.ts / workspace_format.ts; this holds the
// two things that are about a RUN rather than about bytes:
//
//   1. **What to persist**, resolved at PERSIST time — the manifest's declaration unioned with every
//      `agent({ memory })` dir the run actually used. It cannot be a construction-time value: memory
//      dirs are undeclared by design and only become known as the run makes its agent calls.
//   2. **Telling the author when nothing was stored.** Every drop rides the run's one ordered event
//      stream, so "your state did not carry forward" lands in the run history next to the work that
//      produced it. This is the contract that closes the defect class the whole spec exists for
//      (docs/WORKSPACE_PERSISTENCE.md §7.1): persistence must never fail quietly.
//
// There is ONE algorithm and ONE format (I6). `runs_on` decides which BACKEND is injected — broker
// presigned S3 for hosted, a directory for self-hosted — and nothing else differs.

import { zstdCompress, zstdDecompress } from "node:zlib";
import { promisify } from "node:util";
import { createLogger } from "./support/index.js";
import type { RunEventBody } from "./agent/events.js";
import { WorkspaceSync, type WorkspaceBackend, type PackCodec } from "./workspace_sync.js";
import { NodeWorkspaceFs } from "./node_workspace_fs.js";

const log = createLogger("WorkspaceStore");

const compress = promisify(zstdCompress);
const decompress = promisify(zstdDecompress);

/**
 * Production pack codec. Workspaces are dominated by source, JSON, markdown, and logs, which collapse
 * hard, so this is a straight win on both the storage bill and transfer time. Per-pack (not
 * whole-scope) so a pack decompresses independently — the property that keeps hydrate O(packs).
 */
export const zstdPackCodec: PackCodec = {
  compress: async (bytes) => new Uint8Array(await compress(bytes)),
  decompress: async (bytes) => new Uint8Array(await decompress(bytes)),
};

/** What a run persists: the WHOLE workspace, or exactly these workspace-relative dirs (possibly none). */
export type PersistSelection = true | readonly string[];

/**
 * Resolve what this run persists (§3): the manifest's declaration UNIONED with every
 * `agent({ memory })` dir the run actually used.
 *
 * The union is why this is resolved at PERSIST time. Memory dirs are undeclared by design
 * (`sdk/src/types.ts` — "`mcp` servers, `skills`, and `memory` — the manifest declares none of them"),
 * so a workflow whose manifest says nothing at all still persists, iff it used memory. `true` swallows
 * the list: the whole workspace already contains every memory dir. An empty array means persist
 * nothing, which is the common case and must stay cheap.
 */
export function resolvePersistSelection(
  declared: boolean | readonly string[] | undefined,
  memoryDirs: ReadonlySet<string>,
): PersistSelection {
  if (declared === true) return true;
  const list = declared === undefined || declared === false ? [] : declared;
  return [...new Set([...list, ...memoryDirs])];
}

/**
 * Emit-only view of the run's event emitter. Required rather than optional on purpose: an optional
 * sink is one a future construction site forgets to pass, which reintroduces the exact invisibility
 * this seam exists to fix.
 */
export interface WorkspaceEventSink {
  emit(body: RunEventBody): unknown;
}

export interface WorkspaceStoreDeps {
  /** Where the bytes live. Hosted and self-hosted differ HERE and nowhere else (I3). */
  backend: WorkspaceBackend;
  /** The `/workspace` root to snapshot/restore. */
  workspaceRoot: string;
  /** Read at persist time — see {@link resolvePersistSelection}. */
  selection: () => PersistSelection;
  /** Where a dropped snapshot is reported to the author (see {@link WorkspaceEventSink}). */
  events: WorkspaceEventSink;
  /** Overridable for tests; defaults to zstd. */
  codec?: PackCodec;
  /** Per-scope byte ceiling; defaults to the sync layer's. */
  maxScopeBytes?: number;
}

export class WorkspaceStore {
  private readonly sync: WorkspaceSync;
  /** A disarm is reported once, not on every suspend point. */
  private reportedDisarm = false;

  constructor(private readonly deps: WorkspaceStoreDeps) {
    this.sync = new WorkspaceSync({
      backend: deps.backend,
      fs: new NodeWorkspaceFs(),
      codec: deps.codec ?? zstdPackCodec,
      workspaceRoot: deps.workspaceRoot,
      ...(deps.maxScopeBytes !== undefined ? { maxScopeBytes: deps.maxScopeBytes } : {}),
    });
  }

  /** Restore the scope at run start. Best-effort: a restore miss must not fail the run — the workflow
   *  just re-does filesystem work, exactly as it would without persistence. */
  async hydrate(): Promise<void> {
    await this.sync.hydrate();
    const failure = this.sync.disarmedReason;
    if (failure === null) return;
    // A restore that died partway left a tree that is NOT this scope's state, so persistence is
    // disarmed for the rest of the run. Say so once, now, rather than at every later suspend point.
    this.reportedDisarm = true;
    this.report({
      reason: "error",
      detail: `restore failed partway (${failure}); this run will not save its workspace, to avoid overwriting the stored state with a partially restored one`,
    });
  }

  /**
   * Store the run's selection. Returns the scope's live bytes (0 when nothing was stored), for the
   * caller's logging. Never throws: persistence is not allowed to break a run that otherwise succeeded.
   */
  async persist(): Promise<number> {
    const selection = this.deps.selection();
    // Nothing selected is the common case (a workflow that opted into neither form). Return before any
    // fs or broker work, so persistence costs a run that doesn't use it precisely nothing.
    if (selection !== true && selection.length === 0) return 0;

    const paths = selection === true ? undefined : selection;
    const outcome = await this.sync.persist(paths);

    if (outcome.skipped !== undefined) {
      // `not_eligible` is an ordinary no-op and is deliberately NOT reported: nothing was lost, and
      // warning there would train authors to ignore the event in the case that matters.
      if (outcome.skipped.reason !== "not_eligible" && !this.reportedDisarm) {
        this.report(outcome.skipped);
      }
      if (outcome.skipped.reason === "error") this.reportedDisarm = true;
      return 0;
    }

    if (outcome.conflicts.length > 0) {
      // We won a genuine same-path collision with a concurrent run. Their version of these paths is
      // gone, and a clobber nobody is told about is the failure mode this system exists to eliminate.
      this.report({
        reason: "overwritten",
        detail: `overwrote a concurrent run's version of ${String(outcome.conflicts.length)} file(s): ${outcome.conflicts
          .slice(0, 5)
          .map((c) => c.path)
          .join(", ")}`,
      });
    }

    return outcome.bytes;
  }

  /** Reporting is best-effort and never fails the run: a throwing sink is caught and logged. */
  private report(skipped: { reason: string; detail?: string; maxBytes?: number }): void {
    try {
      this.deps.events.emit({
        kind: "workspace_persist_skipped",
        reason: skipped.reason,
        ...(skipped.detail !== undefined ? { detail: skipped.detail } : {}),
        ...(skipped.maxBytes !== undefined ? { maxBytes: skipped.maxBytes } : {}),
      } as unknown as RunEventBody);
    } catch (err) {
      log.warn("workspace_report_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
