#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// boardwalk-runner — the standalone self-hosted runner daemon (fleet installs: systemd,
// launchd, K8s, AMIs). The full Boardwalk CLI wraps the same daemon as `boardwalk runner …`
// with one-step enrollment; this binary is the two-step half: an admin mints a registration
// token (Settings > Runners / `boardwalk runner pools token`), the machine redeems it once,
// then `start` polls for work.
//
//   boardwalk-runner register --url https://api.boardwalk.sh --token bwkreg_… \
//       [--name <machine>] [--labels gpu,arm64]
//   boardwalk-runner start --url https://api.boardwalk.sh --pool default \
//       [--work-dir ~/.boardwalk/runner/work] [--once]
//   boardwalk-runner deregister --url https://api.boardwalk.sh --pool default
//
// Corporate proxies: launch with NODE_USE_ENV_PROXY=1 and HTTPS_PROXY set — Node's fetch (the
// daemon) and the spawned run processes both honor it.

import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as os from "node:os";
import { createLogger } from "./runtime/support/index.js";
import { runnerOsSchema, runnerArchSchema } from "./contract.js";
import {
  PoolClient,
  defaultIdentityDir,
  loadIdentity,
  removeIdentity,
  saveIdentity,
  startDaemon,
  type RunProcessHandle,
} from "./daemon/index.js";

const log = createLogger("boardwalk-runner");

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = process.argv[i + 1];
  return i === -1 || v === undefined || v.startsWith("--") ? undefined : v;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function requireFlag(name: string): string {
  const v = flag(name);
  if (v === undefined) {
    process.stderr.write(`Missing required --${name}\n`);
    process.exit(1);
  }
  return v;
}

function machineOs(): "linux" | "macos" | "windows" | undefined {
  const map: Record<string, string> = { linux: "linux", darwin: "macos", win32: "windows" };
  const parsed = runnerOsSchema.safeParse(map[process.platform]);
  return parsed.success ? parsed.data : undefined;
}
function machineArch(): "x64" | "arm64" | undefined {
  const parsed = runnerArchSchema.safeParse(process.arch);
  return parsed.success ? parsed.data : undefined;
}

/** Real spawner: one Node process per run, executing the SAME runtime a hosted worker boots.
 *  Env is exactly the platform contract + the claim's resolved vars, over a minimal base
 *  (PATH + proxy knobs from the daemon's own environment; HOME = the run's workspace). */
function realSpawn(opts: {
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

async function cmdRegister(): Promise<void> {
  const baseUrl = requireFlag("url");
  const token = requireFlag("token");
  const client = new PoolClient({ baseUrl });
  const osName = machineOs();
  const arch = machineArch();
  const res = await client.register({
    registration_token: token,
    name: flag("name") ?? os.hostname(),
    labels: (flag("labels") ?? "").split(",").filter((l) => l.length > 0),
    ...(osName !== undefined ? { os: osName } : {}),
    ...(arch !== undefined ? { arch } : {}),
    runner_version: RUNNER_VERSION,
  });
  const file = await saveIdentity(flag("identity-dir") ?? defaultIdentityDir(), {
    runner_id: res.runner_id,
    runner_token: res.runner_token,
    control_plane_url: baseUrl,
    pool: res.pool,
    name: flag("name") ?? os.hostname(),
    created_at: Date.now(),
  });
  log.info("registered", { runnerId: res.runner_id, pool: res.pool, identity: file });
  process.stdout.write(
    `Registered runner ${res.runner_id} in pool '${res.pool}'.\nStart it with: boardwalk-runner start --url ${baseUrl} --pool ${res.pool}\n`,
  );
}

async function cmdStart(): Promise<void> {
  const baseUrl = requireFlag("url");
  const pool = flag("pool") ?? "default";
  const identityDir = flag("identity-dir") ?? defaultIdentityDir();
  const identity = await loadIdentity(identityDir, baseUrl, pool);
  if (identity === null) {
    process.stderr.write(
      `No saved identity for ${baseUrl} pool '${pool}'. Run boardwalk-runner register first.\n`,
    );
    process.exit(1);
  }
  const workDir = flag("work-dir") ?? path.join(identityDir, "work");
  const runtimeEntry = fileURLToPath(new URL("./runtime/main.js", import.meta.url));
  const client = new PoolClient({ baseUrl, runnerToken: identity.runner_token });
  const daemon = startDaemon({
    client,
    runtimeEntry,
    workDir,
    runnerId: identity.runner_id,
    spawn: realSpawn,
    ...(hasFlag("once") ? { once: true } : {}),
  });
  let interrupts = 0;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      interrupts += 1;
      if (interrupts === 1) {
        process.stderr.write(
          "\nDraining: finishing the current run, claiming nothing new. Ctrl-C again to force-quit.\n",
        );
        daemon.drain();
      } else {
        process.exit(130);
      }
    });
  }
  process.stdout.write(`Runner ${identity.name} online in pool '${pool}'. Waiting for runs...\n`);
  await daemon.done;
}

async function cmdDeregister(): Promise<void> {
  const baseUrl = requireFlag("url");
  const pool = flag("pool") ?? "default";
  const identityDir = flag("identity-dir") ?? defaultIdentityDir();
  const identity = await loadIdentity(identityDir, baseUrl, pool);
  if (identity === null) {
    process.stderr.write(`No saved identity for ${baseUrl} pool '${pool}'.\n`);
    process.exit(1);
  }
  await new PoolClient({ baseUrl, runnerToken: identity.runner_token }).deregister();
  await removeIdentity(identityDir, baseUrl, pool);
  process.stdout.write(`Deregistered runner ${identity.runner_id}.\n`);
}

// The client's own version (contract `runner_version`), read from package.json so a release
// bump is one file. Resolved relative to the compiled dist/bin.js.
const RUNNER_VERSION: string = (() => {
  try {
    const pkg: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    if (typeof pkg === "object" && pkg !== null && "version" in pkg) {
      const v: unknown = pkg.version;
      if (typeof v === "string") return v;
    }
  } catch {
    // fall through
  }
  return "0.0.0";
})();

const USAGE = `boardwalk-runner <register|start|deregister> [flags]

  register    --url <control-plane> --token <bwkreg_…> [--name] [--labels a,b] [--identity-dir]
  start       --url <control-plane> [--pool default] [--work-dir] [--once] [--identity-dir]
  deregister  --url <control-plane> [--pool default] [--identity-dir]

  --verbose   debug-level daemon logs (poll cycles, heartbeats)
  --debug     --verbose, plus debug logging inside each spawned run process
`;

async function mainCli(): Promise<void> {
  // --verbose: debug-level daemon logs (poll cycles, heartbeats). --debug: the same, PLUS the
  // spawned run processes log debug too (the env below is forwarded to children by realSpawn).
  if (hasFlag("debug")) {
    process.env.BOARDWALK_RUNNER_LOG_LEVEL = "debug";
    process.env.BOARDWALK_RUNNER_DEBUG = "1";
  } else if (hasFlag("verbose")) {
    process.env.BOARDWALK_RUNNER_LOG_LEVEL = "debug";
  }
  const cmd = process.argv[2];
  if (cmd === "register") return await cmdRegister();
  if (cmd === "start") return await cmdStart();
  if (cmd === "deregister") return await cmdDeregister();
  process.stderr.write(USAGE);
  process.exit(cmd === undefined || cmd === "--help" || cmd === "help" ? 0 : 1);
}

void mainCli().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
