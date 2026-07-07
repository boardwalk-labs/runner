// SPDX-License-Identifier: Apache-2.0

// startRunner — the ONE implementation of "run this machine as a runner". Both entry points
// (`boardwalk-runner start` and the CLI's `boardwalk runner start`) obtain an identity their own
// way (two-step token vs one-step management-API enrollment) and then call THIS. There is no second
// copy of the daemon lifecycle, the isolation decision, or the drain handling to drift out of sync.
//
// Isolation is a `RunSpawner` choice: `container` (default) runs each run in a throwaway container;
// `host` (the `--host` escape hatch) runs it as a raw child process with full machine access. A
// future macOS/Windows native sandbox is simply a third RunSpawner behind this same seam.

import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { PoolClient } from "./pool_client.js";
import { startDaemon, type RunProcessHandle, type RunSpawner } from "./daemon.js";
import { createContainerSpawner, detectContainerRuntime } from "./container.js";
import type { RunnerIdentity } from "./identity.js";

export type IsolationMode = "container" | "host";

export interface IsolationConfig {
  /** `container` (default) = throwaway container per run; `host` = raw process, full machine access. */
  mode: IsolationMode;
  /** Container image ref (container mode). Defaults to the version-pinned ghcr.io/boardwalk-labs image. */
  image?: string;
  /** Container network mode (container mode). Defaults to `host` — preserves LAN/VPN/localhost reach. */
  network?: string;
  /** Extra host bind mounts to expose to the run (container mode). */
  mounts?: readonly string[];
}

/** This package's version (the runner image tag is pinned to it). Read from package.json so a
 *  release bump is one file. */
export function packageVersion(): string {
  try {
    const pkg: unknown = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    if (typeof pkg === "object" && pkg !== null && "version" in pkg) {
      const v: unknown = pkg.version;
      if (typeof v === "string") return v;
    }
  } catch {
    // fall through
  }
  return "0.0.0";
}

/** Default runner image ref — the version-pinned public image (base + this runtime). */
export function defaultImage(): string {
  return `ghcr.io/boardwalk-labs/runner:${packageVersion()}`;
}

/** Raw-process spawner (the `--host` escape hatch): one Node process per run, full machine access.
 *  Env = the platform contract + the claim's resolved vars over a minimal base (PATH + proxy knobs;
 *  HOME = the run's workspace). */
export function processSpawn(opts: {
  entry: string;
  env: Record<string, string>;
  cwd: string;
}): RunProcessHandle {
  const base: Record<string, string> = {};
  for (const key of [
    "PATH",
    "LANG",
    "NODE_USE_ENV_PROXY",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
    "BOARDWALK_RUNNER_DEBUG",
  ]) {
    const v = process.env[key];
    if (v !== undefined) base[key] = v;
  }
  const child = nodeSpawn(process.execPath, [opts.entry], {
    cwd: opts.cwd,
    env: { ...base, HOME: opts.cwd, TMPDIR: path.join(opts.cwd, "..", "tmp"), ...opts.env },
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
      child.kill("SIGTERM");
    },
  };
}

/** Error thrown when container isolation is requested but no runtime is available — the caller
 *  surfaces the message and exits (never silently drop to the unisolated path). */
export class NoContainerRuntimeError extends Error {
  constructor() {
    super(
      "No container runtime found (looked for docker, podman). Self-hosted runs are containerized " +
        "by default for isolation.\n" +
        "  • Install Docker or Podman and make sure it's running, or\n" +
        "  • pass --host to run without isolation (full machine access; trusted workflows only).",
    );
    this.name = "NoContainerRuntimeError";
  }
}

/** Pick the run spawner from the isolation config. Container is default; `host` is the escape hatch;
 *  container-with-no-runtime throws {@link NoContainerRuntimeError}. */
export async function resolveSpawner(
  iso: IsolationConfig,
  log: (line: string) => void,
  detect: typeof detectContainerRuntime = detectContainerRuntime,
): Promise<RunSpawner> {
  if (iso.mode === "host") {
    log(
      "Running WITHOUT isolation (--host): runs get full access to this machine as your user. " +
        "Only run workflows you trust.\n",
    );
    return processSpawn;
  }
  const runtime = await detect();
  if (runtime === null) throw new NoContainerRuntimeError();
  const image = iso.image ?? defaultImage();
  // Linux: run as the invoking user so the bind-mounted workspace is writable. Docker Desktop
  // (macOS/Windows) maps ownership via file sharing, so leave the image's user in place there.
  const user =
    process.platform === "linux" && process.getuid !== undefined && process.getgid !== undefined
      ? `${String(process.getuid())}:${String(process.getgid())}`
      : undefined;
  log(
    `Isolation: ${runtime} container (${image}); workspace-only + ${iso.network ?? "host"} network.\n`,
  );
  return createContainerSpawner({
    runtime,
    image,
    ...(iso.network !== undefined ? { network: iso.network } : {}),
    ...(iso.mounts !== undefined && iso.mounts.length > 0 ? { mounts: iso.mounts } : {}),
    ...(user !== undefined ? { user } : {}),
  });
}

export interface StartRunnerOptions {
  baseUrl: string;
  identity: RunnerIdentity;
  isolation: IsolationConfig;
  workDir: string;
  once?: boolean;
  /** Progress line sink (stdout by default). */
  log?: (line: string) => void;
  /** Wire SIGINT/SIGTERM → drain (Ctrl-C finishes the current run; a second forces quit). Default on. */
  handleSignals?: boolean;
}

/**
 * Run the daemon to completion: resolve the spawner (isolation), poll → claim → execute → heartbeat,
 * and drain cleanly on Ctrl-C. Both entry points call this after obtaining an identity, so there is
 * exactly one implementation of the run loop + isolation decision.
 */
export async function startRunner(opts: StartRunnerOptions): Promise<void> {
  const log = opts.log ?? ((line: string) => void process.stdout.write(line));
  const spawn = await resolveSpawner(opts.isolation, log);
  // Process mode imports this entry directly; container mode ignores it (the image's entrypoint runs
  // the runtime), but the daemon still passes it through the spawner interface.
  const runtimeEntry = fileURLToPath(new URL("../runtime/main.js", import.meta.url));
  const client = new PoolClient({ baseUrl: opts.baseUrl, runnerToken: opts.identity.runner_token });
  const daemon = startDaemon({
    client,
    runtimeEntry,
    workDir: opts.workDir,
    runnerId: opts.identity.runner_id,
    spawn,
    ...(opts.once === true ? { once: true } : {}),
  });
  if (opts.handleSignals !== false) {
    let interrupts = 0;
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        interrupts += 1;
        if (interrupts === 1) {
          log(
            "\nDraining: finishing the current run, claiming nothing new. Ctrl-C again to force-quit.\n",
          );
          daemon.drain();
        } else {
          process.exit(130);
        }
      });
    }
  }
  log(`Runner ${opts.identity.name} online in pool '${opts.identity.pool}'. Waiting for runs...\n`);
  await daemon.done;
}
