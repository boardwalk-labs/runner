// SPDX-License-Identifier: Apache-2.0

// Container run spawner — the DEFAULT isolation model for a self-hosted runner. Each run executes
// inside a throwaway container (Docker/Podman) instead of as a same-UID child process, so the run
// (and the LLM-decided `agent()` tool calls inside it) sees ONLY its own workspace, never the
// user's home dir, the runner's identity file, SSH/cloud creds, or the rest of the machine. The
// machine's network IS preserved (`--network host`) so a run still reaches the org's LAN, VPN, and
// localhost services — the reason to self-host. Full host access stays possible, but only as an
// EXPLICIT mount, never the silent default. `--host` (a separate spawner) is the escape hatch.
//
// Security-critical surface: `buildContainerArgs` is a pure function so the argv can be asserted
// exhaustively — the identity dir is NEVER bind-mounted, and per-run credentials ride the docker
// client's ENV (name-only `-e KEY`), never the argv (which `ps` would expose).

import { spawn as nodeSpawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import type { RunProcessHandle } from "./daemon.js";

const exec = promisify(execFile);

/** Env keys forwarded from the daemon's OWN environment into the container (proxy + locale only —
 *  NOT the machine's PATH/HOME, which would leak host layout; the image provides its own). */
const FORWARDED_ENV_KEYS = [
  "LANG",
  "NODE_USE_ENV_PROXY",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "BOARDWALK_RUNNER_DEBUG",
] as const;

export interface ContainerSpawnConfig {
  /** Container runtime binary: `docker` or `podman`. */
  runtime: string;
  /** Fully-qualified runner image ref (e.g. `ghcr.io/boardwalk-labs/runner:0.1.9`). */
  image: string;
  /** Docker network mode. Default `host` — preserves the machine's LAN/VPN/localhost reach. */
  network?: string;
  /** Extra host bind mounts (`hostPath:containerPath[:ro]`) the user opted into for this fleet. */
  mounts?: readonly string[];
  /** Run the container as this `uid:gid` — the invoking host user — so writes to the bind-mounted
   *  workspace match host ownership instead of the image's `node` (uid 1000). Set on Linux; omit on
   *  Docker Desktop (macOS/Windows), which maps ownership through its file sharing. */
  user?: string;
  /** Test seam. */
  spawn?: typeof nodeSpawn;
}

/** The env the container receives: the claim's env + platform contract, with the in-container
 *  filesystem coordinates overridden (the host paths are meaningless inside the container). */
export function containerEnv(runEnv: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {
    // Forward the daemon's proxy/locale knobs so egress + a corporate proxy still work.
    ...forwardedEnv(),
    // The claim's resolved non-secret vars + platform contract (RUN_ID, BOARDWALK_RUN_TOKEN, …).
    ...runEnv,
    // In-container coordinates — the bind mount lands the workspace at /workspace.
    WORKSPACE_ROOT: "/workspace",
    HOME: "/workspace",
    TMPDIR: "/tmp",
  };
  return env;
}

function forwardedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FORWARDED_ENV_KEYS) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** Derive the run id from the per-run workspace path (`<workDir>/runs/<runId>/workspace`). Used only
 *  for a human-readable container name; a fallback keeps a non-standard cwd from throwing. */
export function runIdFromCwd(cwd: string): string {
  const runId = path.basename(path.dirname(cwd));
  return /^[A-Za-z0-9_-]{1,64}$/.test(runId) ? runId : "run";
}

/**
 * Build the `docker run` argv. PURE + exported so the isolation guarantees are unit-asserted:
 *  - the ONLY bind mount is the per-run workspace (+ any explicit user mounts) — the identity dir,
 *    the user's home, and the rest of the host FS are never mounted;
 *  - per-run credentials are passed by NAME (`-e BOARDWALK_RUN_TOKEN`), so their VALUES come from the
 *    docker client's env and never appear in the argv (which `ps` exposes);
 *  - `--rm` (no leftover container), `--init` (proper signal handling / zombie reaping).
 */
export function buildContainerArgs(
  cfg: ContainerSpawnConfig,
  opts: { env: Record<string, string>; cwd: string },
): string[] {
  const args = [
    "run",
    "--rm",
    "--init",
    "--name",
    `bw-run-${runIdFromCwd(opts.cwd)}`,
    "--network",
    cfg.network ?? "host",
    // The per-run workspace — the ONLY host path the run can see by default.
    "-v",
    `${opts.cwd}:/workspace`,
    "-w",
    "/workspace",
  ];
  // Run as the invoking host user (Linux) so the bind-mounted workspace is writable — the image's
  // `node` (uid 1000) otherwise can't write a host dir it doesn't own.
  if (cfg.user !== undefined) {
    args.push("--user", cfg.user);
  }
  // Explicit, user-opted-in host mounts (fleet config) — the honest way to say "I grant this path".
  for (const m of cfg.mounts ?? []) {
    args.push("-v", m);
  }
  // Env by NAME only — values are read from the docker client's environment, never the argv.
  for (const key of Object.keys(containerEnv(opts.env))) {
    args.push("-e", key);
  }
  args.push(cfg.image);
  return args;
}

/** A `RunSpawner` that runs each run in a throwaway container. */
export function createContainerSpawner(
  cfg: ContainerSpawnConfig,
): (opts: { entry: string; env: Record<string, string>; cwd: string }) => RunProcessHandle {
  const spawnImpl = cfg.spawn ?? nodeSpawn;
  return (opts) => {
    const args = buildContainerArgs(cfg, opts);
    const child = spawnImpl(cfg.runtime, args, {
      // The docker client reads the name-only `-e KEY` values from ITS environment — set them here so
      // they never touch the argv. The daemon's own secrets are NOT here (only forwarded + claim env).
      env: { ...process.env, ...containerEnv(opts.env) },
      stdio: "inherit",
    });
    const exit = new Promise<number>((resolve) => {
      child.on("exit", (code, signal) => {
        resolve(code ?? (signal !== null ? 143 : 1));
      });
      child.on("error", () => {
        resolve(1);
      });
    });
    return {
      wait: () => exit,
      kill: () => {
        // `docker run` proxies SIGTERM to the container; also best-effort `docker kill` by name in
        // case signal proxying is off, so a lost lease / drain actually stops the container.
        child.kill("SIGTERM");
        void exec(cfg.runtime, ["kill", `bw-run-${runIdFromCwd(opts.cwd)}`]).catch(() => undefined);
      },
    };
  };
}

/** Probe that a container runtime is installed AND its daemon is reachable. Returns the runtime
 *  binary name on success, or null (so `start` can hard-fail with a clear message rather than
 *  failing every run later). `docker info` / `podman info` exits non-zero when the daemon is down. */
export async function detectContainerRuntime(
  candidates: readonly string[] = ["docker", "podman"],
  run: (bin: string) => Promise<void> = async (bin) => {
    await exec(bin, ["info"], { timeout: 10_000 });
  },
): Promise<string | null> {
  for (const bin of candidates) {
    try {
      await run(bin);
      return bin;
    } catch {
      // not installed, or the daemon isn't running — try the next candidate
    }
  }
  return null;
}
