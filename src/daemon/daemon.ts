// SPDX-License-Identifier: Apache-2.0

// The self-hosted runner daemon (the self-hosted runner design): poll → claim → spawn ONE run
// process → heartbeat while it runs → clean → poll. One run at a time per daemon (concurrency =
// more daemons/machines); drain (Ctrl-C, admin drain, org toggle off) finishes the current run
// then stops claiming. The per-run process is the SAME runtime a Boardwalk-hosted worker boots
// (./runtime/main.js) — the daemon only hands it the claim's credentials + env and a fresh
// per-run workspace, then tears the workspace down (contract: cleanup "always").

import { mkdir, rm } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { AssignmentOffer, ClaimResponse } from "../contract.js";
import { createLogger, type Logger } from "../runtime/support/index.js";
import type { PoolClient } from "./pool_client.js";

/** Assignment-lease heartbeat cadence — comfortably beats the 300s lease. */
const HEARTBEAT_MS = 60_000;
/** Back off this long after a transient poll/claim error (network blip, control-plane deploy). */
const ERROR_BACKOFF_MS = 10_000;

export interface RunProcessHandle {
  /** Resolves with the exit code when the run process ends. */
  wait: () => Promise<number>;
  /** Ask the process to stop (SIGTERM — the runtime exits and the lease recovers the run). */
  kill: () => void;
}

export interface RunSpawner {
  (opts: { entry: string; env: Record<string, string>; cwd: string }): RunProcessHandle;
}

export interface DaemonDeps {
  client: Pick<PoolClient, "poll" | "claim" | "heartbeat">;
  /** Absolute path to the runtime process entry (dist/runtime/main.js). */
  runtimeEntry: string;
  /** Root under which per-run workspaces are created (and always removed). */
  workDir: string;
  /** Stable runner identity (stamped as WORKER_ID on run processes). */
  runnerId: string;
  spawn: RunSpawner;
  log?: Logger;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Execute at most one run, then return (CI-friendly). */
  once?: boolean;
  /** Test hook: called at the top of each loop iteration. */
  onIdle?: () => void;
}

export interface DaemonController {
  /** Resolves when the daemon has fully stopped (drained + last run finished). */
  done: Promise<void>;
  /** Begin draining: finish the current run (if any), then stop claiming. */
  drain: () => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Env for one run process: the platform contract + the claim's resolved non-secret vars. */
export function runProcessEnv(
  claim: ClaimResponse,
  opts: { runnerId: string; workspaceRoot: string },
): Record<string, string> {
  return {
    // The claim's resolved non-secret env FIRST — the platform contract keys always win.
    ...claim.env,
    RUN_ID: claim.run_id,
    BOARDWALK_CONTROL_PLANE_URL: claim.control_plane.base_url,
    BOARDWALK_RUN_TOKEN: claim.control_plane.run_token,
    BOARDWALK_API_KEY: claim.control_plane.api_token,
    BOARDWALK_TASK_CPU_UNITS: String(os.cpus().length * 1024),
    // The org's BYO inference providers, as data (the runner-direct BYO design) — consumed by the runtime's direct
    // model path. Names + endpoints + secret NAMES only; never a credential value.
    BOARDWALK_BYO_PROVIDERS: JSON.stringify(claim.byo_providers),
    WORKER_ID: opts.runnerId,
    WORKSPACE_ROOT: opts.workspaceRoot,
    // The machine's own PATH/HOME etc. deliberately do NOT flow here: the run gets exactly the
    // resolved env + platform contract, mirroring the hosted container. The spawner overlays the
    // minimal process necessities (PATH, HOME=workspace).
  };
}

export function startDaemon(deps: DaemonDeps): DaemonController {
  const log = deps.log ?? createLogger("RunnerDaemon");
  const sleep = deps.sleep ?? defaultSleep;
  let draining = false;

  async function executeClaim(offer: AssignmentOffer, claim: ClaimResponse): Promise<void> {
    const runDir = path.join(deps.workDir, "runs", claim.run_id);
    const workspaceRoot = path.join(runDir, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const child = deps.spawn({
      entry: deps.runtimeEntry,
      env: runProcessEnv(claim, { runnerId: deps.runnerId, workspaceRoot }),
      cwd: workspaceRoot,
    });
    log.info("run_started", { runId: claim.run_id, assignmentId: offer.assignment_id });

    // Heartbeat while the run process lives. Lease lost ⇒ the control plane recovered the
    // assignment (we were presumed dead) — stop the process; the run restarts elsewhere.
    // `cancel` is ALSO delivered to the run process itself (its own CancelWatcher via the run
    // token), so the daemon doesn't kill on cancel — it lets the runtime finalize cleanly.
    let exited = false;
    const heartbeatLoop = (async () => {
      for (;;) {
        await sleep(HEARTBEAT_MS);
        if (exited) return;
        try {
          const beat = await deps.client.heartbeat(claim.lease_id, claim.run_id, "running");
          log.debug("heartbeat", { runId: claim.run_id, action: beat?.action ?? "lease_lost" });
          if (exited) return;
          if (beat === null) {
            log.warn("assignment_lease_lost", { runId: claim.run_id });
            child.kill();
            return;
          }
          if (beat.action === "drain") {
            log.info("drain_requested", { runId: claim.run_id });
            draining = true;
          }
        } catch (err) {
          // Transient heartbeat failure: keep the process running; the next beat retries. The
          // lease is 300s and the cadence 60s, so several failures are survivable.
          log.warn("heartbeat_failed", {
            runId: claim.run_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();

    const exitCode = await child.wait();
    exited = true;
    await heartbeatLoop.catch(() => undefined);
    log.info("run_finished", { runId: claim.run_id, exitCode });
    // Contract: cleanup "always". Persistence happened via the workspace store, not local disk.
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const done = (async () => {
    log.info("daemon_started", { runnerId: deps.runnerId, workDir: deps.workDir });
    // Reclaim run dirs a previous daemon left behind (crash / SIGKILL / force-quit): a completed
    // run always cleans its own dir, so anything here is orphaned and may hold a workspace the
    // crashed run wrote. Best-effort; a failure must not stop the daemon.
    await rm(path.join(deps.workDir, "runs"), { recursive: true, force: true }).catch(
      () => undefined,
    );
    while (!draining) {
      deps.onIdle?.();
      try {
        log.debug("polling", {});
        const polled = await deps.client.poll();
        if (polled.action === "drain") {
          log.info("drain_requested", {});
          break;
        }
        const offer = polled.assignment;
        if (offer === null) continue; // long-poll came back empty — poll again immediately
        const claim = await deps.client.claim(offer.assignment_id);
        if (claim === null) continue; // another runner won — back to polling
        await executeClaim(offer, claim);
        if (deps.once === true) break;
      } catch (err) {
        log.warn("daemon_iteration_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(ERROR_BACKOFF_MS);
      }
    }
    log.info("daemon_stopped", { runnerId: deps.runnerId });
  })();

  return {
    done,
    drain: () => {
      draining = true;
    },
  };
}
