// SPDX-License-Identifier: Apache-2.0

// WorkflowHostServer — the runner's reference server for the program↔host protocol (the
// workflow-format redesign, P0). JSON-RPC 2.0 over a local stream socket (a Unix domain socket,
// or a named pipe on win32), framed as newline-delimited JSON. **Runner = server, SDK = client**;
// the wire contract is the published SDK's `protocol.ts` (`clientToHostRequests`,
// `hostToClientRequests`, notifications) — params are validated with those exact schemas, so the
// server can never drift from what the client speaks.
//
// The protocol is FULL-DUPLEX:
//   - client → host requests: `bootstrap` / `report_return` (loader-only) + one method per
//     author capability, each dispatched onto the injected {@link HostCapabilities} seam.
//   - host → client requests: `tool_invoke` — how an inline `agent()` tool declared in the
//     program runs. The leaf loop stays host-side; the wire carries DECLARATIONS only, and this
//     server turns each declaration into an engine `ToolDef` whose `execute()` round-trips the
//     call to the program. A handler error (a JSON-RPC error response) becomes an ordinary
//     thrown `Error` from `execute()`, which the engine feeds to the model as a tool-error
//     result — NEVER run-fatal. Invocations multiplex by their own ids and dispatch
//     concurrently; a late response to an abandoned invocation is discarded by id.
//   - host → client notification: `cancel` — sent when the run's abort signal fires; the SDK
//     aborts `context.signal`.
//
// Errors cross as `{code, message, data?}` with a STRING `code` from the engine taxonomy (the
// protocol's one deliberate deviation from base JSON-RPC): a thrown value's own SCREAMING_SNAKE
// `code` when it has one (AppError / EngineError / Node syscall codes all do), the error's class
// name otherwise, and a `RunAbortedError` maps to the run-fatal `CANCELLED` so `parallel()`
// re-throws it.
//
// `report_return` validates the program's return against the stored `output_schema` (Ajv,
// structural — `validateFormats` off, matching the revive pass's honesty about formats); a
// mismatch is a VALIDATION_FAILED error the loader turns into the run's curated failure.

import * as net from "node:net";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { Ajv, type ValidateFunction } from "ajv";
import {
  clientToHostRequests,
  clientToHostNotifications,
  rpcFrameSchema,
  type AgentWireOptions,
  type ContextData,
  type HostMethod,
  type HostMethodParams,
  type HostMethodResult,
  type JsonValue,
  type RpcId,
  type ShellResult,
  type UsageSnapshot,
  type AgentOptions,
  type ArtifactBody,
  type ArtifactRef,
  type BrowserSession,
  type BrowserSessionOptions,
  type CallOptions,
  type HumanInputOptions,
  type HumanInputResult,
  type PhaseOptions,
  type ScheduleOptions,
  type SleepArg,
  type ToolDef,
} from "@boardwalk-labs/workflow/runtime";
import type { ShellOptions } from "@boardwalk-labs/workflow";
import { AppError, ErrorCode, createLogger } from "./support/index.js";
import { RunAbortedError } from "./run_abort.js";

const log = createLogger("HostServer");

/** What `workflows.call` resolves at the capability seam: the child's output plus the CALLEE's
 *  declared output schema (`null` for an untyped callee — the client passes the JSON through). */
export interface CapabilityCallResult {
  output: unknown;
  outputSchema: Record<string, unknown> | null;
}

/**
 * The typed seam the protocol server dispatches onto — the runner's existing machinery, one
 * member per capability. Mirrors the SDK client's `HostInterface` so the two ends of the wire
 * stay symmetric. `agent` receives NATIVE `AgentOptions`: the server has already turned wire
 * tool declarations into executable `ToolDef`s (round-tripping `tool_invoke`) and resolved a
 * wire `sessionId` to its live {@link BrowserSession}.
 */
export interface HostCapabilities {
  agent(prompt: string, opts: AgentOptions | undefined): Promise<unknown>;
  callWorkflow(
    slug: string,
    input: unknown,
    opts: CallOptions | undefined,
  ): Promise<CapabilityCallResult>;
  runWorkflow(slug: string, input: unknown, opts: CallOptions | undefined): Promise<string>;
  scheduleWorkflow(slug: string, input: unknown, opts: ScheduleOptions): Promise<string>;
  sleep(arg: SleepArg): Promise<void>;
  humanInput(opts: HumanInputOptions): Promise<HumanInputResult>;
  getSecret(name: string): Promise<string>;
  writeArtifact(
    name: string,
    contentType: string,
    body: ArtifactBody,
    metadata: Record<string, unknown> | undefined,
  ): Promise<ArtifactRef>;
  openBrowser(opts: BrowserSessionOptions | undefined): Promise<BrowserSession>;
  shell(cmd: string, opts: ShellOptions | undefined): Promise<ShellResult>;
  phase(name: string, opts: PhaseOptions | undefined): void;
  idToken(audience: string): Promise<string>;
  apiToken(): Promise<string>;
  usage(): Promise<UsageSnapshot>;
}

/** The `bootstrap` payload: the RAW JSON input + the stored input schema (`null` when untyped —
 *  the CLIENT applies the schema-guided revival pass) + the context DATA (never `signal`). */
export interface BootstrapData {
  input: JsonValue;
  inputSchema: Record<string, unknown> | null;
  context: ContextData;
}

export interface WorkflowHostServerDeps {
  capabilities: HostCapabilities;
  bootstrap: BootstrapData;
  /** The workflow's declared output schema; `null` ⇒ the return persists unvalidated. */
  outputSchema: Record<string, unknown> | null;
  /** The run's cooperative-cancellation signal: on abort, every connected client is sent the
   *  `cancel` notification (the SDK aborts `context.signal`). */
  signal?: AbortSignal | undefined;
  /** Directory the Unix socket file is created in. Default `os.tmpdir()` — deliberately short:
   *  `sun_path` caps a socket path at ~104 bytes on darwin. Ignored on win32 (named pipe). */
  sockDir?: string | undefined;
  /** Host-side ceiling on ONE `tool_invoke` round-trip. Default: none — parity with the engine,
   *  which awaits an inline tool's `execute()` without a timeout. When set, expiry throws an
   *  ordinary Error from `execute()` (a tool-error result to the model, never run-fatal) and the
   *  late response is discarded by id. */
  toolInvokeTimeoutMs?: number | undefined;
}

interface PendingInvoke {
  resolve: (value: { output: JsonValue }) => void;
  reject: (reason: Error) => void;
}

/** One connected protocol client (the program process; several may connect). */
class HostConnection {
  private buffer = "";
  /** Ids of OUR outbound (host → client) requests awaiting a response. */
  readonly pendingInvokes = new Map<number, PendingInvoke>();

  constructor(
    readonly socket: net.Socket,
    private readonly onFrame: (conn: HostConnection, frame: unknown) => void,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line !== "") this.onLine(line);
        newline = this.buffer.indexOf("\n");
      }
    });
  }

  private onLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      log.warn("host_server_non_json_line");
      return;
    }
    this.onFrame(this, value);
  }

  send(frame: unknown): void {
    if (this.socket.destroyed) return;
    this.socket.write(JSON.stringify(frame) + "\n");
  }
}

/**
 * The protocol server for ONE run. `listen()` binds the socket (the runner then exports the
 * path as `BOARDWALK_HOST_SOCK`); `close()` tears everything down. The validated return the
 * program reported is read via {@link reportedReturn} after the loader completes.
 */
export class WorkflowHostServer {
  private readonly server: net.Server;
  private readonly connections = new Set<HostConnection>();
  /** sessionId → live handle, backing `computer.browser.*` and `agent({ session })`. */
  private readonly browserSessions = new Map<string, BrowserSession>();
  private readonly validateOutput: ValidateFunction | null;
  private nextInvokeId = 1;
  private sockPath: string | null = null;
  private returned: { value: JsonValue } | null = null;
  private cancelled = false;
  private readonly onAbort = (): void => {
    this.notifyCancel();
  };

  constructor(private readonly deps: WorkflowHostServerDeps) {
    this.server = net.createServer((socket) => {
      const conn = new HostConnection(socket, (c, frame) => {
        this.onFrame(c, frame);
      });
      this.connections.add(conn);
      socket.on("close", () => {
        this.connections.delete(conn);
        const closed = new Error("the program connection closed before the tool responded");
        for (const pending of conn.pendingInvokes.values()) pending.reject(closed);
        conn.pendingInvokes.clear();
      });
      socket.on("error", () => {
        socket.destroy();
      });
      // A client connecting after the cancel still learns of it (the notification is a level,
      // not an edge, from the program's point of view).
      if (this.cancelled) conn.send(cancelFrame());
    });
    this.validateOutput = compileOutputValidator(deps.outputSchema);
    if (deps.signal !== undefined) {
      if (deps.signal.aborted) this.cancelled = true;
      else deps.signal.addEventListener("abort", this.onAbort, { once: true });
    }
  }

  /** Bind the socket and resolve its path (a Unix socket path; a named pipe on win32). */
  async listen(): Promise<string> {
    const suffix = randomBytes(6).toString("hex");
    const path =
      process.platform === "win32"
        ? `\\\\.\\pipe\\bw-host-${suffix}`
        : join(this.deps.sockDir ?? tmpdir(), `bw-host-${suffix}.sock`);
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(path, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.sockPath = path;
    return path;
  }

  /** The bound socket path; null before `listen()`. */
  get socketPath(): string | null {
    return this.sockPath;
  }

  /** The validated value the program's loader reported via `report_return`, or null when no
   *  return was reported (the program never finished, or returned void ⇒ the client sent null). */
  reportedReturn(): JsonValue | null {
    return this.returned?.value ?? null;
  }

  /** Whether `report_return` was received at all (distinguishes "returned null" from "never
   *  reported" for callers that care). */
  hasReturn(): boolean {
    return this.returned !== null;
  }

  /** Push the `cancel` notification to every connected client (idempotent). */
  notifyCancel(reason?: string): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const conn of this.connections) conn.send(cancelFrame(reason));
  }

  /** Tear the server down: reject in-flight tool invokes, destroy connections, unlink the socket. */
  async close(): Promise<void> {
    // Drain first: a fire-and-forget `phase` notification sent moments before a program throw is
    // in flight on the loopback socket — give the event loop a couple of full turns (each with a
    // poll phase) so already-sent frames dispatch before teardown. The fire-and-forget contract
    // loses frames never SENT, not frames already on the wire.
    for (let i = 0; i < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.deps.signal?.removeEventListener("abort", this.onAbort);
    for (const conn of this.connections) {
      const closed = new Error("the host server is shutting down");
      for (const pending of conn.pendingInvokes.values()) pending.reject(closed);
      conn.pendingInvokes.clear();
      conn.socket.destroy();
    }
    this.connections.clear();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
    if (this.sockPath !== null && process.platform !== "win32") {
      await rm(this.sockPath, { force: true }).catch(() => undefined);
    }
  }

  // -- frame routing ---------------------------------------------------------

  private onFrame(conn: HostConnection, raw: unknown): void {
    const parsed = rpcFrameSchema.safeParse(raw);
    if (!parsed.success) {
      // Malformed frame: answer with a null-id error when we can't even read an id (JSON-RPC 2.0).
      conn.send({
        jsonrpc: "2.0",
        id: null,
        error: { code: "PROTOCOL_ERROR", message: "malformed JSON-RPC frame" },
      });
      return;
    }
    const frame = parsed.data;
    if ("method" in frame) {
      if ("id" in frame) {
        // Deliberately not awaited: requests dispatch CONCURRENTLY (a parked humanInput must not
        // block a sibling agent call; parallel() multiplexes by JSON-RPC id).
        void this.handleRequest(conn, frame.id, frame.method, frame.params);
      } else {
        this.handleNotification(frame.method, frame.params);
      }
      return;
    }
    // A response frame — settle the matching outbound tool_invoke; unknown/late ids are discarded.
    if ("error" in frame) {
      if (frame.id !== null) {
        this.settleInvoke(conn, frame.id, (pending) => {
          pending.reject(new Error(frame.error.message));
        });
      }
      return;
    }
    this.settleInvoke(conn, frame.id, (pending) => {
      // The client's tool result is `{output}` per the wire contract; tolerate a malformed one
      // by surfacing it as a tool error rather than crashing the leaf.
      const result = frame.result as { output?: JsonValue } | null | undefined;
      if (result === null || result === undefined || !("output" in result)) {
        pending.reject(new Error("tool_invoke response carried no output"));
        return;
      }
      pending.resolve({ output: result.output ?? null });
    });
  }

  private settleInvoke(
    conn: HostConnection,
    id: RpcId,
    apply: (pending: PendingInvoke) => void,
  ): void {
    if (typeof id !== "number") return;
    const pending = conn.pendingInvokes.get(id);
    if (pending === undefined) return; // late response to an abandoned invocation — discarded
    conn.pendingInvokes.delete(id);
    apply(pending);
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== "phase") return; // unknown notifications are ignored (additive forward-compat)
    const parsed = clientToHostNotifications.phase.params.safeParse(params);
    if (!parsed.success) {
      log.warn("host_server_bad_phase_params", { error: parsed.error.message });
      return;
    }
    // Fire-and-forget contract: a phase failure is logged, never surfaced to the program.
    try {
      this.deps.capabilities.phase(
        parsed.data.name,
        pruneUndefined<PhaseOptions>(parsed.data.opts),
      );
    } catch (err) {
      log.warn("host_server_phase_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleRequest(
    conn: HostConnection,
    id: RpcId,
    method: string,
    params: unknown,
  ): Promise<void> {
    if (!isHostMethod(method)) {
      conn.send({
        jsonrpc: "2.0",
        id,
        error: { code: "METHOD_NOT_FOUND", message: `unknown method "${method}"` },
      });
      return;
    }
    const parsed = clientToHostRequests[method].params.safeParse(params);
    if (!parsed.success) {
      conn.send({
        jsonrpc: "2.0",
        id,
        error: {
          code: "INVALID_PARAMS",
          message: `malformed ${method} params: ${parsed.error.message}`,
        },
      });
      return;
    }
    try {
      // The schema that ran IS clientToHostRequests[method].params, so the per-case narrowing
      // inside dispatch is exact.
      const result = await this.dispatch(conn, id, method, parsed.data);
      conn.send({ jsonrpc: "2.0", id, result });
    } catch (err) {
      conn.send({ jsonrpc: "2.0", id, error: protocolErrorOf(err) });
    }
  }

  // -- method dispatch -------------------------------------------------------

  private async dispatch<M extends HostMethod>(
    conn: HostConnection,
    id: RpcId,
    method: M,
    params: HostMethodParams<M>,
  ): Promise<HostMethodResult<HostMethod>> {
    const caps = this.deps.capabilities;
    switch (method) {
      case "bootstrap": {
        const b = this.deps.bootstrap;
        return { input: b.input, input_schema: b.inputSchema, context: b.context };
      }
      case "report_return": {
        const { value } = params as HostMethodParams<"report_return">;
        this.assertReturnMatchesSchema(value);
        this.returned = { value };
        return {};
      }
      case "agent": {
        const p = params as HostMethodParams<"agent">;
        const opts = this.toAgentOptions(conn, id, p.opts);
        const output = await caps.agent(p.prompt, opts);
        return { output: asJsonValue(output) };
      }
      case "workflows.call": {
        const p = params as HostMethodParams<"workflows.call">;
        const result = await caps.callWorkflow(p.slug, p.input, pruneUndefined<CallOptions>(p.opts));
        return { output: asJsonValue(result.output), output_schema: result.outputSchema };
      }
      case "workflows.run": {
        const p = params as HostMethodParams<"workflows.run">;
        return { runId: await caps.runWorkflow(p.slug, p.input, pruneUndefined<CallOptions>(p.opts)) };
      }
      case "workflows.schedule": {
        const p = params as HostMethodParams<"workflows.schedule">;
        return {
          scheduleId: await caps.scheduleWorkflow(
            p.slug,
            p.input,
            pruneUndefined<ScheduleOptions>(p.opts),
          ),
        };
      }
      case "sleep": {
        const p = params as HostMethodParams<"sleep">;
        await caps.sleep(p.arg);
        return {};
      }
      case "humanInput": {
        const p = params as HostMethodParams<"humanInput">;
        // The wire schema mirrors HumanInputOptions field-for-field; pruning the zod
        // explicit-undefined optionals makes the shapes exact.
        return { result: await caps.humanInput(pruneUndefined<HumanInputOptions>(p.opts)) };
      }
      case "secrets.get": {
        const p = params as HostMethodParams<"secrets.get">;
        return { value: await caps.getSecret(p.name) };
      }
      case "artifacts.write": {
        const p = params as HostMethodParams<"artifacts.write">;
        const body: ArtifactBody =
          p.body.encoding === "utf8" ? p.body.data : new Uint8Array(Buffer.from(p.body.data, "base64"));
        const ref = await caps.writeArtifact(p.name, p.contentType, body, p.metadata);
        return { ref: { id: ref.id, name: ref.name, url: ref.url } };
      }
      case "computer.openBrowser": {
        const p = params as HostMethodParams<"computer.openBrowser">;
        const session = await caps.openBrowser(pruneUndefined<BrowserSessionOptions>(p.opts));
        this.browserSessions.set(session.id, session);
        return { sessionId: session.id };
      }
      case "computer.browser.navigate": {
        const p = params as HostMethodParams<"computer.browser.navigate">;
        await this.session(p.sessionId).navigate(p.url);
        return {};
      }
      case "computer.browser.url": {
        const p = params as HostMethodParams<"computer.browser.url">;
        return { url: await this.session(p.sessionId).url() };
      }
      case "computer.browser.title": {
        const p = params as HostMethodParams<"computer.browser.title">;
        return { title: await this.session(p.sessionId).title() };
      }
      case "computer.browser.screenshot": {
        const p = params as HostMethodParams<"computer.browser.screenshot">;
        const ref = await this.session(p.sessionId).screenshot(
          p.fullPage !== undefined ? { fullPage: p.fullPage } : undefined,
        );
        return { ref: { id: ref.id, name: ref.name, url: ref.url } };
      }
      case "computer.browser.console": {
        const p = params as HostMethodParams<"computer.browser.console">;
        return { entries: await this.session(p.sessionId).console() };
      }
      case "computer.browser.network": {
        const p = params as HostMethodParams<"computer.browser.network">;
        return { entries: await this.session(p.sessionId).network() };
      }
      case "computer.browser.eval": {
        const p = params as HostMethodParams<"computer.browser.eval">;
        const value = await this.session(p.sessionId).eval(p.expression);
        return { value: asJsonValue(value) };
      }
      case "computer.browser.close": {
        const p = params as HostMethodParams<"computer.browser.close">;
        const session = this.browserSessions.get(p.sessionId);
        this.browserSessions.delete(p.sessionId);
        if (session !== undefined) await session.close();
        return {};
      }
      case "shell": {
        const p = params as HostMethodParams<"shell">;
        return await caps.shell(p.cmd, pruneUndefined<ShellOptions>(p.opts));
      }
      case "auth.idToken": {
        const p = params as HostMethodParams<"auth.idToken">;
        return { token: await caps.idToken(p.audience) };
      }
      case "auth.apiToken":
        return { token: await caps.apiToken() };
      case "usage.get":
        return await caps.usage();
      default:
        return unreachable(method);
    }
  }

  /** A live browser session by id, or a clear VALIDATION error for a closed/foreign one. */
  private session(sessionId: string): BrowserSession {
    const session = this.browserSessions.get(sessionId);
    if (session === undefined) {
      throw Object.assign(new Error(`no open browser session "${sessionId}" in this run`), {
        code: "VALIDATION",
      });
    }
    return session;
  }

  /** Validate the program's return against the declared output schema (P3.4): a mismatch fails
   *  the run — the loader's `reportReturn` rejects and the failure is curated. `null` (a void
   *  return) skips validation per the contract. */
  private assertReturnMatchesSchema(value: JsonValue): void {
    if (this.validateOutput === null || value === null) return;
    if (this.validateOutput(value)) return;
    const detail = (this.validateOutput.errors ?? [])
      .map((e) => `${e.instancePath === "" ? "(root)" : e.instancePath} ${e.message ?? "invalid"}`)
      .join("; ");
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      `run() returned a value that does not match the workflow's declared output_schema: ${detail}`,
      { errors: this.validateOutput.errors ?? [] },
    );
  }

  // -- inline agent() tools (the tool_invoke callback lane) ------------------

  /** Wire tool declarations → engine `ToolDef`s whose `execute()` round-trips `tool_invoke` to
   *  the program, correlated by `call_id` = the originating agent request's own id (stringified).
   *  Also resolves a wire `sessionId` back to its live browser session. */
  private toAgentOptions(
    conn: HostConnection,
    agentRequestId: RpcId,
    wire: AgentWireOptions | undefined,
  ): AgentOptions | undefined {
    if (wire === undefined) return undefined;
    const { tools, sessionId, ...rest } = wire;
    const callId = String(agentRequestId);
    return {
      ...(pruneUndefined<Omit<AgentOptions, "tools" | "session">>(rest) ?? {}),
      ...(tools !== undefined && tools.length > 0
        ? {
            tools: tools.map(
              (t): ToolDef => ({
                name: t.name,
                description: t.description,
                inputSchema: t.input_schema,
                execute: async (input: unknown) =>
                  (await this.invokeTool(conn, callId, t.name, asJsonValue(input))).output,
              }),
            ),
          }
        : {}),
      ...(sessionId !== undefined ? { session: this.session(sessionId) } : {}),
    };
  }

  /** One host → client `tool_invoke` round-trip. Concurrent invocations multiplex by this
   *  request's own JSON-RPC id; the optional host-side timeout abandons the call (its late
   *  response is discarded by id) and throws an ordinary Error — a tool-error result to the
   *  model, never run-fatal. */
  private invokeTool(
    conn: HostConnection,
    callId: string,
    tool: string,
    input: JsonValue,
  ): Promise<{ output: JsonValue }> {
    const id = this.nextInvokeId++;
    const timeoutMs = this.deps.toolInvokeTimeoutMs;
    return new Promise<{ output: JsonValue }>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          conn.pendingInvokes.delete(id); // abandon: the late response will be discarded by id
          reject(new Error(`inline tool "${tool}" timed out after ${String(timeoutMs)}ms`));
        }, timeoutMs);
      }
      conn.pendingInvokes.set(id, {
        resolve: (value) => {
          if (timer !== null) clearTimeout(timer);
          resolve(value);
        },
        reject: (reason) => {
          if (timer !== null) clearTimeout(timer);
          reject(reason);
        },
      });
      conn.send({
        jsonrpc: "2.0",
        id,
        method: "tool_invoke",
        params: { call_id: callId, tool, input },
      });
    });
  }
}

// -- helpers -----------------------------------------------------------------

function cancelFrame(reason?: string): unknown {
  return {
    jsonrpc: "2.0",
    method: "cancel",
    params: reason !== undefined ? { reason } : {},
  };
}

function isHostMethod(method: string): method is HostMethod {
  return Object.prototype.hasOwnProperty.call(clientToHostRequests, method);
}

/**
 * Drop explicit-undefined optionals from a zod-parsed options object so it satisfies the SDK's
 * exact-optional native types. Zod types an `.optional()` field as `T | undefined`, which
 * `exactOptionalPropertyTypes` rejects; on the wire an absent optional is simply absent, so
 * pruning the (at most theoretical) explicit-undefined entries makes the cast exact.
 */
function pruneUndefined<T>(value: object): T;
function pruneUndefined<T>(value: object | undefined): T | undefined;
function pruneUndefined<T>(value: object | undefined): T | undefined {
  if (value === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return out as T;
}

/** Boundary cast: capability results originate as JSON (broker HTTP bodies, model text, parsed
 *  model JSON), so they are wire-safe by construction; the type system just can't see it. */
function asJsonValue(value: unknown): JsonValue {
  return (value ?? null) as JsonValue;
}

const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Map a thrown value to the wire's `{code, message, data?}` (string code, engine taxonomy).
 *  An engine-style `hint` (the one-line "what to do") rides `data.hint` so it SURVIVES the wire —
 *  the loader's failure curation reads it back into the run's `output.error.hint` (the
 *  hint-reaches-hosted-authors contract). */
export function protocolErrorOf(err: unknown): { code: string; message: string; data?: unknown } {
  if (err instanceof RunAbortedError) {
    // CANCELLED is the run-fatal code `isRunFatal`/`parallel()` branch on — a run-level abort
    // (user cancel / credit stop) must abort the whole program, never be isolated.
    return { code: "CANCELLED", message: err.message, data: { reason: err.reason } };
  }
  const message = err instanceof Error ? err.message : String(err);
  const rawCode: unknown =
    typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  const code =
    typeof rawCode === "string" && ERROR_CODE_RE.test(rawCode)
      ? rawCode
      : err instanceof Error && err.name !== ""
        ? err.name
        : "INTERNAL_ERROR";
  const rawHint: unknown =
    typeof err === "object" && err !== null ? (err as { hint?: unknown }).hint : undefined;
  const dataParts: Record<string, unknown> = {};
  if (err instanceof AppError && err.detail !== undefined) dataParts.detail = err.detail;
  if (typeof rawHint === "string" && rawHint !== "") dataParts.hint = rawHint;
  return { code, message, ...(Object.keys(dataParts).length > 0 ? { data: dataParts } : {}) };
}

/** Compile the output-schema validator: structural (formats off — same honesty as the revive
 *  pass), lax about unknown keywords (`contentEncoding` etc.). A schema that will not compile is
 *  a platform bug in the deriver — warned and skipped (fail-soft), never a run failure. */
function compileOutputValidator(
  schema: Record<string, unknown> | null,
): ValidateFunction | null {
  if (schema === null) return null;
  try {
    const ajv = new Ajv({ strict: false, validateFormats: false });
    return ajv.compile(schema);
  } catch (err) {
    log.warn("host_server_output_schema_uncompilable", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function unreachable(value: never): never {
  throw new Error(`unhandled host method: ${String(value)}`);
}
