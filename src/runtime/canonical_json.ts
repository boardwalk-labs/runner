// canonicalJson — a key-order-independent JSON encoding, used to identify a `workflows.call` by
// its (target, input) so a restarted parent re-attaches to the child it already spawned instead of
// spawning a second one.
//
// Why not plain JSON.stringify: the control plane stores a child's input in a jsonb column, which
// does NOT preserve key order. `{a:1,b:2}` can come back as `{b:2,a:1}`, so a stringify comparison
// misses and the parent re-spawns work it already paid for. Both sides of that comparison — this
// runtime when it counts a call, the control plane when it matches one — must therefore agree on a
// canonical form. Keep the two implementations behaviourally identical.

/** Stable JSON: object keys sorted, arrays (which are ordered data) left alone. `undefined` and
 *  functions encode as `null`, matching what a jsonb round-trip would have kept. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "undefined" || typeof value === "function" ? null : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // Sort by code unit — the same total order the control plane's implementation uses.
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue; // JSON.stringify drops these; jsonb never had them
    out[key] = canonicalize(source[key]);
  }
  return out;
}
