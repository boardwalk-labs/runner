import { describe, it, expect } from "vitest";
import { PassThrough, Duplex } from "node:stream";
import {
  IdentityRelay,
  MAX_RELAY_LINE_BYTES,
  RELAY_FD_ENV,
  applyIdentityToEnv,
  relayFdFromEnv,
  relayIdentitySchema,
  workerDiagnostics,
  type RelayIdentity,
} from "./identity_relay.js";

/** An in-memory duplex pair: what one side writes, the other reads. */
function duplexPair(): [Duplex, Duplex] {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const a = Duplex.from({ readable: bToA, writable: aToB });
  const b = Duplex.from({ readable: aToB, writable: bToA });
  return [a, b];
}

function identity(overrides: Partial<RelayIdentity> = {}): RelayIdentity {
  return relayIdentitySchema.parse({
    run_id: "run_01J",
    control_plane_url: "https://api.example",
    run_token: "rt_tok",
    ...overrides,
  });
}

describe("relayFdFromEnv", () => {
  it("returns null and scrubs when unset or blank", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(relayFdFromEnv(env)).toBeNull();
    const blank: NodeJS.ProcessEnv = { [RELAY_FD_ENV]: "  " };
    expect(relayFdFromEnv(blank)).toBeNull();
    expect(RELAY_FD_ENV in blank).toBe(false);
  });

  it("parses the fd and scrubs the key", () => {
    const env: NodeJS.ProcessEnv = { [RELAY_FD_ENV]: "3" };
    expect(relayFdFromEnv(env)).toBe(3);
    expect(RELAY_FD_ENV in env).toBe(false);
  });

  it("rejects non-inherited fds", () => {
    expect(() => relayFdFromEnv({ [RELAY_FD_ENV]: "1" })).toThrow(/inherited fd/);
    expect(() => relayFdFromEnv({ [RELAY_FD_ENV]: "abc" })).toThrow(/inherited fd/);
  });
});

describe("applyIdentityToEnv", () => {
  it("maps the platform contract fields onto env", () => {
    const env: NodeJS.ProcessEnv = {};
    applyIdentityToEnv(
      identity({
        api_token: "at_tok",
        task_cpu_units: 2048,
        byo_providers: [{ name: "openai", source: "openai" }],
        env: { MY_VAR: "1" },
      }),
      env,
    );
    expect(env.RUN_ID).toBe("run_01J");
    expect(env.BOARDWALK_CONTROL_PLANE_URL).toBe("https://api.example");
    expect(env.BOARDWALK_RUN_TOKEN).toBe("rt_tok");
    expect(env.BOARDWALK_API_KEY).toBe("at_tok");
    expect(env.BOARDWALK_TASK_CPU_UNITS).toBe("2048");
    expect(env.BOARDWALK_BYO_PROVIDERS).toBe(
      JSON.stringify([{ name: "openai", source: "openai" }]),
    );
    expect(env.MY_VAR).toBe("1");
  });

  it("omits absent optionals instead of writing empty strings", () => {
    const env: NodeJS.ProcessEnv = {};
    applyIdentityToEnv(identity(), env);
    expect("BOARDWALK_API_KEY" in env).toBe(false);
    expect("BOARDWALK_TASK_CPU_UNITS" in env).toBe(false);
    expect("BOARDWALK_BYO_PROVIDERS" in env).toBe(false);
  });

  it("platform keys always win over user env of the same name", () => {
    const env: NodeJS.ProcessEnv = {};
    applyIdentityToEnv(
      identity({ env: { BOARDWALK_RUN_TOKEN: "spoofed", RUN_ID: "spoofed" } }),
      env,
    );
    expect(env.BOARDWALK_RUN_TOKEN).toBe("rt_tok");
    expect(env.RUN_ID).toBe("run_01J");
  });
});

describe("IdentityRelay", () => {
  it("announces ready, receives identity (across chunk splits), accepts", async () => {
    const [workerEnd, initEnd] = duplexPair();
    const relay = new IdentityRelay(workerEnd);

    const initLines: string[] = [];
    let initBuffer = "";
    initEnd.on("data", (chunk: Buffer) => {
      initBuffer += chunk.toString("utf8");
      for (let i = initBuffer.indexOf("\n"); i >= 0; i = initBuffer.indexOf("\n")) {
        initLines.push(initBuffer.slice(0, i));
        initBuffer = initBuffer.slice(i + 1);
      }
    });

    relay.announceReady();
    const pending = relay.awaitIdentity();
    const wire =
      JSON.stringify({ type: "identity", payload: identity({ env: { A: "1" } }) }) + "\n";
    // Deliver in two arbitrary chunks — line assembly must not depend on framing.
    initEnd.write(wire.slice(0, 25));
    initEnd.write(wire.slice(25));
    const got = await pending;
    expect(got.run_id).toBe("run_01J");
    expect(got.env).toEqual({ A: "1" });
    relay.acceptIdentity();

    await new Promise((r) => setImmediate(r));
    expect(initLines).toEqual([
      JSON.stringify({ type: "worker_ready" }),
      JSON.stringify({ type: "identity_accepted" }),
    ]);
  });

  it("skips malformed lines and unknown types, then takes the identity", async () => {
    const [workerEnd, initEnd] = duplexPair();
    const relay = new IdentityRelay(workerEnd);
    const pending = relay.awaitIdentity();
    initEnd.write("not json at all\n");
    initEnd.write(JSON.stringify({ type: "mystery" }) + "\n");
    initEnd.write(JSON.stringify({ type: "identity", payload: identity() }) + "\n");
    const got = await pending;
    expect(got.run_token).toBe("rt_tok");
  });

  it("a malformed identity payload is a hard error", async () => {
    const [workerEnd, initEnd] = duplexPair();
    const relay = new IdentityRelay(workerEnd);
    const pending = relay.awaitIdentity();
    initEnd.write(JSON.stringify({ type: "identity", payload: { run_id: "" } }) + "\n");
    await expect(pending).rejects.toThrow(/identity payload is invalid/);
  });

  it("a relay that closes pre-identity rejects instead of hanging", async () => {
    const [workerEnd, initEnd] = duplexPair();
    const relay = new IdentityRelay(workerEnd);
    const pending = relay.awaitIdentity();
    initEnd.end();
    await expect(pending).rejects.toThrow(/closed before/);
  });

  it("announceReady carries the diagnostics payload when provided", async () => {
    const [workerEnd, initEnd] = duplexPair();
    const relay = new IdentityRelay(workerEnd);
    const lines: string[] = [];
    initEnd.on("data", (chunk: Buffer) => lines.push(chunk.toString("utf8")));
    relay.announceReady({ worker_version: "0.1.11", node_version: "v24.1.0" });
    await new Promise((r) => setImmediate(r));
    expect(JSON.parse(lines.join(""))).toEqual({
      type: "worker_ready",
      payload: { worker_version: "0.1.11", node_version: "v24.1.0" },
    });
  });

  it("an oversized unterminated line fails the relay instead of buffering forever", async () => {
    const [workerEnd, initEnd] = duplexPair();
    // The relay destroys its end on failure; the in-memory pair surfaces that to the writer
    // as an abort error, which is exactly the point — swallow it so vitest doesn't flag it.
    initEnd.on("error", () => undefined);
    const relay = new IdentityRelay(workerEnd);
    const pending = relay.awaitIdentity();
    // Feed past the cap without a newline — no legal line can ever complete.
    const chunk = "x".repeat(1024 * 1024);
    for (let sent = 0; sent <= MAX_RELAY_LINE_BYTES; sent += chunk.length) {
      initEnd.write(chunk);
    }
    await expect(pending).rejects.toThrow(/exceeds/);
  });

  it("park detaches the reader so post-identity traffic is not buffered", async () => {
    const [workerEnd, initEnd] = duplexPair();
    const relay = new IdentityRelay(workerEnd);
    const pending = relay.awaitIdentity();
    initEnd.write(JSON.stringify({ type: "identity", payload: identity() }) + "\n");
    await pending;
    relay.acceptIdentity();
    relay.park();
    expect(workerEnd.listenerCount("data")).toBe(0);
    expect(workerEnd.isPaused()).toBe(true);
  });
});

describe("workerDiagnostics", () => {
  it("reports the node version and best-effort package versions", () => {
    const got = workerDiagnostics();
    expect(got.node_version).toBe(process.version);
    // In this repo the runner's own package.json is two levels up from the module — present.
    expect(got.worker_version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
