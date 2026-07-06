// Round-trip integration test for workspace persistence — proves files written to one run's
// `/workspace` actually SURVIVE a persist→hydrate cycle and reappear in the NEXT run's workspace.
//
// Unlike workspace_store.test.ts (which mocks `tar` + the broker and asserts control flow), this
// uses the REAL TarWorkspaceArchiver + real NodeWorkspaceFs against real temp dirs, wired through
// an in-memory broker that genuinely CARRIES the uploaded tarball bytes back on the next download.
// That is the actual mechanic the feature rests on; it had no test before.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceStore,
  TarWorkspaceArchiver,
  NodeWorkspaceFs,
  type WorkspaceBrokerTransport,
} from "./workspace_store.js";

/**
 * In-memory broker that stores what `persist()` uploads and returns it on the next `hydrate()` —
 * the byte-carrying behavior the mocked unit-test broker deliberately lacks. `downloadBytes`
 * returns null until something has been persisted (modeling a first-run 404 → clean no-op).
 */
function memoryBroker(): WorkspaceBrokerTransport & { peek(): Uint8Array | null } {
  let stored: Uint8Array | null = null;
  return {
    peek: () => stored,
    workspaceHydrateUrl: () => Promise.resolve("https://s3/get"), // eligible (hosted + opt-in)
    workspacePersistUrl: () =>
      Promise.resolve({ url: "https://s3/put", contentType: "application/gzip" }),
    uploadBytes: (_url, _headers, body) => {
      stored = body;
      return Promise.resolve();
    },
    downloadBytes: () => Promise.resolve(stored),
  };
}

function makeStore(broker: WorkspaceBrokerTransport, workspaceRoot: string, tmpPath: string) {
  return new WorkspaceStore({
    broker,
    archiver: new TarWorkspaceArchiver(),
    fs: new NodeWorkspaceFs(),
    workspaceRoot,
    tmpPath,
  });
}

describe("workspace persistence round-trip (real tar + fs)", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "bw-ws-rt-"));
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("files written in run 1 reappear, byte-identical, in run 2's fresh workspace", async () => {
    const broker = memoryBroker();
    const run1Ws = join(scratch, "run1");
    const run2Ws = join(scratch, "run2");

    // --- Run 1: produce files in /workspace, then persist ---
    await mkdir(join(run1Ws, "repo", "src"), { recursive: true });
    await writeFile(join(run1Ws, "notes.txt"), "carry me across runs");
    await writeFile(join(run1Ws, "repo", "src", "index.ts"), "export const x = 42;\n");
    await writeFile(join(run1Ws, ".hidden"), "dotfiles too"); // `tar -C dir .` must include these
    const binary = new Uint8Array([0, 1, 2, 253, 254, 255]);
    await writeFile(join(run1Ws, "blob.bin"), binary);

    await makeStore(broker, run1Ws, join(scratch, "t1.tgz")).persist();
    expect(broker.peek()).not.toBeNull(); // something was actually uploaded

    // --- Run 2: a brand-new, EMPTY workspace hydrates from the snapshot ---
    await mkdir(run2Ws, { recursive: true });
    await makeStore(broker, run2Ws, join(scratch, "t2.tgz")).hydrate();

    expect(await readFile(join(run2Ws, "notes.txt"), "utf8")).toBe("carry me across runs");
    expect(await readFile(join(run2Ws, "repo", "src", "index.ts"), "utf8")).toBe(
      "export const x = 42;\n",
    );
    expect(await readFile(join(run2Ws, ".hidden"), "utf8")).toBe("dotfiles too");
    expect(new Uint8Array(await readFile(join(run2Ws, "blob.bin")))).toEqual(binary);
  });

  it("first run hydrate is a clean no-op when nothing has been persisted yet (404 → null)", async () => {
    const broker = memoryBroker(); // nothing stored yet → downloadBytes returns null
    const ws = join(scratch, "fresh");
    await mkdir(ws, { recursive: true });
    await expect(makeStore(broker, ws, join(scratch, "t.tgz")).hydrate()).resolves.toBeUndefined();
  });

  it("re-persisting overwrites the snapshot: run 3 sees run 2's edits, not run 1's", async () => {
    const broker = memoryBroker();
    const a = join(scratch, "a");
    const b = join(scratch, "b");
    const c = join(scratch, "c");

    await mkdir(a, { recursive: true });
    await writeFile(join(a, "state.txt"), "v1");
    await makeStore(broker, a, join(scratch, "ta.tgz")).persist();

    // Next run hydrates v1, mutates to v2, persists again.
    await mkdir(b, { recursive: true });
    await makeStore(broker, b, join(scratch, "tb.tgz")).hydrate();
    expect(await readFile(join(b, "state.txt"), "utf8")).toBe("v1");
    await writeFile(join(b, "state.txt"), "v2");
    await makeStore(broker, b, join(scratch, "tb2.tgz")).persist();

    // Third run sees the latest snapshot.
    await mkdir(c, { recursive: true });
    await makeStore(broker, c, join(scratch, "tc.tgz")).hydrate();
    expect(await readFile(join(c, "state.txt"), "utf8")).toBe("v2");
  });
});
