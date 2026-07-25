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
    call: () => Promise.resolve({ output: { ok: true }, outputSchema: null }),
    poll: () => Promise.resolve(null),
    start: () =>
      Promise.resolve({
        childRunId: "child_1",
        status: "completed",
        output: { ok: true },
        outputSchema: null,
      }),
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

/** Two macrotask hops: one for the coordinator's drain (it lets queued continuations start work
 *  before committing to a freeze), one for the work that follows. */
const tick = async (): Promise<void> => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

/** The suspension seqs the last suspend request is waiting on, keyed by what they wait FOR — the
 *  host assigns seqs in seam-arrival order, so tests must read them rather than assume them. */
function waitSeqs(requests: unknown[]): Map<string, number> {
  const last = requests[requests.length - 1] as {
    broker_signal: { waits: { reason: string; seq: number; childRunId?: string }[] };
  };
  return new Map(
    last.broker_signal.waits.map((w) => [
      w.reason === "sleep" ? "sleep" : (w.childRunId ?? ""),
      w.seq,
    ]),
  );
}

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
      start: () =>
        Promise.resolve({
          childRunId: "child_9",
          status: "running",
          output: undefined,
          outputSchema: null,
        }),
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
    await expect(call).resolves.toEqual({ output: { answer: 42 }, outputSchema: null });
  });

  it("a failed child surfaces as the seam's error after the wake", async () => {
    const children = childStub({
      start: () =>
        Promise.resolve({
          childRunId: "child_9",
          status: "running",
          output: undefined,
          outputSchema: null,
        }),
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

  it("a wake naming a DIFFERENT child than this call awaits fails loudly", async () => {
    const children = childStub({
      start: () =>
        Promise.resolve({
          childRunId: "child_9",
          status: "running",
          output: undefined,
          outputSchema: null,
        }),
    });
    const { host, freeze } = makeFrozenHost({ children });
    const call = host.callWorkflow("child-flow", {}, undefined);
    await tick();
    // Routed to this seam's seq (so the coordinator hands it over) but carrying someone else's
    // child. Returning that output would be a silent wrong answer, so the seam refuses it.
    wake(freeze, {
      kind: "workflow_call",
      satisfied: [
        {
          seq: 1,
          kind: "workflow_call",
          child: { run_id: "child_OTHER", status: "completed", output: "not mine" },
        },
      ],
    });
    await expect(call).rejects.toThrow(
      /carries child run child_OTHER, but this call awaits child_9/,
    );
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

// A concurrent fan-out of durable children — `Promise.all([workflows.call(a), workflows.call(b)])`
// — is the shape the compound wake exists for (docs/SUSPEND_POLICY.md §1.1). These drive the REAL
// host and REAL coordinator together, so they pin the whole path: every child is dispatched before
// anything freezes, ONE freeze covers the set, and each await gets its own child's output.
describe("WorkerWorkflowHost freeze mode — concurrent workflows.call", () => {
  /** A dispatcher that hands out one child per (slug) and records dispatch order. */
  function fanOutChildren(started: string[]): ChildDispatcher {
    return childStub({
      start: (slug: string) => {
        started.push(slug);
        return Promise.resolve({
          childRunId: `child_${slug}`,
          status: "running",
          output: undefined,
          outputSchema: null,
        });
      },
      poll: () => Promise.resolve(null),
    });
  }

  it("dispatches every child, then freezes ONCE for the whole set", async () => {
    const started: string[] = [];
    const { host, requests } = makeFrozenHost({ children: fanOutChildren(started) });

    const calls = Promise.all([
      host.callWorkflow("a", { i: 1 }, undefined),
      host.callWorkflow("b", { i: 2 }, undefined),
      host.callWorkflow("c", { i: 3 }, undefined),
    ]);
    await tick();

    // All three children are running BEFORE the parent suspends — the fan-out is genuinely
    // concurrent, not one child per freeze/wake cycle.
    expect(started).toEqual(["a", "b", "c"]);
    expect(requests).toHaveLength(1);
    const req = requests[0] as { broker_signal: { waits: { childRunId?: string }[] } };
    expect(req.broker_signal.waits.map((w) => w.childRunId)).toEqual([
      "child_a",
      "child_b",
      "child_c",
    ]);
    void calls;
  });

  it("resolves each await with its own child's output from one compound wake", async () => {
    const { host, freeze, requests } = makeFrozenHost({ children: fanOutChildren([]) });
    const calls = Promise.all([
      host.callWorkflow("a", {}, undefined),
      host.callWorkflow("b", {}, undefined),
    ]);
    await tick();
    const seqs = waitSeqs(requests);

    wake(freeze, {
      kind: "workflow_call",
      satisfied: [
        {
          seq: seqs.get("child_a"),
          kind: "workflow_call",
          child: { run_id: "child_a", status: "completed", output: "A" },
        },
        {
          seq: seqs.get("child_b"),
          kind: "workflow_call",
          child: { run_id: "child_b", status: "completed", output: "B" },
        },
      ],
    });

    expect(await calls).toEqual([
      { output: "A", outputSchema: null },
      { output: "B", outputSchema: null },
    ]);
  });

  it("re-freezes on the remainder when only one child has finished", async () => {
    const { host, freeze, requests } = makeFrozenHost({ children: fanOutChildren([]) });
    const first = host.callWorkflow("a", {}, undefined);
    const second = host.callWorkflow("b", {}, undefined);
    await tick();
    expect(requests).toHaveLength(1);
    const seqs = waitSeqs(requests);

    wake(freeze, {
      kind: "workflow_call",
      satisfied: [
        {
          seq: seqs.get("child_a"),
          kind: "workflow_call",
          child: { run_id: "child_a", status: "completed", output: "A" },
        },
      ],
    });
    expect(await first).toEqual({ output: "A", outputSchema: null });
    await tick();

    // The finished child is gone from the condition; the outstanding one is the whole of it.
    expect(requests).toHaveLength(2);
    const again = requests[1] as { broker_signal: { waits: { childRunId?: string }[] } };
    expect(again.broker_signal.waits.map((w) => w.childRunId)).toEqual(["child_b"]);

    wake(freeze, {
      kind: "workflow_call",
      satisfied: [
        {
          seq: seqs.get("child_b"),
          kind: "workflow_call",
          child: { run_id: "child_b", status: "completed", output: "B" },
        },
      ],
    });
    expect(await second).toEqual({ output: "B", outputSchema: null });
  });

  it("a woken call's continuation runs before the next freeze (a pool keeps dispatching)", async () => {
    const started: string[] = [];
    const { host, freeze, requests } = makeFrozenHost({ children: fanOutChildren(started) });

    // The worker-pool shape: when one child lands, that worker immediately starts the next task.
    // The freeze must not slam shut on the continuation, or the pool stalls with tasks undispatched.
    const worker = (async (): Promise<unknown> => {
      const one = await host.callWorkflow("a", {}, undefined);
      const two = await host.callWorkflow("next", {}, undefined);
      return [one, two];
    })();
    const sibling = host.callWorkflow("b", {}, undefined);
    await tick();
    expect(started).toEqual(["a", "b"]);
    const first = waitSeqs(requests);

    wake(freeze, {
      kind: "workflow_call",
      satisfied: [
        {
          seq: first.get("child_a"),
          kind: "workflow_call",
          child: { run_id: "child_a", status: "completed", output: "A" },
        },
      ],
    });
    await tick();
    await tick();

    // The continuation dispatched its follow-up task, and the next freeze waits on BOTH the
    // outstanding sibling and the newly started child.
    expect(started).toEqual(["a", "b", "next"]);
    const again = requests[requests.length - 1] as {
      broker_signal: { waits: { childRunId?: string }[] };
    };
    expect(again.broker_signal.waits.map((w) => w.childRunId).sort()).toEqual([
      "child_b",
      "child_next",
    ]);

    const second = waitSeqs(requests);
    wake(freeze, {
      kind: "workflow_call",
      satisfied: [
        {
          seq: second.get("child_b"),
          kind: "workflow_call",
          child: { run_id: "child_b", status: "completed", output: "B" },
        },
        {
          seq: second.get("child_next"),
          kind: "workflow_call",
          child: { run_id: "child_next", status: "completed", output: "N" },
        },
      ],
    });
    expect(await worker).toEqual([
      { output: "A", outputSchema: null },
      { output: "N", outputSchema: null },
    ]);
    expect(await sibling).toEqual({ output: "B", outputSchema: null });
  });

  it("composes a child wait with a long sleep in one freeze", async () => {
    const { host, freeze, requests } = makeFrozenHost({ children: fanOutChildren([]) });
    const call = host.callWorkflow("a", {}, undefined);
    const napping = host.sleep(600_000);
    await tick();

    expect(requests).toHaveLength(1);
    const req = requests[0] as {
      reason: string;
      wake: { waits: { kind: string }[] };
    };
    // The child wait outranks the timer for the run's displayed status.
    expect(req.reason).toBe("workflow_call");
    expect(req.wake.waits.map((w) => w.kind).sort()).toEqual(["sleep", "workflow_call"]);

    const seqs = waitSeqs(requests);
    wake(freeze, {
      kind: "sleep",
      satisfied: [
        { seq: seqs.get("sleep"), kind: "sleep" },
        {
          seq: seqs.get("child_a"),
          kind: "workflow_call",
          child: { run_id: "child_a", status: "completed", output: "A" },
        },
      ],
    });
    await expect(napping).resolves.toBeUndefined();
    expect(await call).toEqual({ output: "A", outputSchema: null });
  });
});
