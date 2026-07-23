// runShell tests — the host-side backing for the protocol's `shell` capability. Real commands,
// real filesystem: the resolve/reject contract is what workflow programs branch on.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runShell, SHELL_DEFAULT_MAX_BUFFER } from "./shell_exec.js";
import { RunAbortedError } from "./run_abort.js";

const tmpDirs: string[] = [];
async function mkTmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bw-shell-"));
  tmpDirs.push(dir);
  return fs.realpath(dir);
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("runShell", () => {
  it("resolves stdout/stderr with exit 0 on success", async () => {
    const ws = await mkTmp();
    const result = await runShell("echo hello && echo warn 1>&2", undefined, {
      workspaceRoot: ws,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr.trim()).toBe("warn");
  });

  it("RESOLVES a non-zero exit (data to branch on, never thrown)", async () => {
    const ws = await mkTmp();
    const result = await runShell("exit 7", undefined, { workspaceRoot: ws });
    expect(result.exitCode).toBe(7);
  });

  it("defaults cwd to the workspace root", async () => {
    const ws = await mkTmp();
    const result = await runShell("pwd", undefined, { workspaceRoot: ws });
    expect(result.stdout.trim()).toBe(ws);
  });

  it("resolves a RELATIVE cwd against the workspace root", async () => {
    const ws = await mkTmp();
    await fs.mkdir(path.join(ws, "sub"));
    const result = await runShell("pwd", { cwd: "sub" }, { workspaceRoot: ws });
    expect(result.stdout.trim()).toBe(path.join(ws, "sub"));
  });

  it("merges env over the process env", async () => {
    const ws = await mkTmp();
    const result = await runShell("echo $BW_SHELL_TEST_VAR", { env: { BW_SHELL_TEST_VAR: "v1" } }, {
      workspaceRoot: ws,
    });
    expect(result.stdout.trim()).toBe("v1");
  });

  it("resolves a timed-out command with the shell's 128+signum convention (SIGTERM ⇒ 143)", async () => {
    const ws = await mkTmp();
    const result = await runShell("sleep 5", { timeoutMs: 50 }, { workspaceRoot: ws });
    expect(result.exitCode).toBe(143);
  });

  it("rejects a command that cannot run at all (unusable cwd)", async () => {
    const ws = await mkTmp();
    await expect(
      runShell("echo hi", { cwd: "/definitely/not/a/dir" }, { workspaceRoot: ws }),
    ).rejects.toThrow();
  });

  it("rejects when the output exceeds maxBuffer", async () => {
    const ws = await mkTmp();
    await expect(
      runShell("head -c 1000 /dev/zero", { maxBuffer: 100 }, { workspaceRoot: ws }),
    ).rejects.toThrow(/maxBuffer/i);
  });

  it("rejects immediately when the run is already aborted", async () => {
    const ws = await mkTmp();
    const controller = new AbortController();
    controller.abort(new RunAbortedError("cancelled"));
    await expect(
      Promise.resolve().then(() =>
        runShell("echo hi", undefined, { workspaceRoot: ws, signal: controller.signal }),
      ),
    ).rejects.toBeInstanceOf(RunAbortedError);
  });

  it("kills the command and rejects with the abort reason when the run is cancelled mid-flight", async () => {
    const ws = await mkTmp();
    const controller = new AbortController();
    const running = runShell("sleep 5", undefined, { workspaceRoot: ws, signal: controller.signal });
    setTimeout(() => {
      controller.abort(new RunAbortedError("cancelled"));
    }, 30);
    await expect(running).rejects.toBeInstanceOf(RunAbortedError);
  });

  it("documents the 16 MiB default buffer", () => {
    expect(SHELL_DEFAULT_MAX_BUFFER).toBe(16 * 1024 * 1024);
  });
});
