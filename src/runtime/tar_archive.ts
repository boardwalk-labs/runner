// Tar extraction for the PROGRAM ARTIFACT.
//
// This is all that survives of the runner's tar usage. Workspace persistence no longer archives
// anything — a scope is a manifest plus content-addressed packs (docs/WORKSPACE_PERSISTENCE.md §5.2) —
// but a deployed program is still delivered as a tarball, so the extractor lives here rather than being
// carried along inside a workspace module it has nothing to do with.
//
// Extraction is via node-tar, NOT `tar xzf`: it reads UNTRUSTED input (a program artifact from an
// arbitrary control plane on a self-hosted runner), and node-tar is hardened + portable — with default
// `preservePaths: false` it strips absolute paths and `..` members, and refuses to write THROUGH a
// symlink (unlinking it first), closing the traversal and symlink-escape gaps that differ between GNU
// tar and bsdtar. Same behaviour on macOS and Linux, with no dependency on which `tar` the OS ships.
//
// The default decompression-ratio guard is deliberately LEFT ON here. The workspace used to raise it,
// because a bomb guard firing on bytes we wrote ourselves cost the author their state for nothing; a
// program artifact is the untrusted-input case the guard actually exists for.

import { mkdir } from "node:fs/promises";
import { extract as tarExtract } from "tar";

/** Extract a gzipped tar into `dir`, creating it if absent. */
export async function extractTarball(srcPath: string, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await tarExtract({ file: srcPath, cwd: dir });
}
