import { describe, it, expect } from "vitest";
import {
  diffIntent,
  mergeIntent,
  planPacks,
  packDigest,
  decideRepack,
  unreferencedPacks,
  referencedPacks,
  parseWorkspaceManifest,
  serializeWorkspaceManifest,
  emptyManifest,
  WORKSPACE_MANIFEST_VERSION,
  TARGET_PACK_BYTES,
  REPACK_MIN_PACK_COUNT,
  type WorkspaceFileEntry,
  type WorkspacePackEntry,
  type WorkspaceManifest,
  type WorkspaceWalkEntry,
} from "./workspace_format.js";

const D1 = "1".repeat(64);
const D2 = "2".repeat(64);
const D3 = "3".repeat(64);

/** A local walk entry (no pack placement yet). */
const w = (p: string, s: number, m: number): WorkspaceWalkEntry => ({ p, s, m });
/** A stored file entry. */
const f = (p: string, s: number, m: number, k = D1, o = 0): WorkspaceFileEntry => ({
  p,
  s,
  m,
  k,
  o,
});
const pack = (d: string, s: number, u = s): WorkspacePackEntry => ({ d, s, u });
const manifest = (files: WorkspaceFileEntry[], packs: WorkspacePackEntry[]): WorkspaceManifest => ({
  v: WORKSPACE_MANIFEST_VERSION,
  files,
  packs,
});
/** Placement map for mergeIntent: every named path lands in D2 at offset 0. */
const placed = (...paths: string[]): Map<string, { k: string; o: number }> =>
  new Map(paths.map((p) => [p, { k: D2, o: 0 }]));

describe("diffIntent", () => {
  it("writes everything and deletes nothing against a null baseline", () => {
    const i = diffIntent([w("a", 1, 10), w("b", 2, 20)], null);
    expect(i.write.map((e) => e.p)).toEqual(["a", "b"]);
    expect(i.keep).toEqual([]);
    expect(i.delete).toEqual([]);
  });

  it("never invents deletions from an unknown baseline", () => {
    // The dangerous case: a run that couldn't read the manifest must not conclude the scope is empty.
    const i = diffIntent([], null);
    expect(i.delete).toEqual([]);
    expect(i.write).toEqual([]);
  });

  it("keeps an unchanged file, carrying its existing pack placement forward", () => {
    const base = manifest([f("a", 1, 10, D1, 0)], [pack(D1, 1)]);
    const i = diffIntent([w("a", 1, 10)], base);
    expect(i.write).toEqual([]);
    expect(i.keep).toEqual([f("a", 1, 10, D1, 0)]);
  });

  it("writes only the changed file — the property that makes a long loop cheap", () => {
    const base = manifest([f("a", 1, 10), f("big", 5_000_000, 20)], [pack(D1, 5_000_001)]);
    const i = diffIntent([w("a", 1, 11), w("big", 5_000_000, 20)], base);
    expect(i.write.map((e) => e.p)).toEqual(["a"]);
    expect(i.keep.map((e) => e.p)).toEqual(["big"]);
  });

  it("treats a size change as changed even at an identical mtime", () => {
    const base = manifest([f("a", 1, 10)], [pack(D1, 1)]);
    expect(diffIntent([w("a", 2, 10)], base).write.map((e) => e.p)).toEqual(["a"]);
  });

  it("deletes a path that was in the baseline and is gone from disk", () => {
    const base = manifest([f("a", 1, 10), f("gone", 3, 30)], [pack(D1, 4)]);
    const i = diffIntent([w("a", 1, 10)], base);
    expect(i.delete).toEqual(["gone"]);
  });
});

describe("mergeIntent — the three-way merge (§6)", () => {
  it("leaves a concurrent run's untouched file alone", () => {
    // Baseline had only `mine`. The remote has gained `theirs` from a concurrent run. Nothing this run
    // did concerns `theirs`, so it must survive — this is the bug the merge exists to fix.
    const base = manifest([f("mine", 1, 10)], [pack(D1, 1)]);
    const remote = manifest(
      [f("mine", 1, 10), f("theirs", 9, 90, D3, 0)],
      [pack(D1, 1), pack(D3, 9)],
    );
    const intent = diffIntent([w("mine", 1, 11)], base);
    const merged = mergeIntent(intent, base, remote, placed("mine"));
    expect(merged.files.map((e) => e.p)).toEqual(["mine", "theirs"]);
    expect(merged.conflicts).toEqual([]);
  });

  it("does NOT delete a file it never had, even though it is absent from disk", () => {
    // The precise failure of the old code: `theirs` is not in the local tree, but it was never in this
    // run's baseline either, so it is not this run's deletion to make.
    const base = manifest([f("mine", 1, 10)], [pack(D1, 1)]);
    const remote = manifest(
      [f("mine", 1, 10), f("theirs", 9, 90, D3, 0)],
      [pack(D1, 1), pack(D3, 9)],
    );
    const intent = diffIntent([w("mine", 1, 10)], base);
    const merged = mergeIntent(intent, base, remote, placed());
    expect(merged.files.map((e) => e.p)).toContain("theirs");
  });

  it("resolves a genuine both-wrote collision in our favor AND reports it", () => {
    const base = manifest([f("x", 1, 10)], [pack(D1, 1)]);
    const remote = manifest([f("x", 5, 50, D3, 0)], [pack(D3, 5)]);
    const intent = diffIntent([w("x", 2, 20)], base);
    const merged = mergeIntent(intent, base, remote, placed("x"));
    expect(merged.files).toEqual([{ p: "x", s: 2, m: 20, k: D2, o: 0 }]);
    expect(merged.conflicts).toEqual([{ path: "x", ours: "wrote" }]);
  });

  it("yields to the remote for a file WE did not change", () => {
    // Asymmetry with `write`, on purpose: we have nothing newer to offer, so overwriting a concurrent
    // edit with our byte-identical baseline copy would be pure data loss.
    const base = manifest([f("x", 1, 10)], [pack(D1, 1)]);
    const remote = manifest([f("x", 5, 50, D3, 0)], [pack(D3, 5)]);
    const intent = diffIntent([w("x", 1, 10)], base);
    const merged = mergeIntent(intent, base, remote, placed());
    expect(merged.files).toEqual([{ p: "x", s: 5, m: 50, k: D3, o: 0 }]);
  });

  it("reports a deletion that raced a concurrent write, and ours still wins", () => {
    const base = manifest([f("x", 1, 10)], [pack(D1, 1)]);
    const remote = manifest([f("x", 5, 50, D3, 0)], [pack(D3, 5)]);
    const intent = diffIntent([], base);
    const merged = mergeIntent(intent, base, remote, placed());
    expect(merged.files).toEqual([]);
    expect(merged.conflicts).toEqual([{ path: "x", ours: "deleted" }]);
  });

  it("omits a file whose bytes were never placed rather than dangling the manifest", () => {
    const intent = diffIntent([w("a", 1, 10)], null);
    const merged = mergeIntent(intent, null, null, placed()); // nothing placed
    expect(merged.files).toEqual([]);
  });

  it("returns files sorted by path so the manifest is stable across runs", () => {
    const intent = diffIntent([w("c", 1, 1), w("a", 1, 1), w("b", 1, 1)], null);
    const merged = mergeIntent(intent, null, null, placed("a", "b", "c"));
    expect(merged.files.map((e) => e.p)).toEqual(["a", "b", "c"]);
  });
});

describe("planPacks", () => {
  it("groups small files into one pack with contiguous offsets", () => {
    const plans = planPacks([w("a", 10, 1), w("b", 20, 1), w("c", 30, 1)], 1000);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.entries.map((e) => [e.entry.p, e.offset])).toEqual([
      ["a", 0],
      ["b", 10],
      ["c", 30],
    ]);
    expect(plans[0]?.uncompressedBytes).toBe(60);
  });

  it("closes a pack at the size target and starts the next at offset 0", () => {
    const plans = planPacks([w("a", 60, 1), w("b", 60, 1)], 100);
    expect(plans).toHaveLength(2);
    expect(plans[0]?.entries.map((e) => e.entry.p)).toEqual(["a"]);
    expect(plans[1]?.entries.map((e) => [e.entry.p, e.offset])).toEqual([["b", 0]]);
  });

  it("gives an oversized file a pack of one, with no special case", () => {
    const plans = planPacks([w("small", 1, 1), w("huge", TARGET_PACK_BYTES * 3, 1)]);
    const huge = plans.find((p) => p.entries.some((e) => e.entry.p === "huge"));
    expect(huge?.entries).toHaveLength(1);
  });

  it("orders by path so a directory's files land together and packing is deterministic", () => {
    const a = planPacks([w("z/1", 1, 1), w("a/1", 1, 1), w("a/2", 1, 1)], 1000);
    const b = planPacks([w("a/2", 1, 1), w("z/1", 1, 1), w("a/1", 1, 1)], 1000);
    expect(a[0]?.entries.map((e) => e.entry.p)).toEqual(["a/1", "a/2", "z/1"]);
    expect(a).toEqual(b);
  });

  it("plans nothing for an empty change set", () => {
    expect(planPacks([])).toEqual([]);
  });
});

describe("packDigest", () => {
  it("is stable and content-dependent", () => {
    const bytes = new TextEncoder().encode("hello");
    expect(packDigest(bytes)).toBe(packDigest(new TextEncoder().encode("hello")));
    expect(packDigest(bytes)).not.toBe(packDigest(new TextEncoder().encode("hellp")));
    expect(packDigest(bytes)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("unreferencedPacks / referencedPacks", () => {
  it("collects a pack nothing points into any more", () => {
    const prev = manifest([f("a", 1, 1, D1)], [pack(D1, 1), pack(D2, 5)]);
    const next = manifest([f("a", 1, 1, D1)], [pack(D1, 1)]);
    expect(unreferencedPacks(prev, next)).toEqual([D2]);
  });

  it("collects nothing when there was no previous manifest", () => {
    expect(unreferencedPacks(null, emptyManifest())).toEqual([]);
  });

  it("keeps a pack still referenced by at least one file", () => {
    const prev = manifest([f("a", 1, 1, D1), f("b", 1, 1, D2)], [pack(D1, 1), pack(D2, 1)]);
    const next = manifest([f("b", 1, 1, D2)], [pack(D2, 1)]);
    expect(unreferencedPacks(prev, next)).toEqual([D1]);
  });

  it("drops unreferenced packs from the carried set, which is what makes them garbage", () => {
    const kept = referencedPacks([f("a", 1, 1, D2)], [pack(D1, 1), pack(D2, 1)]);
    expect(kept.map((p) => p.d)).toEqual([D2]);
  });

  it("dedupes by digest so a rebuilt-identical pack is not counted twice", () => {
    // The caller concatenates the remote's packs with the ones just built, and those overlap whenever
    // re-packing identical content reproduces a stored digest. Two entries would double-count
    // storedUncompressedBytes and fire a repack on a scope with no dead bytes at all.
    const kept = referencedPacks([f("a", 1, 1, D1)], [pack(D1, 10), pack(D1, 10)]);
    expect(kept).toEqual([pack(D1, 10)]);
    expect(decideRepack(manifest([f("a", 10, 1, D1)], kept)).repack).toBe(false);
  });
});

describe("decideRepack", () => {
  it("does not repack an empty scope", () => {
    expect(decideRepack(emptyManifest()).repack).toBe(false);
  });

  it("does not repack a healthy scope", () => {
    const m = manifest([f("a", 100, 1, D1)], [pack(D1, 100)]);
    expect(decideRepack(m).repack).toBe(false);
  });

  it("repacks when dead bytes dominate", () => {
    // 10 live bytes against 100 stored: the append-only rule has left 90% dead weight.
    const m = manifest([f("a", 10, 1, D1)], [pack(D1, 100)]);
    const d = decideRepack(m);
    expect(d.repack).toBe(true);
    expect(d.reason).toBe("live_fraction");
    expect(d.liveBytes).toBe(10);
  });

  it("repacks when pack COUNT drifts up, even with no dead bytes", () => {
    // A long run appending a tiny pack per iteration: live fraction stays 1.0 forever, but the
    // round-trip cost packs exist to remove creeps back in.
    const packs = Array.from({ length: REPACK_MIN_PACK_COUNT + 5 }, (_, i) =>
      pack(String(i).padStart(64, "0"), 1),
    );
    const files = packs.map((p, i) => f(`f${String(i)}`, 1, 1, p.d));
    const d = decideRepack(manifest(files, packs));
    expect(d.repack).toBe(true);
    expect(d.reason).toBe("pack_count");
  });

  it("tolerates many packs when the scope is genuinely large", () => {
    const count = 40;
    const packs = Array.from({ length: count }, (_, i) =>
      pack(String(i).padStart(64, "0"), TARGET_PACK_BYTES),
    );
    const files = packs.map((p, i) => f(`f${String(i)}`, TARGET_PACK_BYTES, 1, p.d));
    expect(decideRepack(manifest(files, packs)).repack).toBe(false);
  });
});

describe("manifest serialization", () => {
  it("round-trips", () => {
    const m = manifest([f("a", 1, 10, D1, 0), f("b", 2, 20, D1, 1)], [pack(D1, 3)]);
    expect(parseWorkspaceManifest(serializeWorkspaceManifest(m))).toEqual(m);
  });

  it("round-trips an empty manifest as a RESTORED state, not a missing one", () => {
    const parsed = parseWorkspaceManifest(serializeWorkspaceManifest(emptyManifest()));
    expect(parsed).toEqual(emptyManifest());
    expect(parsed).not.toBeNull();
  });

  it("rejects an unknown version rather than guessing at its shape", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 999, files: [], packs: [] }));
    expect(parseWorkspaceManifest(bytes)).toBeNull();
  });

  it("rejects a file pointing at a pack the manifest does not list", () => {
    // A dangling ref would hydrate into a missing file with no error at read time.
    const bytes = serializeWorkspaceManifest(manifest([f("a", 1, 1, D2)], [pack(D1, 1)]));
    expect(parseWorkspaceManifest(bytes)).toBeNull();
  });

  it("rejects a non-sha256 pack digest", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        v: WORKSPACE_MANIFEST_VERSION,
        files: [],
        packs: [{ d: "../x", s: 1, u: 1 }],
      }),
    );
    expect(parseWorkspaceManifest(bytes)).toBeNull();
  });

  it("rejects negative or fractional sizes and offsets", () => {
    for (const bad of [{ s: -1 }, { s: 1.5 }, { o: -1 }]) {
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          v: WORKSPACE_MANIFEST_VERSION,
          files: [{ p: "a", s: 1, m: 1, k: D1, o: 0, ...bad }],
          packs: [pack(D1, 1)],
        }),
      );
      expect(parseWorkspaceManifest(bytes)).toBeNull();
    }
  });

  it("rejects an empty path", () => {
    const bytes = serializeWorkspaceManifest(manifest([f("", 1, 1, D1)], [pack(D1, 1)]));
    expect(parseWorkspaceManifest(bytes)).toBeNull();
  });

  it("returns null for unparseable bytes rather than throwing", () => {
    expect(parseWorkspaceManifest(new TextEncoder().encode("not json"))).toBeNull();
  });
});
