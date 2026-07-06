// BrokerEventPublisher — a `RedisPublisher` that ships the agent event-stream through the broker
// instead of publishing to Redis directly (docs/RUNNER_BROKER.md §4 — Telemetry).
//
// The run-event live channel is a per-event `redis.publish(run:<id>, frame)`. Under the broker the
// runner holds no Redis credential, so this stand-in BUFFERS frames and POSTs them in batches to the
// Runner Control API's `/telemetry` endpoint; the broker publishes each to the run's Redis channel
// server-side. Batching keeps it off the per-token-delta HTTP-call hot path (a turn can emit one
// frame per token); the SSE consumer orders by the frame's `cursor`, so out-of-order batch delivery
// is harmless.
//
// Best-effort, exactly like the direct Redis publish it replaces: a failed flush is logged, never
// thrown — a telemetry hiccup must not kill the agent turn (the durable store is the durability
// guarantee, once it lands). The worker calls `close()` in its cleanup to drain the final batch.

import { createLogger } from "./support/index.js";
import type { RedisPublisher } from "./agent/events.js";

const log = createLogger("BrokerEventPublisher");

const DEFAULT_MAX_BATCH = 16;
const DEFAULT_MAX_DELAY_MS = 200;

export interface BrokerEventPublisherOptions {
  /** Ship a batch of frames to the broker (RunnerControlClient.publishTelemetry). */
  send: (frames: string[]) => Promise<void>;
  /** Flush once this many frames are buffered (default 16). */
  maxBatch?: number;
  /** Flush a partial batch after this long since the first buffered frame (default 200ms). */
  maxDelayMs?: number;
}

export class BrokerEventPublisher implements RedisPublisher {
  private readonly send: (frames: string[]) => Promise<void>;
  private readonly maxBatch: number;
  private readonly maxDelayMs: number;
  private buffer: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: BrokerEventPublisherOptions) {
    this.send = opts.send;
    this.maxBatch = opts.maxBatch ?? DEFAULT_MAX_BATCH;
    this.maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  }

  /** RedisPublisher contract: buffer the frame; flush on size, else arm the delay timer. The
   *  `channel` is ignored — the broker derives it from the run token (the run's own channel). The
   *  return value (subscriber count) is unused by the run-event emitter, so we resolve 0. */
  publish(_channel: string, message: string): Promise<number> {
    this.buffer.push(message);
    if (this.buffer.length >= this.maxBatch) {
      void this.flush();
    } else if (this.timer === null) {
      this.timer = setTimeout(() => {
        void this.flush();
      }, this.maxDelayMs);
      this.timer.unref();
    }
    return Promise.resolve(0);
  }

  /** Ship whatever is buffered now (and cancel any pending timer). Errors are logged, not thrown. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.send(batch);
    } catch (err) {
      log.warn("telemetry_flush_failed", {
        frames: batch.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Drain the final batch at run end (the worker calls this in cleanup). */
  async close(): Promise<void> {
    await this.flush();
  }
}
