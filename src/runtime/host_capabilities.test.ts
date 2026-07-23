// buildHostCapabilities tests — the WorkerWorkflowHost → HostCapabilities adapter. Mostly an
// identity mapping; the two real behaviors are the workflows.call output_schema shim (null +
// one warning until the broker delivers the callee's schema) and the phase mapping.

import { describe, it, expect } from "vitest";
import { buildHostCapabilities } from "./host_capabilities.js";
import type { WorkerWorkflowHost } from "./workflow_host.js";

/** A duck-typed host: the adapter only calls these members. */
function fakeHost(calls: string[]): WorkerWorkflowHost {
  const record =
    <T,>(name: string, value: T) =>
    (...args: unknown[]): T => {
      calls.push(`${name}:${JSON.stringify(args[0] ?? null)}`);
      return value;
    };
  return {
    agent: record("agent", Promise.resolve("leaf")),
    callWorkflow: record("callWorkflow", Promise.resolve({ childOut: 1 })),
    runWorkflow: record("runWorkflow", Promise.resolve("run_2")),
    scheduleWorkflow: record("scheduleWorkflow", Promise.resolve("sched_2")),
    sleep: record("sleep", Promise.resolve(undefined)),
    humanInput: record("humanInput", Promise.resolve({ value: "yes" })),
    getSecret: record("getSecret", Promise.resolve("sek")),
    writeArtifact: record(
      "writeArtifact",
      Promise.resolve({ id: "a", name: "n", url: "https://u" }),
    ),
    openBrowserSession: record("openBrowserSession", Promise.resolve({ id: "sess" })),
    shell: record("shell", Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })),
    setPhase: record("setPhase", undefined),
    idToken: record("idToken", Promise.resolve("jwt")),
    apiToken: record("apiToken", Promise.resolve("api")),
    usage: record(
      "usage",
      Promise.resolve({
        usd: { spent: 0, cap: null, remaining: null },
        tokens: { spent: 0, cap: null, remaining: null },
        compute_seconds: { spent: 0, cap: null, remaining: null },
      }),
    ),
  } as unknown as WorkerWorkflowHost;
}

describe("buildHostCapabilities", () => {
  it("maps every capability onto the host", async () => {
    const calls: string[] = [];
    const caps = buildHostCapabilities(fakeHost(calls));
    await caps.agent("p", undefined);
    await caps.runWorkflow("slug", {}, undefined);
    await caps.scheduleWorkflow("slug", {}, {});
    await caps.sleep(5);
    await caps.humanInput({ prompt: "q", input: { kind: "text" } });
    await caps.getSecret("S");
    await caps.writeArtifact("n", "text/plain", "b", undefined);
    await caps.openBrowser(undefined);
    await caps.shell("echo", undefined);
    caps.phase("Build", undefined);
    await caps.idToken("aud");
    await caps.apiToken();
    await caps.usage();
    expect(calls.map((c) => c.split(":")[0])).toEqual([
      "agent",
      "runWorkflow",
      "scheduleWorkflow",
      "sleep",
      "humanInput",
      "getSecret",
      "writeArtifact",
      "openBrowserSession",
      "shell",
      "setPhase",
      "idToken",
      "apiToken",
      "usage",
    ]);
  });

  it("returns workflows.call output with an HONEST null output_schema (broker gap)", async () => {
    const calls: string[] = [];
    const caps = buildHostCapabilities(fakeHost(calls));
    const first = await caps.callWorkflow("child", { x: 1 }, undefined);
    const second = await caps.callWorkflow("child", { x: 2 }, undefined);
    expect(first).toEqual({ output: { childOut: 1 }, outputSchema: null });
    expect(second.outputSchema).toBeNull();
  });
});
