// Round-trip tests for the SELF-HOSTED workspace store, against real dirs and real files.
//
// This is I3 (docs/WORKSPACE_PERSISTENCE.md): persistence has the same semantics on every substrate,
// and only the STORE changes. Self-hosted used to have NO store at all — the broker refuses to hold a
// customer's workspace in our S3 (correct), but "don't upload it" was implemented as "don't persist
// it", so `workspace.persist` and `agent({ memory })` silently forgot everything on a self-hosted
// runner while working on dev and hosted. These tests are the proof that they no longer do.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWorkspaceStore, localScopeDir } from "./local_workspace_store.js";
import { resolvePersistSelection, type PersistSelection } from "./workspace_store.js";

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bw-local-ws-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function store(scopeDir: string, workspaceRoot: string, selection: PersistSelection) {
  return new LocalWorkspaceStore({ scopeDir, workspaceRoot, selection: () => selection });
}

describe("localScopeDir", () => {
  it("keys per (workflow, environment) — the same scope the hosted S3 key uses", () => {
    expect(localScopeDir("/p", "wf1", "env_prod")).toBe("/p/wf1/env_prod");
  });

  it("uses a base dir for a run with no environment", () => {
    expect(localScopeDir("/p", "wf1", null)).toBe("/p/wf1/_base");
  });

  it("keeps two environments of one workflow apart", () => {
    expect(localScopeDir("/p", "wf1", "env_staging")).not.toBe(
      localScopeDir("/p", "wf1", "env_prod"),
    );
  });
});

describe("LocalWorkspaceStore (real fs)", () => {
  it("carries the declared dirs across runs, leaving scratch behind", async () => {
    const root = await scratch();
    const scope = join(root, "persist", "wf1", "_base");
    const run1 = join(root, "run1");
    const run2 = join(root, "run2");

    await mkdir(join(run1, "state"), { recursive: true });
    await writeFile(join(run1, "state", "x.json"), '{"seen":3}');
    await writeFile(join(run1, "scratch.txt"), "discard me");
    await store(scope, run1, ["state"]).persist();

    await mkdir(run2, { recursive: true });
    await store(scope, run2, ["state"]).hydrate();
    expect(await readFile(join(run2, "state", "x.json"), "utf8")).toBe('{"seen":3}');
    expect(existsSync(join(run2, "scratch.txt"))).toBe(false);
  });

  it("carries an agent({ memory }) dir with NO manifest declaration", async () => {
    const root = await scratch();
    const scope = join(root, "persist", "wf1", "_base");
    const run1 = join(root, "run1");
    const run2 = join(root, "run2");

    await mkdir(join(run1, "triager"), { recursive: true });
    await writeFile(join(run1, "triager", "notes.md"), "# what I learned");
    const selection = resolvePersistSelection(undefined, new Set(["triager"]));
    await store(scope, run1, selection).persist();

    await mkdir(run2, { recursive: true });
    await store(scope, run2, selection).hydrate();
    expect(await readFile(join(run2, "triager", "notes.md"), "utf8")).toBe("# what I learned");
  });

  it("round-trips the whole workspace for `true`", async () => {
    const root = await scratch();
    const scope = join(root, "persist", "wf1", "_base");
    const run1 = join(root, "run1");
    const run2 = join(root, "run2");

    await mkdir(join(run1, "nested", "deep"), { recursive: true });
    await writeFile(join(run1, "nested", "deep", "a.txt"), "a");
    await writeFile(join(run1, "top.txt"), "t");
    await store(scope, run1, true).persist();

    await mkdir(run2, { recursive: true });
    await store(scope, run2, true).hydrate();
    expect(await readFile(join(run2, "nested", "deep", "a.txt"), "utf8")).toBe("a");
    expect(await readFile(join(run2, "top.txt"), "utf8")).toBe("t");
  });

  it("propagates a DELETION rather than resurrecting the file from the last snapshot", async () => {
    // Replace-per-dir, not merge: a run that deletes a file inside a persisted dir must see it gone
    // next run. A copy-over-the-top would quietly bring it back forever.
    const root = await scratch();
    const scope = join(root, "persist", "wf1", "_base");
    const run1 = join(root, "run1");
    const run2 = join(root, "run2");
    const run3 = join(root, "run3");

    await mkdir(join(run1, "state"), { recursive: true });
    await writeFile(join(run1, "state", "keep.txt"), "k");
    await writeFile(join(run1, "state", "doomed.txt"), "d");
    await store(scope, run1, ["state"]).persist();

    // Run 2 hydrates, deletes one file, persists.
    await mkdir(run2, { recursive: true });
    await store(scope, run2, ["state"]).hydrate();
    await rm(join(run2, "state", "doomed.txt"));
    await store(scope, run2, ["state"]).persist();

    await mkdir(run3, { recursive: true });
    await store(scope, run3, ["state"]).hydrate();
    expect(existsSync(join(run3, "state", "keep.txt"))).toBe(true);
    expect(existsSync(join(run3, "state", "doomed.txt"))).toBe(false);
  });

  it("keeps two environments of one workflow completely apart", async () => {
    const root = await scratch();
    const persistRoot = join(root, "persist");
    const staging = localScopeDir(persistRoot, "wf1", "env_staging");
    const production = localScopeDir(persistRoot, "wf1", "env_prod");
    const run1 = join(root, "run1");
    const run2 = join(root, "run2");

    await mkdir(join(run1, "state"), { recursive: true });
    await writeFile(join(run1, "state", "x.txt"), "staging-value");
    await store(staging, run1, ["state"]).persist();

    // A production run must NOT see staging's state — same reason the hosted key carries the
    // environment (§4).
    await mkdir(run2, { recursive: true });
    await store(production, run2, ["state"]).hydrate();
    expect(existsSync(join(run2, "state", "x.txt"))).toBe(false);
  });

  it("is a no-op on the first run of a scope (nothing persisted yet)", async () => {
    const root = await scratch();
    const run1 = join(root, "run1");
    await mkdir(run1, { recursive: true });
    await expect(
      store(join(root, "persist", "wf1", "_base"), run1, ["state"]).hydrate(),
    ).resolves.toBeUndefined();
  });

  it("writes nothing when the selection is empty (the no-persistence common case)", async () => {
    const root = await scratch();
    const scope = join(root, "persist", "wf1", "_base");
    const run1 = join(root, "run1");
    await mkdir(run1, { recursive: true });
    await writeFile(join(run1, "scratch.txt"), "x");
    expect(await store(scope, run1, []).persist()).toBe(0);
    expect(existsSync(scope)).toBe(false);
  });

  it("skips a declared dir the run never created", async () => {
    const root = await scratch();
    const scope = join(root, "persist", "wf1", "_base");
    const run1 = join(root, "run1");
    await mkdir(join(run1, "cache"), { recursive: true });
    await writeFile(join(run1, "cache", "c.txt"), "c");
    // `index` is declared but never written — normal on a first run, and must not fail the persist.
    await store(scope, run1, ["cache", "index"]).persist();
    expect(existsSync(join(scope, "cache", "c.txt"))).toBe(true);
    expect(existsSync(join(scope, "index"))).toBe(false);
  });
});
