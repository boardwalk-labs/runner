// Freeze-mode (snapshot substrate) behavior of WorkerWorkflowHost: suspending seams block on
// the FreezeCoordinator and resolve IN PLACE from the wake value — no onSuspend, no exit, no
// exit-and-restart. The coordinator here is real; only the relay channel is scripted, so these
// tests pin the host↔coordinator contract end to end.

import { describe, it, expect, vi } from "vitest";
import { LeafParked } from "@boardwalk-labs/engine/core";
import { WorkerWorkflowHost, type ChildDispatcher, type LeafExecutor } from "./workflow_host.js";
import { FreezeCoordinator } from "./freeze_coordinator.js";
import type { SuspendSignal } from "./suspension.js";

function childStub(over: Partial<ChildDispatcher> = {}): ChildDispatcher {
  return {
    call: () => Promise.resolve({ ok: true }),
    start: () =>
      Promise.resolve({ childRunId: "child_1", status: "completed", output: { ok: true } }),
    poll: () => Promise.resolve(null),
    run: () => Promise.resolve("run_1"),
    schedule: () => Promise.resolve("sched_1"),
    ...over,
  };
}

/** A real coordinator over a scripted channel, plus a freeze-mode host around it. */
interface FakeHeld {
  register: (seq: number, gate: unknown) => Promise<unknown>;
  poll: (seq: number) => Promise<Record<string, unknown>>;
}
function makeFrozenHost(
  over: Partial<{ leaf: LeafExecutor; children: ChildDispatcher; heldInput: FakeHeld }> = {},
): {
  host: WorkerWorkflowHost;
  freeze: FreezeCoordinator;
  requests: unknown[];
  held: number[];
} {
  const requests: unknown[] = [];
  const freeze = new FreezeCoordinator({
    channel: {
      sendSuspendRequest: (p: unknown) => requests.push(p),
      sendWakeAccepted: () => undefined,
    },
    delay: () => Promise.resolve(),
  });
  const held: number[] = [];
  const host = new WorkerWorkflowHost({
    leaf: over.leaf ?? { run: () => Promise.resolve("leaf") },
    children: over.children ?? childStub(),
    secrets: { get: () => Promise.resolve("sek") },
    runtime: {
      runId: "run_test",
      workflowId: "wf_test",
      orgId: "org_test",
      apiUrl: "https://api.test",
      apiToken: () => Promise.resolve("api-token-test"),
      idToken: () => Promise.resolve("id-token-test"),
    },
    sleeper: {
      hold: (ms) => {
        held.push(ms);
        return Promise.resolve();
      },
    },
    now: () => 1_000,
    freeze,
    ...(over.heldInput !== undefined ? { heldInput: over.heldInput, heldPollIntervalMs: 1 } : {}),
  });
  return { host, freeze, requests, held };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function wake(freeze: FreezeCoordinator, value: Record<string, unknown>): void {
  freeze.onWake({ run_token: "fresh", wall_clock_ms: 2_000, wake: value });
}

describe("WorkerWorkflowHost freeze mode", () => {
  it("a long sleep freezes and resolves in place on wake", async () => {
    const { host, freeze, requests } = makeFrozenHost();
    const sleeping = host.sleep(60_000);
    await tick();
    expect(requests).toHaveLength(1);
    const req = requests[0] as { reason: string; broker_signal: SuspendSignal };
    expect(req.reason).toBe("sleep");
    expect(req.broker_signal.durationMs).toBe(60_000);

    wake(freeze, { kind: "sleep" });
    await expect(sleeping).resolves.toBeUndefined();
  });

  it("an aborted sleep freeze holds the remainder in-process", async () => {
    const { host, freeze, held } = makeFrozenHost();
    const sleeping = host.sleep(60_000);
    await tick();
    freeze.onSuspendAbort({ reason: "store_unavailable" });
    await sleeping;
    expect(held).toEqual([60_000]); // injected clock doesn't advance → full remainder held
  });

  it("a short sleep never freezes (the threshold)", async () => {
    const { host, requests, held } = makeFrozenHost();
    await host.sleep(1_000);
    expect(requests).toHaveLength(0);
    expect(held).toEqual([1_000]);
  });

  it("humanInput freezes and returns the wake's answer for its gate", async () => {
    const { host, freeze, requests } = makeFrozenHost();
    const gate = host.humanInput({
      key: "approve",
      prompt: "ok?",
      input: { kind: "choice", options: ["yes", "no"] },
    });
    await tick();
    const req = requests[0] as { reason: string; wake: { request_keys: string[] } };
    expect(req.reason).toBe("human_input");
    expect(req.wake.request_keys).toEqual(["approve"]);

    wake(freeze, { kind: "human_input", answers: { approve: { value: "yes", isOther: false } } });
    await expect(gate).resolves.toEqual({ value: "yes", isOther: false });
  });

  it("a wake missing the parked gate fails loudly (control plane and snapshot disagree)", async () => {
    const { host, freeze } = makeFrozenHost();
    const gate = host.humanInput({
      key: "approve",
      prompt: "ok?",
      input: { kind: "choice", options: ["yes", "no"] },
    });
    await tick();
    wake(freeze, { kind: "human_input", answers: { other: { value: "?" } } });
    await expect(gate).rejects.toThrow(/does not answer the parked gate/);
  });

  it("a parked agent leaf freezes, then re-enters from its checkpoint with the answers", async () => {
    const checkpoint = {
      messages: [],
      iteration: 3,
      totals: { inputTokens: 10, outputTokens: 5 },
    };
    const parked = new LeafParked({ toolCallId: "tc_1", prompt: "approve?", inputSpec: undefined });
    parked.checkpoint = checkpoint;
    const runs: unknown[] = [];
    const leaf: LeafExecutor = {
      run: (_p, _o, _s, resume) => {
        runs.push(resume);
        if (resume === undefined) return Promise.reject(parked);
        return Promise.resolve("leaf-done");
      },
    };
    const { host, freeze, requests } = makeFrozenHost({ leaf });
    const agent = host.agent("do it", undefined);
    await tick();
    const req = requests[0] as { reason: string; broker_signal: SuspendSignal };
    expect(req.reason).toBe("human_input");
    expect(req.broker_signal.leafCheckpoint).toEqual(checkpoint);

    wake(freeze, { kind: "human_input", answers: { tc_1: { value: "approved" } } });
    await expect(agent).resolves.toBe("leaf-done");
    expect(runs).toEqual([undefined, { checkpoint, answers: { tc_1: { value: "approved" } } }]);
  });

  it("a child wait freezes and resolves from the wake's finalized child", async () => {
    const children = childStub({
      start: () => Promise.resolve({ childRunId: "child_9", status: "running", output: undefined }),
    });
    const { host, freeze, requests } = makeFrozenHost({ children });
    const frozenHost = new WorkerWorkflowHost({
      leaf: { run: () => Promise.resolve("leaf") },
      children,
      secrets: { get: () => Promise.resolve("sek") },
      runtime: host.runtime,
      freeze,
    });
    const call = frozenHost.callWorkflow("child-flow", { n: 1 }, undefined);
    await tick();
    const req = requests[0] as { reason: string; wake: { child_run_id: string } };
    expect(req.reason).toBe("workflow_call");
    expect(req.wake.child_run_id).toBe("child_9");

    wake(freeze, {
      kind: "workflow_call",
      child: { run_id: "child_9", status: "completed", output: { answer: 42 } },
    });
    await expect(call).resolves.toEqual({ answer: 42 });
  });

  it("a failed child surfaces as the seam's error after the wake", async () => {
    const children = childStub({
      start: () => Promise.resolve({ childRunId: "child_9", status: "running", output: undefined }),
    });
    const { freeze } = makeFrozenHost();
    const host = new WorkerWorkflowHost({
      leaf: { run: () => Promise.resolve("leaf") },
      children,
      secrets: { get: () => Promise.resolve("sek") },
      runtime: {
        runId: "run_test",
        workflowId: "wf_test",
        orgId: "org_test",
        apiUrl: "https://api.test",
        apiToken: () => Promise.resolve("t"),
        idToken: () => Promise.resolve("id-token-test"),
      },
      freeze,
    });
    const call = host.callWorkflow("child-flow", {}, undefined);
    await tick();
    wake(freeze, {
      kind: "workflow_call",
      child: { run_id: "child_9", status: "failed", output: undefined },
    });
    await expect(call).rejects.toThrow(/failed \(run child_9\)/);
  });

  it("a sibling agent leaf delays the freeze until it finishes (the gate, through the host)", async () => {
    let releaseLeaf: () => void = () => undefined;
    const leaf: LeafExecutor = {
      run: () =>
        new Promise((resolve) => {
          releaseLeaf = () => resolve("slow-leaf");
        }),
    };
    const { host, freeze, requests } = makeFrozenHost({ leaf });

    const agent = host.agent("slow", undefined);
    await tick();
    const sleeping = host.sleep(60_000);
    await tick();
    expect(requests).toHaveLength(0); // the live leaf blocks the freeze

    releaseLeaf();
    await agent;
    await tick();
    expect(requests).toHaveLength(1); // quiescent → frozen

    wake(freeze, { kind: "sleep" });
    await sleeping;
  });

  it("hooks that arrive while frozen queue and run after the wake", async () => {
    const { host, freeze } = makeFrozenHost();
    const sleeping = host.sleep(60_000);
    await tick();

    const started = vi.fn();
    const secret = host.getSecret("k").then((v) => {
      started();
      return v;
    });
    await tick();
    expect(started).not.toHaveBeenCalled(); // queued behind the pending freeze

    wake(freeze, { kind: "sleep" });
    await sleeping;
    await expect(secret).resolves.toBe("sek");
  });

  it("register-without-release: a held gate answered during a running sibling resolves WITHOUT freezing", async () => {
    let releaseLeaf: () => void = () => undefined;
    const leaf: LeafExecutor = {
      run: () => new Promise((resolve) => (releaseLeaf = () => resolve("slow-leaf"))),
    };
    const registered: number[] = [];
    let answered = false;
    const heldInput: FakeHeld = {
      register: (seq) => {
        registered.push(seq);
        return Promise.resolve(true);
      },
      // The human answers while the sibling is still running.
      poll: () => Promise.resolve(answered ? { approve: { value: "yes", isOther: false } } : {}),
    };
    const { host, requests } = makeFrozenHost({ leaf, heldInput });

    const agent = host.agent("slow", undefined); // sibling in flight → the gate will HOLD
    await tick();
    const gate = host.humanInput({
      key: "approve",
      prompt: "ok?",
      input: { kind: "choice", options: ["yes", "no"] },
    });
    await tick();
    expect(registered).toEqual([expect.any(Number)]); // registered immediately (answerable while held)
    expect(requests).toHaveLength(0); // holding — never froze

    answered = true; // the human responds during the hold
    await expect(gate).resolves.toEqual({ value: "yes", isOther: false });
    expect(requests).toHaveLength(0); // resolved in-process, no freeze

    releaseLeaf();
    await agent;
  });

  it("register-without-release: an unanswered held gate freezes once the sibling finishes; wake carries the answer", async () => {
    let releaseLeaf: () => void = () => undefined;
    const leaf: LeafExecutor = {
      run: () => new Promise((resolve) => (releaseLeaf = () => resolve("slow-leaf"))),
    };
    const heldInput: FakeHeld = {
      register: () => Promise.resolve(true),
      poll: () => Promise.resolve({}), // never answered via poll
    };
    const { host, freeze, requests } = makeFrozenHost({ leaf, heldInput });

    const agent = host.agent("slow", undefined);
    await tick();
    const gate = host.humanInput({
      key: "approve",
      prompt: "ok?",
      input: { kind: "choice", options: ["yes", "no"] },
    });
    await tick();
    expect(requests).toHaveLength(0); // holding

    releaseLeaf(); // sibling done → quiescence → the gate freezes
    await agent;
    await tick();
    expect(requests).toHaveLength(1);

    wake(freeze, { kind: "human_input", answers: { approve: { value: "no", isOther: false } } });
    await expect(gate).resolves.toEqual({ value: "no", isOther: false });
  });
});
