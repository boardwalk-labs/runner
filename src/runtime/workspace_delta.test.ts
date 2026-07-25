import { describe, it, expect } from "vitest";
import {
  diffWorkspace,
  parseWorkspaceManifest,
  serializeWorkspaceManifest,
  workspaceFileKeySuffix,
  WORKSPACE_MANIFEST_VERSION,
  type WorkspaceFileEntry,
  type WorkspaceManifest,
} from "./workspace_delta.js";

const f = (p: string, s: number, m: number): WorkspaceFileEntry => ({ p, s, m });
const manifest = (...files: WorkspaceFileEntry[]): WorkspaceManifest => ({
  v: WORKSPACE_MANIFEST_VERSION,
  files,
});

describe("diffWorkspace", () => {
  it("uploads everything when nothing is stored yet", () => {
    const d = diffWorkspace([f("a", 1, 10), f("b", 2, 20)], null);
    expect(d.upload.map((e) => e.p)).toEqual(["a", "b"]);
    expect(d.delete).toEqual([]);
    expect(d.totalBytes).toBe(3);
  });

  it("uploads nothing when the tree is identical", () => {
    const prev = manifest(f("a", 1, 10), f("b", 2, 20));
    const d = diffWorkspace([f("a", 1, 10), f("b", 2, 20)], prev);
    expect(d.upload).toEqual([]);
    expect(d.delete).toEqual([]);
  });

  it("uploads only the changed file — the whole point of the delta", () => {
    const prev = manifest(f("a", 1, 10), f("big", 5_000_000, 20));
    const d = diffWorkspace([f("a", 1, 11), f("big", 5_000_000, 20)], prev);
    expect(d.upload.map((e) => e.p)).toEqual(["a"]);
  });

  it("treats a size change as changed even at the same mtime", () => {
    const prev = manifest(f("a", 1, 10));
    expect(diffWorkspace([f("a", 2, 10)], prev).upload).toHaveLength(1);
  });

  it("uploads an added file and deletes a removed one", () => {
    const prev = manifest(f("keep", 1, 10), f("gone", 1, 10));
    const d = diffWorkspace([f("keep", 1, 10), f("added", 1, 10)], prev);
    expect(d.upload.map((e) => e.p)).toEqual(["added"]);
    expect(d.delete).toEqual(["gone"]);
  });

  // Without deletes a persisted workspace grows monotonically as an agent creates and removes
  // scratch files across runs — the storage bill climbs and hydrate restores files the run deleted.
  it("deletes every path that vanished, not just the first", () => {
    const prev = manifest(f("a", 1, 1), f("b", 1, 1), f("c", 1, 1));
    expect(diffWorkspace([f("b", 1, 1)], prev).delete.sort()).toEqual(["a", "c"]);
  });

  it("carries the full file list forward, not just the uploaded subset", () => {
    const prev = manifest(f("unchanged", 1, 10));
    const d = diffWorkspace([f("unchanged", 1, 10), f("new", 2, 20)], prev);
    // The next manifest must describe the whole scope; storing only the delta would make the next
    // run's diff think `unchanged` was deleted.
    expect(d.next.files.map((e) => e.p).sort()).toEqual(["new", "unchanged"]);
    expect(d.totalBytes).toBe(3);
  });

  it("reports an empty scope as zero bytes with everything deleted", () => {
    const d = diffWorkspace([], manifest(f("a", 9, 1)));
    expect(d.totalBytes).toBe(0);
    expect(d.delete).toEqual(["a"]);
    expect(d.next.files).toEqual([]);
  });
});

describe("workspace manifest serialization", () => {
  it("round-trips", () => {
    const m = manifest(f("cache/a.txt", 3, 1000), f("notes.md", 5, 2000));
    expect(parseWorkspaceManifest(serializeWorkspaceManifest(m))).toEqual(m);
  });

  // Anything unreadable must degrade to "scope unknown" → re-upload. Returning a partial manifest
  // would make the diff believe files are stored that are not, and silently lose them.
  it("returns null for junk, a wrong version, or a malformed entry", () => {
    const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
    expect(parseWorkspaceManifest(enc("not json"))).toBeNull();
    expect(parseWorkspaceManifest(enc("null"))).toBeNull();
    expect(parseWorkspaceManifest(enc('{"v":999,"files":[]}'))).toBeNull();
    expect(parseWorkspaceManifest(enc('{"v":1}'))).toBeNull();
    expect(parseWorkspaceManifest(enc('{"v":1,"files":[{"p":"a","s":"1","m":2}]}'))).toBeNull();
    expect(parseWorkspaceManifest(enc('{"v":1,"files":[{"p":"a"}]}'))).toBeNull();
  });
});

describe("workspaceFileKeySuffix", () => {
  it("is stable and distinct per path", () => {
    expect(workspaceFileKeySuffix("a/b.txt")).toBe(workspaceFileKeySuffix("a/b.txt"));
    expect(workspaceFileKeySuffix("a/b.txt")).not.toBe(workspaceFileKeySuffix("a/c.txt"));
  });

  // A workspace path is arbitrary author-controlled text. Embedding it in the key is how you get a
  // traversal out of the scope prefix, an unencodable key, or a breach of S3's 1024-byte limit.
  it("is fixed-width and key-safe for hostile paths", () => {
    for (const p of ["../../etc/passwd", "a b/c?d=e#f", "ünïcødé/文件", "x".repeat(5000), "\n\t"]) {
      expect(workspaceFileKeySuffix(p)).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
