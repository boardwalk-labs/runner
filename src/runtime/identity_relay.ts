// Identity relay — the microVM bootstrap boundary.
//
// On Boardwalk's snapshot-based microVM substrate the worker starts BEFORE it has a run: the
// guest init (PID 1) spawns it warm (Node up, this code loaded, parked pre-identity), the
// platform snapshots the whole VM, and every run restores from that snapshot and INJECTS the
// run identity over an in-guest relay instead of container env. The relay is an inherited
// AF_UNIX socketpair; init tells us its fd via `BOARDWALK_IDENTITY_RELAY_FD`. Wire: one JSON
// object per LF-terminated line —
//
//	{"type":"worker_ready"}                    worker → init   the pre-identity park is reached
//	{"type":"identity","payload":{...}}        init → worker   the run identity (see schema below)
//	{"type":"identity_accepted"}               worker → init   captured; init acks its host
//
// The payload carries exactly the platform env contract (snake_case) plus the resolved user
// env; `applyIdentityToEnv` maps it onto `process.env` so `capturePlatformContext` runs
// UNCHANGED afterward — same fields, same capture-and-delete discipline, two transports.
// The stream stays open after identity: later platform phases speak suspend/wake over it.

import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { createLogger } from "./support/index.js";

const log = createLogger("identity_relay");

/** Env var naming the inherited relay fd. Set by the guest init; absent everywhere else
 *  (Fargate, self-hosted daemon), where the worker env-boots as always. */
export const RELAY_FD_ENV = "BOARDWALK_IDENTITY_RELAY_FD";

/** The identity payload — the env contract's fields, as JSON instead of env vars. */
export const relayIdentitySchema = z.object({
  run_id: z.string().min(1),
  control_plane_url: z.string().min(1),
  run_token: z.string().min(1),
  api_token: z.string().optional(),
  task_cpu_units: z.number().int().positive().optional(),
  /** The BYO inference provider registry, verbatim (stringified into BOARDWALK_BYO_PROVIDERS). */
  byo_providers: z.unknown().optional(),
  /** Resolved NON-secret user env. Platform keys always win over these (applied last). */
  env: z.record(z.string(), z.string()).optional(),
});
export type RelayIdentity = z.infer<typeof relayIdentitySchema>;

const relayMessageSchema = z.object({
  type: z.string(),
  payload: z.unknown().optional(),
});

/**
 * Read the relay fd from `env`, deleting the key (bootstrap-only plumbing; run code has no
 * business seeing it). Returns null when unset — the normal env-boot path.
 */
export function relayFdFromEnv(env: NodeJS.ProcessEnv): number | null {
  const raw = env[RELAY_FD_ENV];
  Reflect.deleteProperty(env, RELAY_FD_ENV);
  if (raw === undefined || raw.trim().length === 0) return null;
  const fd = Number(raw);
  if (!Number.isInteger(fd) || fd < 3) {
    throw new Error(`${RELAY_FD_ENV} must name an inherited fd (>= 3), got ${raw}`);
  }
  return fd;
}

/**
 * Map a relayed identity onto `env` for `capturePlatformContext`. User env lands FIRST and
 * the platform keys LAST, so nothing user-supplied can shadow a platform value.
 */
export function applyIdentityToEnv(identity: RelayIdentity, env: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(identity.env ?? {})) {
    env[key] = value;
  }
  env.RUN_ID = identity.run_id;
  env.BOARDWALK_CONTROL_PLANE_URL = identity.control_plane_url;
  env.BOARDWALK_RUN_TOKEN = identity.run_token;
  if (identity.api_token !== undefined && identity.api_token.length > 0) {
    env.BOARDWALK_API_KEY = identity.api_token;
  }
  if (identity.task_cpu_units !== undefined) {
    env.BOARDWALK_TASK_CPU_UNITS = String(identity.task_cpu_units);
  }
  if (identity.byo_providers !== undefined) {
    env.BOARDWALK_BYO_PROVIDERS = JSON.stringify(identity.byo_providers);
  }
}

/** One end of the init↔worker relay. Wraps any Duplex so tests run over in-memory streams. */
export class IdentityRelay {
  private buffer = "";
  private closed = false;
  private wake: (() => void) | null = null;

  constructor(private readonly stream: Duplex) {
    // One persistent listener for the relay's lifetime: a flowing stream DROPS chunks
    // emitted while nobody listens, so attach-per-read would lose lines between reads.
    stream.on("data", (chunk: Buffer | string) => {
      this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.wake?.();
    });
    const onClose = (): void => {
      this.closed = true;
      this.wake?.();
    };
    stream.on("end", onClose);
    stream.on("error", onClose);
  }

  /** Announce the pre-identity park. Init forwards this as the base-snapshot gate. */
  announceReady(): void {
    this.writeLine({ type: "worker_ready" });
  }

  /**
   * Block until init relays the run identity. THIS is the point the base snapshot freezes:
   * everything before it is generic warm-up shared by every run; everything after belongs
   * to one run. Unknown message types are ignored (forward-compatible), malformed lines are
   * logged and skipped (init is trusted; a torn line must not kill PID 1's only worker), but
   * a malformed IDENTITY payload is a hard error — same as a missing env var today.
   */
  async awaitIdentity(): Promise<RelayIdentity> {
    for (;;) {
      const line = await this.readLine();
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        log.warn("relay_malformed_line_skipped", { length: line.length });
        continue;
      }
      const message = relayMessageSchema.safeParse(parsed);
      if (!message.success) {
        log.warn("relay_malformed_message_skipped", {});
        continue;
      }
      if (message.data.type !== "identity") {
        log.warn("relay_unexpected_type_ignored", { type: message.data.type });
        continue;
      }
      const identity = relayIdentitySchema.safeParse(message.data.payload);
      if (!identity.success) {
        throw new Error(`Relayed identity payload is invalid: ${identity.error.message}`);
      }
      return identity.data;
    }
  }

  /** Confirm capture. Init acks its host only after this arrives. */
  acceptIdentity(): void {
    this.writeLine({ type: "identity_accepted" });
  }

  private writeLine(message: { type: string }): void {
    this.stream.write(JSON.stringify(message) + "\n");
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        return line;
      }
      if (this.closed) {
        throw new Error("identity relay closed before the run identity arrived");
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }
}

/**
 * Open the relay over the inherited fd. Wrapping the fd in a net.Socket also marks it
 * close-on-exec (libuv does this on adoption), so subprocesses the run later spawns cannot
 * inherit the relay and speak to init.
 */
export function connectIdentityRelayFd(fd: number): IdentityRelay {
  return new IdentityRelay(new Socket({ fd, readable: true, writable: true }));
}
