// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi } from "vitest";
import {
  buildContainerArgs,
  containerEnv,
  createContainerSpawner,
  detectContainerRuntime,
  runIdFromCwd,
} from "./container.js";

const CFG = { runtime: "docker", image: "ghcr.io/boardwalk-labs/runner:0.1.9" };
const CWD = "/home/nick/.boardwalk/runner/work/runs/01KWX7VYJB/workspace";
const ENV = {
  RUN_ID: "01KWX7VYJB",
  BOARDWALK_CONTROL_PLANE_URL: "https://api.boardwalk.sh",
  BOARDWALK_RUN_TOKEN: "eyJ-super-secret-run-token",
  BOARDWALK_API_KEY: "bwk_super_secret_api_token",
};

/** The `-v` values from a docker argv. */
function mountsOf(args: string[]): string[] {
  return args.filter((_, i) => args[i - 1] === "-v");
}

describe("buildContainerArgs — isolation guarantees", () => {
  const args = buildContainerArgs(CFG, { env: ENV, cwd: CWD });
  const joined = args.join(" ");

  it("mounts ONLY the per-run workspace (no identity dir, home, or host root)", () => {
    const mounts = args.filter((_, i) => args[i - 1] === "-v");
    expect(mounts).toEqual([`${CWD}:/workspace`]);
    // Nothing resembling the identity dir / home / host root is ever mounted.
    expect(joined).not.toContain(".boardwalk/runner/main-api"); // identity file dir
    expect(mounts.some((m) => m.startsWith("/:") || m.startsWith("/home/nick:"))).toBe(false);
  });

  // Persistent workspaces on a self-hosted runner live on the runner's own disk (I3). The daemon
  // resolves the scope and binds THAT ONE DIR — the mount is the isolation boundary here, because a
  // run's program is arbitrary code with raw fs access.
  describe("the persistent-workspace mount", () => {
    const PERSIST_SCOPE = "/home/nick/.boardwalk/runner/work/persist/wf_1/_base";
    const withPersist = buildContainerArgs(CFG, {
      env: { ...ENV, PERSIST_SCOPE_DIR: PERSIST_SCOPE },
      cwd: CWD,
    });
    const mounts = withPersist.filter((_, i) => withPersist[i - 1] === "-v");

    it("mounts THIS run's scope only — never the persist root, never another workflow's", () => {
      expect(mounts).toEqual([`${CWD}:/workspace`, `${PERSIST_SCOPE}:/persist`]);
      // The root would expose every workflow's persisted state on the machine to every run. Hosted
      // isolates per workflow via the token-derived S3 key; self-hosted must not be weaker.
      expect(mounts).not.toContain("/home/nick/.boardwalk/runner/work/persist:/persist");
    });

    it("rewrites the in-container path (the host path is meaningless inside)", () => {
      expect(containerEnv({ ...ENV, PERSIST_SCOPE_DIR: PERSIST_SCOPE }).PERSIST_SCOPE_DIR).toBe(
        "/persist",
      );
    });

    it("adds no mount and no path when the daemon resolved no scope", () => {
      expect(mountsOf(buildContainerArgs(CFG, { env: ENV, cwd: CWD }))).toEqual([
        `${CWD}:/workspace`,
      ]);
      expect(containerEnv(ENV).PERSIST_SCOPE_DIR).toBeUndefined();
    });
  });

  it("never puts a credential VALUE in the argv (passes env by NAME only)", () => {
    expect(joined).not.toContain("eyJ-super-secret-run-token");
    expect(joined).not.toContain("bwk_super_secret_api_token");
    // Each env key is a name-only `-e KEY` (no `=VALUE`).
    const envArgs = args.filter((_, i) => args[i - 1] === "-e");
    expect(envArgs).toContain("BOARDWALK_RUN_TOKEN");
    expect(envArgs.every((e) => !e.includes("="))).toBe(true);
  });

  it("preserves the machine network + uses a throwaway, signal-handled container", () => {
    expect(joined).toContain("--network host");
    expect(args).toContain("--rm");
    expect(args).toContain("--init");
    expect(args[args.length - 1]).toBe(CFG.image); // image is the final arg
  });

  it("honors an explicit network override + extra user mounts", () => {
    const a = buildContainerArgs(
      { ...CFG, network: "bridge", mounts: ["/data/nas:/data:ro"] },
      { env: ENV, cwd: CWD },
    );
    expect(a.join(" ")).toContain("--network bridge");
    const mounts = a.filter((_, i) => a[i - 1] === "-v");
    expect(mounts).toEqual([`${CWD}:/workspace`, "/data/nas:/data:ro"]);
  });

  it("runs as the invoking user when set (Linux bind-mount ownership); omits --user otherwise", () => {
    expect(args).not.toContain("--user"); // CFG has no user
    const a = buildContainerArgs({ ...CFG, user: "501:20" }, { env: ENV, cwd: CWD });
    const i = a.indexOf("--user");
    expect(i).toBeGreaterThan(-1);
    expect(a[i + 1]).toBe("501:20");
  });
});

describe("containerEnv", () => {
  it("overrides host filesystem coordinates for the container", () => {
    const env = containerEnv(ENV);
    expect(env.WORKSPACE_ROOT).toBe("/workspace");
    expect(env.HOME).toBe("/workspace");
    expect(env.RUN_ID).toBe("01KWX7VYJB");
    expect(env.BOARDWALK_RUN_TOKEN).toBe("eyJ-super-secret-run-token"); // value flows via env, not argv
  });
});

describe("runIdFromCwd", () => {
  it("extracts the run id from the workspace path", () => {
    expect(runIdFromCwd(CWD)).toBe("01KWX7VYJB");
  });
  it("falls back to a safe constant for a non-standard cwd", () => {
    expect(runIdFromCwd("/tmp/../weird/;rm -rf/workspace")).toBe("run");
  });
});

describe("createContainerSpawner", () => {
  it("spawns the runtime with the args + sets the env values on the client (not argv)", () => {
    const calls: { bin: string; args: string[]; env: Record<string, string> }[] = [];
    const fakeSpawn = vi.fn(
      (bin: string, args: string[], opts: { env: Record<string, string> }) => {
        calls.push({ bin, args, env: opts.env });
        return {
          on: (_e: string, _cb: unknown) => undefined,
          kill: () => undefined,
        } as never;
      },
    );
    const spawner = createContainerSpawner({ ...CFG, spawn: fakeSpawn as never });
    spawner({ entry: "/ignored/main.js", env: ENV, cwd: CWD });
    expect(calls[0]?.bin).toBe("docker");
    // The token value is set on the child's ENV (for the name-only `-e`), never in the argv.
    expect(calls[0]?.env.BOARDWALK_RUN_TOKEN).toBe("eyJ-super-secret-run-token");
    expect(calls[0]?.args.join(" ")).not.toContain("eyJ-super-secret-run-token");
  });
});

describe("detectContainerRuntime", () => {
  it("returns the first runtime whose `info` probe succeeds", async () => {
    const got = await detectContainerRuntime(["docker", "podman"], (bin) =>
      bin === "podman" ? Promise.resolve() : Promise.reject(new Error("not found")),
    );
    expect(got).toBe("podman");
  });
  it("returns null when no runtime is available (start hard-fails with a clear message)", async () => {
    const got = await detectContainerRuntime(["docker", "podman"], () =>
      Promise.reject(new Error("not found")),
    );
    expect(got).toBeNull();
  });
});
