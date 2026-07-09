// Snapshot-uniqueness reseed — clause 3 of the SNAPSHOT_UNIQUENESS_CONTRACT, the one sliver of
// the determinism contract that survives the journal's deletion.
//
// A memory snapshot freezes OpenSSL's DRBG, so two clones of one base snapshot hand every run
// byte-identical `crypto.*` output (proven, contract). The kernel CSPRNG diverges across
// clones (VMGenID) but that reseed never reaches OpenSSL, and a pure-JS monkeypatch was proven
// insufficient (named ESM imports of `node:crypto` bypass it — measured 2026-07-09). So the robust
// fix is a native step that reseeds OpenSSL's DRBG UNDERNEATH every caller: the `bw_reseed` addon
// (native/reseed.c) chains EVP_RAND_reseed over the primary/public/private DRBGs from the
// (VMGenID-diverged) OS entropy.
//
// This module is the platform-owned JS entry point. It loads the prebuilt addon opportunistically
// and NO-OPS with a warning when it is unavailable (a platform with no prebuild — e.g. the ARM64
// Fargate worker, where there is no snapshot and thus nothing to reseed; or a self-host on an
// unsupported arch). It never throws: a reseed that cannot run must not fail a run.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createLogger } from "./support/index.js";

const log = createLogger("uniqueness_reseed");

interface ReseedAddon {
  /** Reseed OpenSSL's DRBG chain from fresh OS entropy; true iff every present layer reseeded. */
  reseed(): boolean;
}

/** undefined = not yet attempted; null = unavailable (no prebuild for this platform). */
let addon: ReseedAddon | null | undefined;

function loadAddon(): ReseedAddon | null {
  if (addon !== undefined) return addon;
  try {
    const require = createRequire(import.meta.url);
    // node-gyp-build resolves prebuilds/<platform>-<arch>/*.node (production) or build/Release
    // (a local dev build), throwing when neither exists for this platform.
    const nodeGypBuild = require("node-gyp-build") as (dir: string) => ReseedAddon;
    // dist/runtime/uniqueness_reseed.js → the package root two levels up (holds prebuilds/ + build/).
    const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    addon = nodeGypBuild(pkgRoot);
  } catch (err) {
    addon = null;
    log.warn("uniqueness_reseed_addon_unavailable", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return addon;
}

/**
 * Reseed the userspace CSPRNG at a restore boundary (fresh-run identity injection AND every wake —
 * clause 3), before any run code draws randomness. Idempotent and side-effect-free beyond the
 * reseed; safe to call repeatedly. Returns whether the reseed ran (false = addon unavailable, the
 * degraded no-op path). Never throws.
 */
export function reseedUserspaceCsprng(): boolean {
  const a = loadAddon();
  if (a === null) return false;
  try {
    const ok = a.reseed();
    if (!ok) log.warn("uniqueness_reseed_partial", {});
    return ok;
  } catch (err) {
    log.error("uniqueness_reseed_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
