// BrokerChildDispatcher — the broker-backed `workflows.call` (docs/RUNNER_BROKER.md). The host's
// ChildDispatcher under the broker model: instead of touching the DB/SQS directly (the
// WorkerChildDispatcher path), it asks the Runner Control API to create the child (resolve + the
// `callable_by` gate + idempotent re-attach happen server-side) and then HOLDS the parent task,
// polling the child to terminal over the run token. Same hold-and-poll shape as WorkerChildDispatcher
// — only the data source changes (broker HTTP, not the repos).

import { AppError, ErrorCode, createLogger } from "./support/index.js";
import type { CallOptions } from "@boardwalk-labs/workflow/runtime";
import type { ChildDispatcher, ChildResult, ScheduleOptions } from "./workflow_host.js";
import type { BrokerScheduleSpec, RunnerControlClient } from "./runner_control_client.js";
import { throwIfAborted } from "./run_abort.js";

const log = createLogger("BrokerChildDispatcher");

const TERMINAL_CHILD_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);
const DEFAULT_POLL_INTERVAL_MS = 2_000;

export interface BrokerChildDispatcherDeps {
  client: RunnerControlClient;
  /** Wait between polls. Injected so tests don't sleep on real time. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
}

export class BrokerChildDispatcher implements ChildDispatcher {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;

  constructor(private readonly deps: BrokerChildDispatcherDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /** Create (or re-attach to) the child, then hold + poll to terminal and return its output. An
   *  abort (`signal`) stops the hold within one poll interval and throws RunAbortedError. */
  async call(
    slug: string,
    input: unknown,
    _opts: CallOptions | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    throwIfAborted(signal);
    const child = await this.deps.client.startChild(slug, input);
    if (TERMINAL_CHILD_STATUSES.has(child.status)) {
      return this.childOutput(slug, child.childRunId, child.status, child.output);
    }
    return this.pollToCompletion(slug, child.childRunId, signal);
  }

  /** Start (or idempotently re-attach to) the child and resolve its CURRENT state — no hold. The
   *  durable callWorkflow seam decides whether to suspend (non-terminal) or return (terminal). */
  async start(
    slug: string,
    input: unknown,
    _opts: CallOptions | undefined,
    signal?: AbortSignal,
  ): Promise<ChildResult> {
    throwIfAborted(signal);
    const child = await this.deps.client.startChild(slug, input);
    return { childRunId: child.childRunId, status: child.status, output: child.output };
  }

  /** Poll a child's current state by id (the resume path), or null when it isn't this run's child. */
  async poll(childRunId: string): Promise<ChildResult | null> {
    const child = await this.deps.client.getChild(childRunId);
    return child === null
      ? null
      : { childRunId: child.id, status: child.status, output: child.output };
  }

  /** Fire-and-forget: create (or re-attach to) the child and return its id without holding. */
  async run(slug: string, input: unknown, _opts: CallOptions | undefined): Promise<string> {
    const child = await this.deps.client.startChild(slug, input);
    return child.childRunId;
  }

  /** Provision a durable schedule via the broker; returns the new schedule's id. A `Date` `at` is
   *  normalized to an ISO string (the broker spec carries string | number, not Date). */
  async schedule(slug: string, input: unknown, opts: ScheduleOptions): Promise<string> {
    const spec: BrokerScheduleSpec = {};
    if (opts.cron !== undefined) spec.cron = opts.cron;
    if (opts.rate !== undefined) spec.rate = opts.rate;
    if (opts.at !== undefined) spec.at = opts.at instanceof Date ? opts.at.toISOString() : opts.at;
    if (opts.timezone !== undefined) spec.timezone = opts.timezone;
    if (opts.idempotencyKey !== undefined) spec.idempotencyKey = opts.idempotencyKey;
    return await this.deps.client.scheduleWorkflow(slug, input, spec);
  }

  private async pollToCompletion(
    slug: string,
    childRunId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    for (;;) {
      throwIfAborted(signal);
      const child = await this.deps.client.getChild(childRunId);
      if (child === null) {
        throw new AppError(
          ErrorCode.INTERNAL_ERROR,
          `Called workflow's child run ${childRunId} vanished`,
        );
      }
      if (TERMINAL_CHILD_STATUSES.has(child.status)) {
        return this.childOutput(slug, child.id, child.status, child.output);
      }
      await this.sleep(this.pollIntervalMs);
      // Re-check after the wait so an abort during the inter-poll sleep stops within one interval.
      throwIfAborted(signal);
    }
  }

  /** A completed child returns its output; a failed/cancelled child rejects the parent's await. */
  private childOutput(slug: string, childRunId: string, status: string, output: unknown): unknown {
    if (status === "completed") return output;
    log.warn("child_workflow_nonterminal_output", { slug, childRunId, status });
    throw new AppError(
      ErrorCode.INTERNAL_ERROR,
      `Called workflow "${slug}" ${status} (run ${childRunId})`,
      { childRunId, status },
    );
  }
}
