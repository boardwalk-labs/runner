import { describe, it, expect, vi } from "vitest";
import { ErrorCode } from "./support/index.js";
import { BrokerChildDispatcher } from "./broker_child_dispatcher.js";
import type { BrokerChild, RunnerControlClient } from "./runner_control_client.js";
import { RunAbortedError } from "./run_abort.js";

function client(over: {
  startChild?: (slug: string, input: unknown) => Promise<BrokerChild>;
  getChild?: (id: string) => Promise<{ id: string; status: string; output: unknown } | null>;
  scheduleWorkflow?: (slug: string, input: unknown, spec: unknown) => Promise<string>;
}): RunnerControlClient {
  return {
    startChild:
      over.startChild ??
      (() => Promise.resolve({ childRunId: "c1", status: "pending", output: null })),
    getChild:
      over.getChild ?? (() => Promise.resolve({ id: "c1", status: "completed", output: null })),
    scheduleWorkflow: over.scheduleWorkflow ?? (() => Promise.resolve("sched_1")),
  } as unknown as RunnerControlClient;
}

const noSleep = (): Promise<void> => Promise.resolve();

describe("BrokerChildDispatcher.call", () => {
  it("returns the output immediately when the created child is already terminal (re-attach)", async () => {
    const startChild = vi.fn(() =>
      Promise.resolve({ childRunId: "c1", status: "completed", output: { ok: 1 } }),
    );
    const getChild = vi.fn();
    const d = new BrokerChildDispatcher({
      client: client({ startChild, getChild }),
      sleep: noSleep,
    });
    expect(await d.call("child-wf", { x: 1 }, undefined)).toEqual({
      output: { ok: 1 },
      outputSchema: null,
    });
    expect(getChild).not.toHaveBeenCalled(); // no poll needed
  });

  it("holds + polls a pending child to completion, then returns its output", async () => {
    const startChild = vi.fn(() =>
      Promise.resolve({ childRunId: "c1", status: "pending", output: null }),
    );
    const getChild = vi
      .fn<(id: string) => Promise<{ id: string; status: string; output: unknown } | null>>()
      .mockResolvedValueOnce({ id: "c1", status: "running", output: null })
      .mockResolvedValueOnce({ id: "c1", status: "completed", output: { done: true } });
    const d = new BrokerChildDispatcher({
      client: client({ startChild, getChild }),
      sleep: noSleep,
    });
    expect(await d.call("child-wf", null, undefined)).toEqual({
      output: { done: true },
      outputSchema: null,
    });
    expect(getChild).toHaveBeenCalledTimes(2);
  });

  it("throws when the child finishes failed", async () => {
    const startChild = (): Promise<BrokerChild> =>
      Promise.resolve({ childRunId: "c1", status: "failed", output: null });
    const d = new BrokerChildDispatcher({ client: client({ startChild }), sleep: noSleep });
    await expect(d.call("child-wf", null, undefined)).rejects.toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
    });
  });

  it("throws when a polled child vanishes (404 → null)", async () => {
    const startChild = (): Promise<BrokerChild> =>
      Promise.resolve({ childRunId: "c1", status: "pending", output: null });
    const getChild = (): Promise<null> => Promise.resolve(null);
    const d = new BrokerChildDispatcher({
      client: client({ startChild, getChild }),
      sleep: noSleep,
    });
    await expect(d.call("child-wf", null, undefined)).rejects.toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
    });
  });

  it("throws RunAbortedError immediately when the parent's signal is already aborted", async () => {
    const startChild = vi.fn(() =>
      Promise.resolve<BrokerChild>({ childRunId: "c1", status: "pending", output: null }),
    );
    const c = new AbortController();
    c.abort(new RunAbortedError("credit_exhausted"));
    const d = new BrokerChildDispatcher({ client: client({ startChild }), sleep: noSleep });
    await expect(d.call("child-wf", null, undefined, c.signal)).rejects.toBeInstanceOf(
      RunAbortedError,
    );
    expect(startChild).not.toHaveBeenCalled(); // aborted before creating the child
  });

  it("stops polling and throws RunAbortedError when aborted mid-hold", async () => {
    const c = new AbortController();
    const startChild = (): Promise<BrokerChild> =>
      Promise.resolve({ childRunId: "c1", status: "pending", output: null });
    // The child never finishes; the abort fires after the first inter-poll wait.
    const getChild = vi.fn(() => Promise.resolve({ id: "c1", status: "running", output: null }));
    const sleep = (): Promise<void> => {
      c.abort(new RunAbortedError("credit_exhausted"));
      return Promise.resolve();
    };
    const d = new BrokerChildDispatcher({ client: client({ startChild, getChild }), sleep });
    await expect(d.call("child-wf", null, undefined, c.signal)).rejects.toBeInstanceOf(
      RunAbortedError,
    );
    expect(getChild).toHaveBeenCalledTimes(1); // polled once, then the post-sleep abort check fired
  });
});

describe("BrokerChildDispatcher.run", () => {
  it("creates the child and returns its id without polling", async () => {
    const getChild = vi.fn();
    const startChild = vi.fn(() =>
      Promise.resolve({ childRunId: "c9", status: "pending", output: null }),
    );
    const d = new BrokerChildDispatcher({
      client: client({ startChild, getChild }),
      sleep: noSleep,
    });
    expect(await d.run("child-wf", { a: 1 }, undefined)).toBe("c9");
    expect(startChild).toHaveBeenCalledWith("child-wf", { a: 1 });
    expect(getChild).not.toHaveBeenCalled();
  });
});

describe("BrokerChildDispatcher.schedule", () => {
  it("forwards the spec and returns the schedule id", async () => {
    const scheduleWorkflow = vi.fn(() => Promise.resolve("sched_42"));
    const d = new BrokerChildDispatcher({ client: client({ scheduleWorkflow }), sleep: noSleep });
    const id = await d.schedule(
      "daily",
      { team: "growth" },
      { cron: "0 9 * * 1", timezone: "UTC" },
    );
    expect(id).toBe("sched_42");
    expect(scheduleWorkflow).toHaveBeenCalledWith(
      "daily",
      { team: "growth" },
      {
        cron: "0 9 * * 1",
        timezone: "UTC",
      },
    );
  });

  it("normalizes a Date `at` to an ISO string", async () => {
    const scheduleWorkflow = vi.fn(() => Promise.resolve("sched_1"));
    const d = new BrokerChildDispatcher({ client: client({ scheduleWorkflow }), sleep: noSleep });
    await d.schedule("poke", null, { at: new Date("2026-06-16T21:00:00.000Z") });
    expect(scheduleWorkflow).toHaveBeenCalledWith("poke", null, { at: "2026-06-16T21:00:00.000Z" });
  });
});
