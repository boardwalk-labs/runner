// sandbox_config — derive the sandbox tools' per-run configuration from a workflow manifest.
//
// The worker builds the `shell`/`git`/`filesystem` tools (build_registry's `sandbox` deps) once
// the run's manifest is known. One manifest-driven knob feeds in here:
//   * env split — `manifest.env` values are either non-secret literals (passed straight to the
//     subprocess env) or `${{ secrets.X }}` references (turned into a `envVar → secretName` map the
//     tools resolve per-run via `ctx.secrets`; the secret VALUE never sits in the manifest).
// The shell command allowlist is the built-in default — there is no manifest-level tool grant or
// `extra_commands` config (tools are selected per-`agent()` call, not granted in the manifest).
//
// Pure + manifest-only so the split/extraction is exhaustively unit-testable without a worker.

import { parseSecretEnvRef, type WorkflowManifest } from "./wire/manifest.js";
// Ported from the backend's domain/tools/build_registry.ts (the sandbox slice only).
export interface SandboxToolDeps {
  /** Absolute sandbox root — every filesystem/shell/git op is confined here. */
  root: string;
  /** Non-secret env vars (resolved `manifest.env` literals) exposed to shell/git subprocesses. */
  env?: Record<string, string>;
  /** Env var name → granted secret name (`manifest.env`'s secret refs), resolved per-run. */
  secretEnv?: Record<string, string>;
  committerName?: string;
  committerEmail?: string;
  /** Manifest `tools[name=shell].config.extra_commands` allowlist additions. */
  extraShellCommands?: readonly string[];
}

/** The manifest-derived subset of {@link SandboxToolDeps} (the worker adds `root`). */
export type SandboxConfig = Omit<SandboxToolDeps, "root" | "committerName" | "committerEmail">;

/**
 * Split `manifest.env` into non-secret literals vs. `${{ secrets.X }}` references. Returns only the
 * keys that have content, so the caller can spread it into the sandbox deps without injecting
 * empty objects.
 */
export function sandboxConfigFromManifest(manifest: WorkflowManifest): SandboxConfig {
  const env: Record<string, string> = {};
  const secretEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(manifest.env ?? {})) {
    const secret = parseSecretEnvRef(value);
    if (secret !== null) secretEnv[key] = secret;
    else env[key] = value;
  }

  const config: SandboxConfig = {};
  if (Object.keys(env).length > 0) config.env = env;
  if (Object.keys(secretEnv).length > 0) config.secretEnv = secretEnv;
  return config;
}
