// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runProcessEnv, startDaemon, type RunProcessHandle } from "./daemon.js";
import type { AssignmentOffer, ClaimResponse } from "../contract.js";

const OFFER: AssignmentOffer = {
  assignment_id: "01H_assignment",
  run_id: "01H_run",
  org_id: "01H_org",
  runs_on: { kind: "self-hosted", pool: "default" },
  queued_at: 1,
};

const CLAIM: ClaimResponse = {
  lease_id: "01H_assignment",
  run_id: "01H_run",
  lease_expires_at: 300_000,
  control_plane: {
    base_url: "https://api.example",
    run_token: "run-token",
    api_token: "api-token",
  },
  env: { REGION: "us-east-1", RUN_ID: "spoofed" },
  byo_providers: [],
};

function instantSleep(): (ms: number) => Promise<void> {
  return () => new Promise((r) => setImmediate(r));
}

function fakeChild(exitCode = 0): RunProcessHandle & { killed: () => boolean } {
  let killed = false;
  let resolveExit: (code: number) => void = () => undefined;
  const exit = new Promise<number>((r) => {
    resolveExit = r;
  });
  setImmediate(() => {
    resolveExit(killed ? 143 : exitCode);
  });
  return {
    wait: () => exit,
    kill: () => {
      killed = true;
      resolveExit(143);
    },
    killed: () => killed,
  };
}

async function tmpWorkDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "bw-runner-test-"));
}

describe("runProcessEnv", () => {
  it("platform contract keys always win over the claim env", () => {
    const env = runProcessEnv(CLAIM, { runnerId: "r1", workspaceRoot: "/w" });
    expect(env.RUN_ID).toBe("01H_run"); // the claim env tried to spoof it
    expect(env.REGION).toBe("us-east-1");
    expect(env.BOARDWALK_RUN_TOKEN).toBe("run-token");
    expect(env.BOARDWALK_API_KEY).toBe("api-token");
    expect(env.WORKER_ID).toBe("r1");
    expect(env.WORKSPACE_ROOT).toBe("/w");
    expect(JSON.parse(env.BOARDWALK_BYO_PROVIDERS ?? "null")).toEqual([]);
  });
});

describe("startDaemon", () => {
  it("claims an offer, spawns the runtime with the claim env, cleans the run dir", async () => {
    const workDir = await tmpWorkDir();
    const spawned: { env: Record<string, string>; cwd: string }[] = [];
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ assignment: OFFER })
      .mockResolvedValue({ assignment: null });
    const client = {
      poll,
      claim: vi.fn().mockResolvedValue(CLAIM),
      heartbeat: vi.fn().mockResolvedValue({ lease_expires_at: 1, action: "continue" }),
    };
    const daemon = startDaemon({
      client,
      runtimeEntry: "/entry.js",
      workDir,
      runnerId: "r1",
      once: true,
      sleep: instantSleep(),
      spawn: (opts) => {
        spawned.push({ env: opts.env, cwd: opts.cwd });
        return fakeChild(0);
      },
    });
    await daemon.done;
    expect(client.claim).toHaveBeenCalledWith("01H_assignment");
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.env.RUN_ID).toBe("01H_run");
    expect(spawned[0]?.cwd).toContain("01H_run");
    // The per-run dir is removed after the run (contract: cleanup always).
    await expect(stat(path.join(workDir, "runs", "01H_run"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("goes back to polling when another runner wins the claim", async () => {
    const workDir = await tmpWorkDir();
    const spawn = vi.fn();
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ assignment: OFFER })
      .mockResolvedValueOnce({ assignment: null, action: "drain" });
    const client = {
      poll,
      claim: vi.fn().mockResolvedValue(null),
      heartbeat: vi.fn(),
    };
    const daemon = startDaemon({
      client,
      runtimeEntry: "/entry.js",
      workDir,
      runnerId: "r1",
      sleep: instantSleep(),
      spawn,
    });
    await daemon.done;
    expect(spawn).not.toHaveBeenCalled();
  });

  it("stops claiming when poll says drain", async () => {
    const workDir = await tmpWorkDir();
    const client = {
      poll: vi.fn().mockResolvedValue({ assignment: null, action: "drain" }),
      claim: vi.fn(),
      heartbeat: vi.fn(),
    };
    const daemon = startDaemon({
      client,
      runtimeEntry: "/entry.js",
      workDir,
      runnerId: "r1",
      sleep: instantSleep(),
      spawn: vi.fn(),
    });
    await daemon.done;
    expect(client.claim).not.toHaveBeenCalled();
  });

  it("drain() finishes the current run then stops", async () => {
    const workDir = await tmpWorkDir();
    let idles = 0;
    const client = {
      poll: vi
        .fn()
        .mockResolvedValueOnce({ assignment: OFFER })
        .mockResolvedValue({ assignment: null }),
      claim: vi.fn().mockResolvedValue(CLAIM),
      heartbeat: vi.fn().mockResolvedValue({ lease_expires_at: 1, action: "continue" }),
    };
    const daemon = startDaemon({
      client,
      runtimeEntry: "/entry.js",
      workDir,
      runnerId: "r1",
      sleep: instantSleep(),
      spawn: () => fakeChild(0),
      onIdle: () => {
        idles += 1;
        if (idles === 2) daemon.drain(); // after the first run completes
      },
    });
    await daemon.done;
    expect(client.claim).toHaveBeenCalledTimes(1);
  });

  it("kills the run process when the assignment lease is lost", async () => {
    const workDir = await tmpWorkDir();
    // A child that never exits on its own — only the daemon's kill ends it.
    let resolveExit: (code: number) => void = () => undefined;
    const child: RunProcessHandle = {
      wait: () =>
        new Promise<number>((r) => {
          resolveExit = r;
        }),
      kill: () => {
        resolveExit(143);
      },
    };
    const client = {
      poll: vi
        .fn()
        .mockResolvedValueOnce({ assignment: OFFER })
        .mockResolvedValue({ assignment: null }),
      claim: vi.fn().mockResolvedValue(CLAIM),
      heartbeat: vi.fn().mockResolvedValue(null), // lease lost
    };
    const daemon = startDaemon({
      client,
      runtimeEntry: "/entry.js",
      workDir,
      runnerId: "r1",
      once: true,
      sleep: instantSleep(),
      spawn: () => child,
    });
    await daemon.done;
    expect(client.heartbeat).toHaveBeenCalled();
  });

  it("backs off and keeps going on a transient poll error", async () => {
    const workDir = await tmpWorkDir();
    const client = {
      poll: vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValue({ assignment: null, action: "drain" }),
      claim: vi.fn(),
      heartbeat: vi.fn(),
    };
    const daemon = startDaemon({
      client,
      runtimeEntry: "/entry.js",
      workDir,
      runnerId: "r1",
      sleep: instantSleep(),
      spawn: vi.fn(),
    });
    await daemon.done;
    expect(client.poll).toHaveBeenCalledTimes(2);
  });
});

describe("identity round-trip", () => {
  it("saves 0600 and loads back", async () => {
    const { saveIdentity, loadIdentity, removeIdentity } = await import("./identity.js");
    const dir = await mkdtemp(path.join(os.tmpdir(), "bw-runner-id-"));
    const identity = {
      runner_id: "01H_runner",
      runner_token: "bwkr_secret",
      control_plane_url: "https://api.example",
      pool: "default",
      name: "mbp",
      created_at: 1,
    };
    const file = await saveIdentity(dir, identity);
    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(await loadIdentity(dir, "https://api.example", "default")).toEqual(identity);
    await removeIdentity(dir, "https://api.example", "default");
    expect(await loadIdentity(dir, "https://api.example", "default")).toBeNull();
  });

  it("returns null for a corrupt file", async () => {
    const { loadIdentity } = await import("./identity.js");
    const dir = await mkdtemp(path.join(os.tmpdir(), "bw-runner-id-"));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "api.example--default.json"), "{not json");
    expect(await loadIdentity(dir, "https://api.example", "default")).toBeNull();
  });
});

describe("startDaemon — startup reclaim", () => {
  it("removes an orphaned runs/ dir left by a crashed daemon before polling", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "bw-daemon-reclaim-"));
    const orphan = path.join(workDir, "runs", "run_crashed", "workspace");
    await mkdir(orphan, { recursive: true });
    await writeFile(path.join(orphan, "leaked.txt"), "stale credential material");

    const client = {
      poll: vi.fn().mockResolvedValue({ action: "continue", assignment: null }),
      claim: vi.fn(),
      heartbeat: vi.fn(),
    };
    const daemon = startDaemon({
      client: client,
      runtimeEntry: "/x",
      workDir,
      runnerId: "r",
      spawn: () => ({ wait: () => Promise.resolve(0), kill: () => undefined }),
      once: true,
      sleep: () => Promise.resolve(),
    });
    // Give the first poll a tick, then drain out.
    daemon.drain();
    await daemon.done;
    expect(existsSync(path.join(workDir, "runs", "run_crashed"))).toBe(false);
    await rm(workDir, { recursive: true, force: true });
  });
});
