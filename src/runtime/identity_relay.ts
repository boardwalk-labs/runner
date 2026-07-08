// Identity relay — the microVM bootstrap boundary.
//
// On Boardwalk's snapshot-based microVM substrate the worker starts BEFORE it has a run: the
// guest init (PID 1) spawns it warm (Node up, this code loaded, parked pre-identity), the
// platform snapshots the whole VM, and every run restores from that snapshot and INJECTS the
// run identity over an in-guest relay instead of container env. The relay is an inherited
// AF_UNIX socketpair; init tells us its fd via `BOARDWALK_IDENTITY_RELAY_FD`. Wire: one JSON
// object per LF-terminated line —
//
//	{"type":"worker_ready","payload":{...}}    worker → init   the pre-identity park is reached
//	                                                           (payload: optional version diagnostics,
//	                                                           forwarded verbatim by init)
//	{"type":"identity","payload":{...}}        init → worker   the run identity (see schema below)
//	{"type":"identity_accepted"}               worker → init   captured; init acks its host
//
// The payload carries exactly the platform env contract (snake_case) plus the resolved user
// env; `applyIdentityToEnv` maps it onto `process.env` so `capturePlatformContext` runs
// UNCHANGED afterward — same fields, same capture-and-delete discipline, two transports.
// The stream stays open after identity: later platform phases speak suspend/wake over it.

import { createRequire } from "node:module";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { createLogger } from "./support/index.js";

const log = createLogger("identity_relay");

/** Env var naming the inherited relay fd. Set by the guest init; absent everywhere else
 *  (Fargate, self-hosted daemon), where the worker env-boots as always. */
export const RELAY_FD_ENV = "BOARDWALK_IDENTITY_RELAY_FD";

/** Max bytes of one relay line — the wire protocol's 32 MiB frame cap, mirrored in-guest.
 *  An oversized line costs the connection (LF framing cannot resynchronize past it), which
 *  for this relay means a hard bootstrap failure. Measured in UTF-16 code units, which for
 *  this ASCII-JSON wire is the byte count; the cap is a guard, not exact accounting. */
export const MAX_RELAY_LINE_BYTES = 32 * 1024 * 1024;

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

/** The worker_ready diagnostics — supplied by the worker (init cannot know these),
 *  forwarded verbatim by the guest init. Best-effort, never load-bearing. */
export interface WorkerDiagnostics {
  worker_version?: string;
  node_version: string;
  sdk_version?: string;
}

/** Collect the worker_ready diagnostics. Version lookups are best-effort: the runner's own
 *  package.json sits two levels above this module in both the src and published dist
 *  layouts; the SDK's is reachable only if its exports expose ./package.json. */
export function workerDiagnostics(): WorkerDiagnostics {
  const require = createRequire(import.meta.url);
  const versionOf = (spec: string): string | undefined => {
    try {
      const pkg = require(spec) as { version?: string };
      return typeof pkg.version === "string" ? pkg.version : undefined;
    } catch {
      return undefined;
    }
  };
  const worker = versionOf("../../package.json");
  const sdk = versionOf("@boardwalk-labs/workflow/package.json");
  return {
    ...(worker !== undefined ? { worker_version: worker } : {}),
    node_version: process.version,
    ...(sdk !== undefined ? { sdk_version: sdk } : {}),
  };
}

/** One end of the init↔worker relay. Wraps any Duplex so tests run over in-memory streams. */
export class IdentityRelay {
  private buffer = "";
  private closed = false;
  private failure: Error | null = null;
  private wake: (() => void) | null = null;
  private readonly onData: (chunk: Buffer | string) => void;

  constructor(private readonly stream: Duplex) {
    // One persistent listener for the relay's lifetime: a flowing stream DROPS chunks
    // emitted while nobody listens, so attach-per-read would lose lines between reads.
    this.onData = (chunk: Buffer | string): void => {
      this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (this.buffer.length > MAX_RELAY_LINE_BYTES && !this.buffer.includes("\n")) {
        // The unterminated tail can never become a legal line — fail now instead of
        // buffering without bound (the wire cap, mirrored; init is trusted, so this is a
        // bug or corruption, not an attack to survive).
        this.fail(new Error(`identity relay line exceeds ${MAX_RELAY_LINE_BYTES} bytes`));
        return;
      }
      this.wake?.();
    };
    stream.on("data", this.onData);
    stream.on("end", () => {
      this.closed = true;
      this.wake?.();
    });
    stream.on("error", (err: Error) => {
      // Keep the error's detail — "closed" alone hides why the socket died.
      this.fail(err);
    });
  }

  private fail(err: Error): void {
    this.failure ??= err;
    this.closed = true;
    this.stream.destroy();
    this.wake?.();
  }

  /** Announce the pre-identity park (with the diagnostics payload when provided).
   *  Init forwards this as the base-snapshot gate. */
  announceReady(diagnostics?: WorkerDiagnostics): void {
    this.writeLine(
      diagnostics === undefined
        ? { type: "worker_ready" }
        : { type: "worker_ready", payload: diagnostics },
    );
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

  /**
   * Stop reading until the suspend/wake phase attaches its own consumer. Without this,
   * anything init sends post-identity would accumulate in the line buffer forever (nothing
   * reads it yet); parked, the socket backpressures into the kernel buffer instead. The
   * stream stays open — it IS the future suspend/wake channel.
   */
  park(): void {
    this.stream.off("data", this.onData);
    this.stream.pause();
  }

  private writeLine(message: { type: string; payload?: unknown }): void {
    this.stream.write(JSON.stringify(message) + "\n");
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length > MAX_RELAY_LINE_BYTES) {
          this.fail(new Error(`identity relay line exceeds ${MAX_RELAY_LINE_BYTES} bytes`));
        } else {
          return line;
        }
      }
      if (this.failure !== null) {
        throw this.failure;
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
