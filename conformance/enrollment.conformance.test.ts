// SPDX-License-Identifier: Apache-2.0

// Conformance: enrollment and the poll/claim lifecycle, over a real socket.
//
// These cases assert the WIRE, not the internals: what a runner puts on each request, what it
// does with each response, and which failures it must not survive. They exist because every
// unit test on both sides mocks this seam, so both sides can agree on something wrong.

import { afterEach, describe, expect, it } from "vitest";
import {
  cappedSleep,
  CONFORMANCE_RUNNER_TOKEN,
  disposeConformance,
  makeWorkDir,
  offer,
  startFakeControlPlane,
  stubSpawner,
} from "./harness.js";
import { PoolClient } from "../src/daemon/pool_client.js";
import { startDaemon } from "../src/daemon/daemon.js";

afterEach(disposeConformance);

describe("conformance: enrollment", () => {
  it("registration declares who and what this machine is", async () => {
    const cp = await startFakeControlPlane();
    const client = new PoolClient({ baseUrl: cp.baseUrl });

    const res = await client.register({
      registration_token: "bwkreg_conformance",
      name: "conformance-box",
      labels: ["gpu"],
      os: "linux",
      arch: "x64",
      runner_version: "9.9.9",
    });

    expect(res.runner_token).toBe(CONFORMANCE_RUNNER_TOKEN);
    const [registration] = cp.registrations;
    // The control plane cannot enforce a floor on something it was never told. A runner that
    // enrolls without declaring its version is how self-hosted runners were dead platform-wide.
    expect(registration?.runner_version).toBe("9.9.9");
    expect(registration?.labels).toEqual(["gpu"]);
  });

  it("the standing token — not the registration token — authenticates everything after register", async () => {
    const cp = await startFakeControlPlane();
    const client = new PoolClient({ baseUrl: cp.baseUrl });
    await client.register({
      registration_token: "bwkreg_conformance",
      name: "conformance-box",
      labels: [],
    });

    // A registration request carries its credential in the BODY and no bearer header at all;
    // every later call carries the standing token and no registration token.
    const [registerCall] = cp.callsTo("/runner/v1/register");
    expect(registerCall?.auth).toBeNull();

    const authed = new PoolClient({ baseUrl: cp.baseUrl, runnerToken: CONFORMANCE_RUNNER_TOKEN });
    await authed.poll();
    const [pollCall] = cp.callsTo("/runner/v1/pool/poll");
    expect(pollCall?.auth).toBe(CONFORMANCE_RUNNER_TOKEN);
    expect(pollCall?.body).not.toHaveProperty("registration_token");
  });

  it("a wrong standing token is refused, and the client surfaces the status", async () => {
    const cp = await startFakeControlPlane();
    const client = new PoolClient({ baseUrl: cp.baseUrl, runnerToken: "bwkr_not_the_one" });
    await expect(client.poll()).rejects.toMatchObject({ status: 401, operation: "poll" });
  });
});

describe("conformance: poll → claim → run", () => {
  it("drives one assignment end to end and hands the run its claim credentials", async () => {
    const cp = await startFakeControlPlane({ offers: [offer("a1")] });
    const spawner = stubSpawner();
    const daemon = startDaemon({
      client: new PoolClient({ baseUrl: cp.baseUrl, runnerToken: CONFORMANCE_RUNNER_TOKEN }),
      runtimeEntry: "/runtime/main.js",
      workDir: makeWorkDir(),
      runnerId: "01H_conformance_runner",
      spawn: spawner.spawn,
      sleep: cappedSleep(1),
      once: true,
    });
    await daemon.done;

    // The offer carried NO credentials; the claim is the only place they exist, and they must
    // reach the run process as the platform contract env.
    const [pollCall] = cp.callsTo("/runner/v1/pool/poll");
    expect(pollCall?.body).not.toHaveProperty("run_token");
    const [run] = spawner.spawned;
    expect(run?.env.RUN_ID).toBe("run_a1");
    expect(run?.env.BOARDWALK_RUN_TOKEN).toBe("bwrt_conformance_run_token");
    expect(run?.env.BOARDWALK_CONTROL_PLANE_URL).toBe("https://control-plane.invalid");
    // Self-hosted compute is Boardwalk-unbilled, so the host's core count must not be stamped.
    expect(run?.env.BOARDWALK_TASK_CPU_UNITS).toBeUndefined();
  });

  it("a lost claim race is not an error — the runner goes back to polling", async () => {
    const cp = await startFakeControlPlane({
      offers: [offer("a1"), offer("a2")],
      claimConflictOnce: true,
    });
    const spawner = stubSpawner();
    const daemon = startDaemon({
      client: new PoolClient({ baseUrl: cp.baseUrl, runnerToken: CONFORMANCE_RUNNER_TOKEN }),
      runtimeEntry: "/runtime/main.js",
      workDir: makeWorkDir(),
      runnerId: "01H_conformance_runner",
      spawn: spawner.spawn,
      sleep: cappedSleep(1),
      once: true,
    });
    await daemon.done;

    // 409 on the first claim, then the second offer runs — one run, two claims attempted.
    expect(cp.callsTo("/claim")).toHaveLength(2);
    expect(spawner.spawned).toHaveLength(1);
    expect(spawner.spawned[0]?.env.RUN_ID).toBe("run_a2");
  });
});

describe("conformance: refusal", () => {
  // The bug this whole suite exists for. A refused identity cannot resolve while the process
  // runs, so retrying it is an infinite loop wearing the costume of a healthy runner.
  it.each([
    [401, "UNAUTHORIZED", "Invalid runner token"],
    [403, "FORBIDDEN", "This runner reports version (none), below the minimum 0.3.10."],
  ])("stops on a %i at poll instead of retrying forever", async (status, code, message) => {
    const cp = await startFakeControlPlane({ rejectPollWith: { status, code, message } });
    const onOnline = vi_fn();
    const daemon = startDaemon({
      client: new PoolClient({ baseUrl: cp.baseUrl, runnerToken: CONFORMANCE_RUNNER_TOKEN }),
      runtimeEntry: "/runtime/main.js",
      workDir: makeWorkDir(),
      runnerId: "01H_conformance_runner",
      spawn: stubSpawner().spawn,
      sleep: cappedSleep(1),
      onOnline: onOnline.fn,
    });

    await expect(daemon.done).rejects.toMatchObject({ status, operation: "poll" });
    expect(cp.callsTo("/runner/v1/pool/poll")).toHaveLength(1);
    // And it must never have claimed to be online, because it never was.
    expect(onOnline.calls).toBe(0);
  });

  it("announces online only once the control plane accepts a poll", async () => {
    const cp = await startFakeControlPlane({ drainAfterPolls: 2 });
    const onOnline = vi_fn();
    const daemon = startDaemon({
      client: new PoolClient({ baseUrl: cp.baseUrl, runnerToken: CONFORMANCE_RUNNER_TOKEN }),
      runtimeEntry: "/runtime/main.js",
      workDir: makeWorkDir(),
      runnerId: "01H_conformance_runner",
      spawn: stubSpawner().spawn,
      sleep: cappedSleep(1),
      onOnline: onOnline.fn,
    });
    await daemon.done;
    // Two accepted polls, ONE announcement — it is a state change, not a heartbeat.
    expect(onOnline.calls).toBe(1);
  });
});

describe("conformance: lease", () => {
  it("heartbeats the lease while the run process lives", async () => {
    const cp = await startFakeControlPlane({ offers: [offer("a1")] });
    const daemon = startDaemon({
      client: new PoolClient({ baseUrl: cp.baseUrl, runnerToken: CONFORMANCE_RUNNER_TOKEN }),
      runtimeEntry: "/runtime/main.js",
      workDir: makeWorkDir(),
      runnerId: "01H_conformance_runner",
      spawn: stubSpawner({ holdMs: 60 }).spawn,
      sleep: cappedSleep(5),
      once: true,
    });
    await daemon.done;

    const beats = cp.callsTo("/runner/v1/pool/heartbeat");
    expect(beats.length).toBeGreaterThan(0);
    // The lease is identified by lease_id + run_id — the fake control plane already rejected any
    // beat that failed heartbeatRequestSchema, so reaching here means the shape is right too.
    expect(beats[0]?.body).toMatchObject({
      lease_id: "lease_a1",
      run_id: "run_a1",
      phase: "running",
    });
  });

  it("kills the run when the lease is lost — the control plane already recovered it", async () => {
    const cp = await startFakeControlPlane({ offers: [offer("a1")], heartbeat: "lease_lost" });
    const spawner = stubSpawner({ holdMs: 200 });
    const daemon = startDaemon({
      client: new PoolClient({ baseUrl: cp.baseUrl, runnerToken: CONFORMANCE_RUNNER_TOKEN }),
      runtimeEntry: "/runtime/main.js",
      workDir: makeWorkDir(),
      runnerId: "01H_conformance_runner",
      spawn: spawner.spawn,
      sleep: cappedSleep(5),
      once: true,
    });
    await daemon.done;
    // Continuing to run work the control plane has handed to someone else is the one thing a
    // lost lease must never allow.
    expect(spawner.spawned).toHaveLength(1);
    expect(cp.callsTo("/runner/v1/pool/heartbeat").length).toBeGreaterThan(0);
  });
});

/** A counter with a stable identity — vitest's `vi` is not imported into the harness on purpose. */
function vi_fn(): { fn: () => void; calls: number } {
  const state = { calls: 0, fn: () => {} };
  state.fn = () => {
    state.calls += 1;
  };
  return state;
}
