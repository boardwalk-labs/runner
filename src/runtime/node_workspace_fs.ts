// NodeWorkspaceFs — the production {@link WorkspaceSyncFs}, over node:fs.
//
// Two rules here are security-relevant rather than merely careful:
//
//   1. **Restored paths are untrusted.** The manifest is ours, but it round-trips through storage, so a
//      path in it must be re-checked against the workspace root before anything is written. A `..` that
//      escapes would let a corrupted or tampered manifest write anywhere the run can reach.
//   2. **The walk never follows symlinks.** A symlink into `/etc` (or into the program bundle) would
//      otherwise be read and persisted as though it were workspace content, and restored later as a
//      real file. Symlinks are skipped entirely rather than dereferenced.

import { mkdir, readdir, readFile, writeFile, lstat, utimes } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import type { WorkspaceSyncFs } from "./workspace_sync.js";
import type { WorkspaceWalkEntry } from "./workspace_format.js";

export class NodeWorkspaceFs implements WorkspaceSyncFs {
  async walk(root: string, paths: readonly string[] | undefined): Promise<WorkspaceWalkEntry[]> {
    const roots =
      paths === undefined ? [root] : paths.map((p) => join(root, p)).filter((p) => under(root, p));
    const out: WorkspaceWalkEntry[] = [];
    for (const start of roots) await this.walkInto(root, start, out);
    // Sorted so a manifest is stable across walks; an arbitrary readdir order would otherwise churn
    // pack membership between runs that changed nothing.
    return out.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  }

  private async walkInto(root: string, current: string, out: WorkspaceWalkEntry[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err) {
      // A declared-but-never-created dir is normal: a workflow declares ["cache", "index"] and only
      // writes `cache` on its first run. Anything else propagates.
      if ((err as { code?: string } | null)?.code === "ENOENT") return;
      if ((err as { code?: string } | null)?.code === "ENOTDIR") {
        await this.record(root, current, out);
        return;
      }
      throw err;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isSymbolicLink()) continue; // never dereference — see the header
      if (entry.isDirectory()) await this.walkInto(root, child, out);
      else if (entry.isFile()) await this.record(root, child, out);
    }
  }

  private async record(root: string, absolute: string, out: WorkspaceWalkEntry[]): Promise<void> {
    const info = await lstat(absolute);
    if (!info.isFile()) return;
    out.push({ p: toPosix(relative(root, absolute)), s: info.size, m: Math.floor(info.mtimeMs) });
  }

  async readFile(root: string, relPath: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.safeJoin(root, relPath)));
  }

  async writeUnder(
    root: string,
    relPath: string,
    data: Uint8Array,
    mtimeMs: number,
  ): Promise<void> {
    const target = this.safeJoin(root, relPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
    // Restore the recorded mtime WITH the bytes. Without it every restored file looks new to the next
    // diff, the whole workspace re-uploads on every run, and the delta only ever saves work within a
    // single run — most of the point gone.
    const seconds = mtimeMs / 1000;
    await utimes(target, seconds, seconds);
  }

  /** Resolve a workspace-relative path, refusing anything that escapes the root. */
  private safeJoin(root: string, relPath: string): string {
    if (isAbsolute(relPath)) throw new Error(`workspace path must be relative: ${relPath}`);
    const target = resolve(root, relPath);
    if (!under(root, target)) throw new Error(`workspace path escapes the workspace: ${relPath}`);
    return target;
  }
}

function under(root: string, candidate: string): boolean {
  const base = resolve(root);
  const target = resolve(candidate);
  return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}
