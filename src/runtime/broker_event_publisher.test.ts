import { describe, it, expect, vi, afterEach } from "vitest";
import { BrokerEventPublisher } from "./broker_event_publisher.js";

function recorder(): { send: (frames: string[]) => Promise<void>; batches: string[][] } {
  const batches: string[][] = [];
  return {
    send: (frames) => {
      batches.push(frames);
      return Promise.resolve();
    },
    batches,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("BrokerEventPublisher", () => {
  it("buffers below the batch size without sending", async () => {
    const { send, batches } = recorder();
    const pub = new BrokerEventPublisher({ send, maxBatch: 4 });
    await pub.publish("run:1", "a");
    await pub.publish("run:1", "b");
    expect(batches).toEqual([]);
  });

  it("flushes once the batch size is reached", async () => {
    const { send, batches } = recorder();
    const pub = new BrokerEventPublisher({ send, maxBatch: 2 });
    await pub.publish("run:1", "a");
    await pub.publish("run:1", "b");
    // flush is fire-and-forget on size; let the microtask settle.
    await Promise.resolve();
    expect(batches).toEqual([["a", "b"]]);
  });

  it("flush() ships the partial batch and close() drains the tail", async () => {
    const { send, batches } = recorder();
    const pub = new BrokerEventPublisher({ send, maxBatch: 10 });
    await pub.publish("run:1", "a");
    await pub.flush();
    expect(batches).toEqual([["a"]]);
    await pub.publish("run:1", "b");
    await pub.close();
    expect(batches).toEqual([["a"], ["b"]]);
  });

  it("flushes a partial batch after the delay timer fires", async () => {
    vi.useFakeTimers();
    const { send, batches } = recorder();
    const pub = new BrokerEventPublisher({ send, maxBatch: 10, maxDelayMs: 200 });
    await pub.publish("run:1", "a");
    expect(batches).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(batches).toEqual([["a"]]);
  });

  it("ignores the channel (broker derives it from the run token)", async () => {
    const { send, batches } = recorder();
    const pub = new BrokerEventPublisher({ send, maxBatch: 1 });
    await pub.publish("whatever-channel", "frame");
    await Promise.resolve();
    expect(batches).toEqual([["frame"]]);
  });

  it("swallows a send failure (best-effort, like the direct Redis publish)", async () => {
    const pub = new BrokerEventPublisher({
      send: () => Promise.reject(new Error("broker down")),
      maxBatch: 1,
    });
    await pub.publish("run:1", "a");
    // close() awaits the (failed) flush; it must resolve, not reject.
    await expect(pub.close()).resolves.toBeUndefined();
  });

  it("close() is a no-op when nothing is buffered", async () => {
    const { send, batches } = recorder();
    const pub = new BrokerEventPublisher({ send });
    await pub.close();
    expect(batches).toEqual([]);
  });
});
