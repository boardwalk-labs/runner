// WorkflowHostServer tests — the protocol server driven by the REAL published SDK client
// (`HostClient` from @boardwalk-labs/workflow/runtime) over a real Unix socket, so every
// assertion exercises the actual wire contract both ends ship. Raw-socket tests cover the
// frames a well-behaved client never sends (unknown methods, malformed frames).

import { describe, it, expect, afterEach } from "vitest";
import * as net from "node:net";
import {
  HostClient,
  HostError,
  type BrowserSession,
  type ContextData,
} from "@boardwalk-labs/workflow/runtime";
import { AppError, ErrorCode } from "./support/index.js";
import { RunAbortedError } from "./run_abort.js";
import {
  WorkflowHostServer,
  protocolErrorOf,
  type HostCapabilities,
  type WorkflowHostServerDeps,
} from "./host_server.js";

const TEST_CONTEXT: ContextData = {
  runId: "01TESTRUN00000000000000000",
  workflowId: "01TESTWORKFLOW000000000000",
  workflowVersion: 3,
  orgId: "01TESTORG00000000000000000",
  environment: { id: "01TESTENV00000000000000000", name: "production" },
  actor: { type: "cron", rule: "sched_1" },
  attempt: 2,
  trigger: { kind: "cron", firedAt: 1_700_000_000_000, source: "sched_1" },
  workspaceDir: "/workspace",
};

function notStubbed(what: string): never {
  throw new Error(`${what} is not stubbed in this test`);
}

interface CapsRecorder {
  capabilities: HostCapabilities;
  calls: unknown[][];
}

function makeCaps(overrides: Partial<HostCapabilities> = {}): CapsRecorder {
  const calls: unknown[][] = [];
  const record =
    <A extends unknown[], R>(name: string, fallback: (...args: A) => R) =>
    (...args: A): R => {
      calls.push([name, ...args]);
      return fallback(...args);
    };
  const capabilities: HostCapabilities = {
    agent: overrides.agent ?? record("agent", (prompt: string) => Promise.resolve(`leaf:${prompt}`)),
    callWorkflow:
      overrides.callWorkflow ??
      record("callWorkflow", () => Promise.resolve({ output: { ok: true }, outputSchema: null })),
    runWorkflow: overrides.runWorkflow ?? record("runWorkflow", () => Promise.resolve("run_2")),
    scheduleWorkflow:
      overrides.scheduleWorkflow ?? record("scheduleWorkflow", () => Promise.resolve("sched_2")),
    sleep: overrides.sleep ?? record("sleep", () => Promise.resolve()),
    humanInput:
      overrides.humanInput ??
      record("humanInput", () => Promise.resolve({ value: "approve", isOther: false })),
    getSecret: overrides.getSecret ?? record("getSecret", (name: string) => Promise.resolve(`sek:${name}`)),
    writeArtifact:
      overrides.writeArtifact ??
      record("writeArtifact", (name: string) =>
        Promise.resolve({ id: "art_1", name, url: "https://cdn/a" }),
      ),
    openBrowser: overrides.openBrowser ?? (() => notStubbed("openBrowser")),
    shell:
      overrides.shell ??
      record("shell", (cmd: string) => Promise.resolve({ exitCode: 0, stdout: `ran:${cmd}`, stderr: "" })),
    phase: overrides.phase ?? record("phase", () => undefined),
    idToken: overrides.idToken ?? record("idToken", (aud: string) => Promise.resolve(`jwt:${aud}`)),
    apiToken: overrides.apiToken ?? record("apiToken", () => Promise.resolve("api-token")),
    usage:
      overrides.usage ??
      record("usage", () =>
        Promise.resolve({
          usd: { spent: 1, cap: 5, remaining: 4 },
          tokens: { spent: 10, cap: null, remaining: null },
          compute_seconds: { spent: 2, cap: 100, remaining: 98 },
        }),
      ),
  };
  return { capabilities, calls };
}

const servers: WorkflowHostServer[] = [];
const clients: HostClient[] = [];
const rawSockets: net.Socket[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of rawSockets.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function startServer(
  overrides: Partial<HostCapabilities> = {},
  deps: Partial<Omit<WorkflowHostServerDeps, "capabilities">> = {},
): Promise<{ server: WorkflowHostServer; sockPath: string; caps: CapsRecorder }> {
  const caps = makeCaps(overrides);
  const server = new WorkflowHostServer({
    capabilities: caps.capabilities,
    bootstrap: deps.bootstrap ?? { input: { n: 1 }, inputSchema: null, context: TEST_CONTEXT },
    outputSchema: deps.outputSchema ?? null,
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    ...(deps.toolInvokeTimeoutMs !== undefined
      ? { toolInvokeTimeoutMs: deps.toolInvokeTimeoutMs }
      : {}),
  });
  servers.push(server);
  const sockPath = await server.listen();
  return { server, sockPath, caps };
}

async function connect(sockPath: string): Promise<HostClient> {
  const client = await HostClient.connect(sockPath);
  clients.push(client);
  return client;
}

describe("WorkflowHostServer — loader methods", () => {
  it("serves bootstrap: raw input + schema + context (the client revives + freezes)", async () => {
    const { sockPath } = await startServer(
      {},
      {
        bootstrap: {
          input: { when: "2026-01-02T03:04:05.000Z" },
          inputSchema: {
            type: "object",
            properties: { when: { type: "string", format: "date-time" } },
          },
          context: TEST_CONTEXT,
        },
      },
    );
    const client = await connect(sockPath);
    const { input, context } = await client.bootstrap();
    expect((input as { when: unknown }).when).toBeInstanceOf(Date);
    expect(context.runId).toBe(TEST_CONTEXT.runId);
    expect(context.environment).toEqual({ id: "01TESTENV00000000000000000", name: "production" });
    expect(context.attempt).toBe(2);
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("accepts report_return with no output schema and exposes the value", async () => {
    const { server, sockPath } = await startServer();
    const client = await connect(sockPath);
    await client.reportReturn({ anything: ["goes", 1] });
    expect(server.hasReturn()).toBe(true);
    expect(server.reportedReturn()).toEqual({ anything: ["goes", 1] });
  });

  it("validates report_return against output_schema and rejects a mismatch", async () => {
    const { server, sockPath } = await startServer(
      {},
      {
        outputSchema: { type: "object", required: ["n"], properties: { n: { type: "number" } } },
      },
    );
    const client = await connect(sockPath);
    await expect(client.reportReturn({ n: "nope" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(server.hasReturn()).toBe(false);
    // A matching value then succeeds (the failed attempt stored nothing).
    await client.reportReturn({ n: 7 });
    expect(server.reportedReturn()).toEqual({ n: 7 });
  });

  it("skips validation for a null (void) return", async () => {
    const { server, sockPath } = await startServer(
      {},
      {
        outputSchema: { type: "object", required: ["n"] },
      },
    );
    const client = await connect(sockPath);
    await client.reportReturn(undefined); // void ⇒ the client sends null
    expect(server.hasReturn()).toBe(true);
    expect(server.reportedReturn()).toBeNull();
  });

  it("skips validation (with a warning) when the schema will not compile", async () => {
    const { server, sockPath } = await startServer(
      {},
      {
        // `type: 42` is not a valid schema — Ajv refuses to compile it.
        outputSchema: { type: 42 } as unknown as Record<string, unknown>,
      },
    );
    const client = await connect(sockPath);
    await client.reportReturn({ n: 1 });
    expect(server.reportedReturn()).toEqual({ n: 1 });
  });
});

describe("WorkflowHostServer — capability dispatch", () => {
  it("round-trips secrets.get / auth / usage.get / shell", async () => {
    const { sockPath } = await startServer();
    const client = await connect(sockPath);
    expect(await client.getSecret("GH_TOKEN")).toBe("sek:GH_TOKEN");
    expect(await client.idToken("sts.amazonaws.com")).toBe("jwt:sts.amazonaws.com");
    expect(await client.apiToken()).toBe("api-token");
    expect((await client.usage()).usd).toEqual({ spent: 1, cap: 5, remaining: 4 });
    expect(await client.shell("echo hi", { cwd: "sub" })).toEqual({
      exitCode: 0,
      stdout: "ran:echo hi",
      stderr: "",
    });
  });

  it("maps sleep args through the wire (number, durationMs, until-Date → ISO)", async () => {
    const seen: unknown[] = [];
    const { sockPath } = await startServer({
      sleep: (arg) => {
        seen.push(arg);
        return Promise.resolve();
      },
    });
    const client = await connect(sockPath);
    await client.sleep(5000);
    await client.sleep({ durationMs: 100 });
    await client.sleep({ until: new Date("2026-05-06T00:00:00.000Z") });
    expect(seen).toEqual([5000, { durationMs: 100 }, { until: "2026-05-06T00:00:00.000Z" }]);
  });

  it("decodes artifact bodies: utf8 stays a string, base64 becomes bytes", async () => {
    const bodies: unknown[] = [];
    const { sockPath } = await startServer({
      writeArtifact: (name, _ct, body) => {
        bodies.push(body);
        return Promise.resolve({ id: "a", name, url: "https://cdn/a" });
      },
    });
    const client = await connect(sockPath);
    await client.writeArtifact("t.txt", "text/plain", "hello", undefined);
    await client.writeArtifact("b.bin", "application/octet-stream", new Uint8Array([1, 2, 3]), {
      k: "v",
    });
    expect(bodies[0]).toBe("hello");
    expect(bodies[1]).toBeInstanceOf(Uint8Array);
    expect([...(bodies[1] as Uint8Array)]).toEqual([1, 2, 3]);
  });

  it("returns workflows.call output WITH the callee's output_schema (client revives)", async () => {
    const { sockPath } = await startServer({
      callWorkflow: () =>
        Promise.resolve({
          output: { at: "2026-01-01T00:00:00.000Z" },
          outputSchema: {
            type: "object",
            properties: { at: { type: "string", format: "date-time" } },
          },
        }),
    });
    const client = await connect(sockPath);
    const { output, outputSchema } = await client.callWorkflow("child", { x: 1 }, undefined);
    expect(outputSchema).not.toBeNull();
    expect((output as { at: unknown }).at).toBe("2026-01-01T00:00:00.000Z"); // raw at the seam
  });

  it("serves workflows.run and workflows.schedule (Date normalized client-side)", async () => {
    const scheduled: unknown[] = [];
    const { sockPath } = await startServer({
      scheduleWorkflow: (slug, input, opts) => {
        scheduled.push([slug, input, opts]);
        return Promise.resolve("sched_9");
      },
    });
    const client = await connect(sockPath);
    expect(await client.runWorkflow("child", { a: 1 }, undefined)).toBe("run_2");
    expect(
      await client.scheduleWorkflow("child", {}, { at: new Date("2026-07-01T00:00:00.000Z") }),
    ).toBe("sched_9");
    expect(scheduled).toEqual([["child", {}, { at: "2026-07-01T00:00:00.000Z" }]]);
  });

  it("round-trips humanInput", async () => {
    const { sockPath } = await startServer();
    const client = await connect(sockPath);
    const result = await client.humanInput({
      prompt: "approve?",
      input: { kind: "choice", options: ["yes", "no"] },
    });
    expect(result).toEqual({ value: "approve", isOther: false });
  });

  it("dispatches requests CONCURRENTLY (a blocked sleep does not serialize a secret read)", async () => {
    let releaseSleep: (() => void) | null = null;
    const { sockPath } = await startServer({
      sleep: () =>
        new Promise<void>((resolve) => {
          releaseSleep = resolve;
        }),
    });
    const client = await connect(sockPath);
    const sleeping = client.sleep(60_000);
    // The sleep is parked host-side; a sibling request must still be served.
    expect(await client.getSecret("X")).toBe("sek:X");
    expect(releaseSleep).not.toBeNull();
    (releaseSleep as unknown as () => void)();
    await sleeping;
  });

  it("delivers the phase notification (fire-and-forget) to the capability seam", async () => {
    const phases: unknown[] = [];
    const { sockPath } = await startServer({
      phase: (name, opts) => {
        phases.push([name, opts]);
      },
    });
    const client = await connect(sockPath);
    client.phase("Build", { id: "b1" });
    client.phase("Test", undefined);
    // Fire-and-forget: give the loopback a turn to deliver.
    await client.getSecret("fence"); // a later request on the same socket fences ordering
    expect(phases).toEqual([
      ["Build", { id: "b1" }],
      ["Test", undefined],
    ]);
  });

  it("swallows (logs) a phase capability throw — fire-and-forget never surfaces", async () => {
    const { sockPath } = await startServer({
      phase: () => {
        throw new Error("phase exploded");
      },
    });
    const client = await connect(sockPath);
    client.phase("Boom", undefined);
    expect(await client.getSecret("still-works")).toBe("sek:still-works");
  });
});

describe("WorkflowHostServer — error mapping", () => {
  it("carries a thrown AppError's code + detail across the wire", async () => {
    const { sockPath } = await startServer({
      getSecret: () =>
        Promise.reject(
          new AppError(ErrorCode.BUDGET_EXCEEDED, "cap blown", { kind: "usd", cap: 5 }),
        ),
    });
    const client = await connect(sockPath);
    const err = await client.getSecret("X").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostError);
    expect((err as HostError).code).toBe("BUDGET_EXCEEDED");
    expect((err as HostError).message).toBe("cap blown");
    expect((err as HostError).data).toEqual({ detail: { kind: "usd", cap: 5 } });
  });

  it("maps a RunAbortedError to the run-fatal CANCELLED code", async () => {
    const { sockPath } = await startServer({
      agent: () => Promise.reject(new RunAbortedError("credit_exhausted")),
    });
    const client = await connect(sockPath);
    const err = await client.agent("x", undefined).catch((e: unknown) => e);
    expect((err as HostError).code).toBe("CANCELLED");
    expect((err as HostError).data).toEqual({ reason: "credit_exhausted" });
  });

  it("carries an engine-style hint on data.hint (the hint-reaches-authors contract)", async () => {
    const { sockPath } = await startServer({
      agent: () =>
        Promise.reject(
          Object.assign(new Error("bad tools"), { code: "VALIDATION", hint: "write builtins" }),
        ),
    });
    const client = await connect(sockPath);
    const err = await client.agent("x", undefined).catch((e: unknown) => e);
    expect((err as HostError).code).toBe("VALIDATION");
    expect((err as HostError).data).toEqual({ hint: "write builtins" });
  });

  it("falls back to the error class name when there is no code-shaped code", async () => {
    const { sockPath } = await startServer({
      getSecret: () => Promise.reject(new TypeError("nope")),
    });
    const client = await connect(sockPath);
    const err = await client.getSecret("X").catch((e: unknown) => e);
    expect((err as HostError).code).toBe("TypeError");
  });

  it("protocolErrorOf maps a non-Error throw to INTERNAL_ERROR", () => {
    expect(protocolErrorOf("boom")).toEqual({ code: "INTERNAL_ERROR", message: "boom" });
  });
});

describe("WorkflowHostServer — protocol hygiene (raw socket)", () => {
  function rawConnect(sockPath: string): Promise<{
    socket: net.Socket;
    responses: unknown[];
    waitFor: (count: number) => Promise<void>;
  }> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ path: sockPath });
      rawSockets.push(socket);
      const responses: unknown[] = [];
      let buffer = "";
      const waiters: { count: number; resolve: () => void }[] = [];
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.trim() !== "") responses.push(JSON.parse(line));
          nl = buffer.indexOf("\n");
        }
        for (const w of [...waiters]) {
          if (responses.length >= w.count) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve();
          }
        }
      });
      socket.once("error", reject);
      socket.once("connect", () => {
        resolve({
          socket,
          responses,
          waitFor: (count) =>
            new Promise<void>((res) => {
              if (responses.length >= count) res();
              else waiters.push({ count, resolve: res });
            }),
        });
      });
    });
  }

  it("answers an unknown method with METHOD_NOT_FOUND", async () => {
    const { sockPath } = await startServer();
    const raw = await rawConnect(sockPath);
    raw.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "no.such" })}\n`);
    await raw.waitFor(1);
    expect(raw.responses[0]).toMatchObject({ id: 1, error: { code: "METHOD_NOT_FOUND" } });
  });

  it("answers malformed params with INVALID_PARAMS", async () => {
    const { sockPath } = await startServer();
    const raw = await rawConnect(sockPath);
    raw.socket.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "secrets.get", params: { nope: 1 } })}\n`,
    );
    await raw.waitFor(1);
    expect(raw.responses[0]).toMatchObject({ id: 2, error: { code: "INVALID_PARAMS" } });
  });

  it("answers an unreadable frame with a null-id PROTOCOL_ERROR", async () => {
    const { sockPath } = await startServer();
    const raw = await rawConnect(sockPath);
    raw.socket.write(`${JSON.stringify({ hello: "not-jsonrpc" })}\n`);
    await raw.waitFor(1);
    expect(raw.responses[0]).toMatchObject({ id: null, error: { code: "PROTOCOL_ERROR" } });
  });

  it("ignores a response frame for an unknown id (the late-response rule)", async () => {
    const { sockPath } = await startServer();
    const raw = await rawConnect(sockPath);
    raw.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 99, result: { output: 1 } })}\n`);
    // Still fully functional afterwards.
    raw.socket.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "secrets.get", params: { name: "X" } })}\n`,
    );
    await raw.waitFor(1);
    expect(raw.responses[0]).toMatchObject({ id: 3, result: { value: "sek:X" } });
  });
});

describe("WorkflowHostServer — tool_invoke (the callback lane)", () => {
  it("invokes inline tools through the client, concurrently, keyed to the agent call", async () => {
    const { sockPath } = await startServer({
      agent: async (_prompt, opts) => {
        const tool = opts?.tools?.[0];
        if (tool === undefined) return "no-tools";
        const [a, b] = await Promise.all([tool.execute({ n: 1 }), tool.execute({ n: 2 })]);
        return { a, b };
      },
    });
    const client = await connect(sockPath);
    const result = await client.agent("go", {
      tools: [
        {
          name: "double",
          description: "doubles",
          inputSchema: { type: "object" },
          execute: (input: unknown) => Promise.resolve((input as { n: number }).n * 2),
        },
      ],
    });
    expect(result).toEqual({ a: 2, b: 4 });
  });

  it("surfaces a handler throw as an ordinary execute() rejection (tool-error, not fatal)", async () => {
    const { sockPath } = await startServer({
      agent: async (_prompt, opts) => {
        const tool = opts?.tools?.[0];
        if (tool === undefined) return "no-tools";
        try {
          await tool.execute({});
          return "unexpected";
        } catch (err) {
          return `caught:${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });
    const client = await connect(sockPath);
    const result = await client.agent("go", {
      tools: [
        {
          name: "boom",
          description: "throws",
          inputSchema: { type: "object" },
          execute: () => Promise.reject(new Error("handler down")),
        },
      ],
    });
    expect(result).toBe("caught:handler down");
  });

  it("times out an unresponsive handler host-side and discards the late response", async () => {
    const { sockPath } = await startServer(
      {
        agent: async (_prompt, opts) => {
          const tool = opts?.tools?.[0];
          if (tool === undefined) return "no-tools";
          try {
            await tool.execute({});
            return "unexpected";
          } catch (err) {
            return `caught:${err instanceof Error ? err.message : String(err)}`;
          }
        },
      },
      { toolInvokeTimeoutMs: 30 },
    );
    const client = await connect(sockPath);
    const result = await client.agent("go", {
      tools: [
        {
          name: "slow",
          description: "never answers in time",
          inputSchema: { type: "object" },
          execute: () => new Promise((resolve) => setTimeout(() => resolve("late"), 120)),
        },
      ],
    });
    expect(result).toBe('caught:inline tool "slow" timed out after 30ms');
    // The late response (after 120ms) must be discarded by id, not crash anything: the
    // connection stays healthy for later calls.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await client.getSecret("after")).toBe("sek:after");
  });
});

describe("WorkflowHostServer — cancel", () => {
  it("pushes cancel to the client when the run signal aborts (context.signal fires)", async () => {
    const controller = new AbortController();
    const { sockPath } = await startServer({}, { signal: controller.signal });
    const client = await connect(sockPath);
    expect(client.signal.aborted).toBe(false);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.signal.aborted).toBe(true);
  });

  it("tells a late-connecting client about an already-cancelled run", async () => {
    const controller = new AbortController();
    const { sockPath } = await startServer({}, { signal: controller.signal });
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const client = await connect(sockPath);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.signal.aborted).toBe(true);
  });
});

describe("WorkflowHostServer — browser sessions", () => {
  function fakeSession(id: string): { session: BrowserSession; log: string[] } {
    const log: string[] = [];
    const session: BrowserSession = {
      id,
      navigate: (url: string) => {
        log.push(`nav:${url}`);
        return Promise.resolve();
      },
      url: () => Promise.resolve("https://x.test/page"),
      title: () => Promise.resolve("X page"),
      screenshot: () => Promise.resolve({ id: "art_shot", name: "shot.png", url: "https://cdn/s" }),
      console: () => Promise.resolve([{ level: "log" as const, text: "hi", timestamp: 1 }]),
      network: () =>
        Promise.resolve([{ method: "GET", url: "https://x.test/api", timestamp: 2, status: 200 }]),
      eval: <T = unknown>(expression: string) => Promise.resolve(`evaled:${expression}` as T),
      close: () => {
        log.push("close");
        return Promise.resolve();
      },
    };
    return { session, log };
  }

  it("opens a session and serves the computer.browser.* sub-ops keyed by sessionId", async () => {
    const fake = fakeSession("sess_1");
    const { sockPath } = await startServer({
      openBrowser: () => Promise.resolve(fake.session),
    });
    const client = await connect(sockPath);
    const session = await client.openBrowser(undefined);
    expect(session.id).toBe("sess_1");
    await session.navigate("https://x.test/page");
    expect(await session.url()).toBe("https://x.test/page");
    expect(await session.title()).toBe("X page");
    expect(await session.screenshot()).toEqual({
      id: "art_shot",
      name: "shot.png",
      url: "https://cdn/s",
    });
    expect(await session.console()).toEqual([{ level: "log", text: "hi", timestamp: 1 }]);
    expect(await session.network()).toEqual([
      { method: "GET", url: "https://x.test/api", timestamp: 2, status: 200 },
    ]);
    expect(await session.eval("1+1")).toBe("evaled:1+1");
    await session.close();
    expect(fake.log).toEqual(["nav:https://x.test/page", "close"]);
  });

  it("resolves agent({session}) back to the LIVE session object for the capability seam", async () => {
    const fake = fakeSession("sess_2");
    let seenSession: unknown = null;
    const { sockPath } = await startServer({
      openBrowser: () => Promise.resolve(fake.session),
      agent: (_prompt, opts) => {
        seenSession = opts?.session;
        return Promise.resolve("done");
      },
    });
    const client = await connect(sockPath);
    const session = await client.openBrowser(undefined);
    await client.agent("drive the browser", { session });
    expect(seenSession).toBe(fake.session);
  });

  it("rejects a browser op on a closed/unknown session with a clear VALIDATION error", async () => {
    const fake = fakeSession("sess_3");
    const { sockPath } = await startServer({ openBrowser: () => Promise.resolve(fake.session) });
    const client = await connect(sockPath);
    const session = await client.openBrowser(undefined);
    await session.close();
    const err = await session.url().catch((e: unknown) => e);
    expect((err as HostError).code).toBe("VALIDATION");
    expect((err as HostError).message).toMatch(/no open browser session/);
  });
});
