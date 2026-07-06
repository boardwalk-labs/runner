// SecretRedactor — scrubs known secret values from everything bound for an LLM (MASTER_SPEC §12,
// docs/WORKFLOW_RUNTIME.md §6.2, plan #9).
//
// The architectural guarantee is structural: secrets live ONLY in the workflow PROGRAM (the trusted
// deterministic tool layer), which holds them via `secrets.get` / `ctx.secrets.resolve`. The
// `agent()` leaf never receives a secret by design — so prompt injection can't reach one. This
// redactor is DEFENSE-IN-DEPTH for the path where a program (or a tool result) inadvertently
// carries a known secret value into LLM context (prompt, system prompt, tool args/results,
// transcript): every value the run resolves is recorded here, and the leaf scrubs known values out
// of LLM-bound text before the model ever sees them.
//
// Pure logic by design (no I/O, no deps) so it can be tested exhaustively — the platform's secret
// boundary lives here.

/** Replacement token substituted for any known secret value. Generic on purpose — it must not
 *  reveal WHICH secret matched. */
export const REDACTION_PLACEHOLDER = "[REDACTED]";

/**
 * Values shorter than this are NOT recorded. A 1–3 char "secret" would match common substrings and
 * shred unrelated text; real credentials are long. Mirrors GitHub Actions' masking floor. A value
 * this short should not be a secret in the first place — and the structural guarantee (secrets never
 * flow to the LLM by construction) still holds for it; only the belt-and-suspenders scrub is skipped.
 */
export const MIN_REDACTABLE_LENGTH = 4;

/** Bound on recursion into nested tool results. JSON has no cycles, but a pathological structure
 *  shouldn't blow the stack; beyond this depth a value can't realistically still be a secret. */
const MAX_REDACT_DEPTH = 100;

export interface SecretRedactorOptions {
  placeholder?: string;
  minLength?: number;
}

export class SecretRedactor {
  /** Recorded secret values, kept sorted longest-first so a longer secret is replaced before any
   *  shorter secret that is its substring. */
  private recorded: string[] = [];
  private readonly seen = new Set<string>();
  private readonly placeholder: string;
  private readonly minLength: number;

  constructor(opts: SecretRedactorOptions = {}) {
    this.placeholder = opts.placeholder ?? REDACTION_PLACEHOLDER;
    this.minLength = opts.minLength ?? MIN_REDACTABLE_LENGTH;
  }

  /** Number of distinct values currently being redacted. */
  get size(): number {
    return this.recorded.length;
  }

  /** A snapshot of the recorded secret values (longest-first). Read by the worker to seed a fresh
   *  engine `Redactor` per leaf so the engine loop scrubs the SAME values out of model-bound content. */
  get values(): readonly string[] {
    return [...this.recorded];
  }

  /**
   * Record a resolved secret value so future LLM-bound content has it scrubbed. No-op for values
   * below the length floor or already known. Idempotent.
   */
  record(value: string): void {
    if (value.length < this.minLength) return;
    if (this.seen.has(value)) return;
    this.seen.add(value);
    this.recorded.push(value);
    // Longest-first: replacing the longer match first keeps a shorter substring secret from
    // fragmenting the longer one (e.g. "abc" before "abcdef" would leave "[REDACTED]def").
    this.recorded.sort((a, b) => b.length - a.length);
  }

  /** Replace every occurrence of every known secret value in `text` with the placeholder. */
  redactText(text: string): string {
    if (this.recorded.length === 0) return text;
    let out = text;
    for (const v of this.recorded) {
      if (out.includes(v)) out = out.split(v).join(this.placeholder);
    }
    return out;
  }

  /**
   * Deep-redact a JSON-shaped value: strings are scrubbed, arrays/objects recursed. Non-string
   * primitives pass through (a secret is always a string). Returns the input unchanged when nothing
   * is recorded, so the common no-secrets case is allocation-free.
   */
  redactValue(value: unknown): unknown {
    if (this.recorded.length === 0) return value;
    return this.redactAt(value, 0);
  }

  private redactAt(value: unknown, depth: number): unknown {
    if (typeof value === "string") return this.redactText(value);
    if (depth >= MAX_REDACT_DEPTH) return value;
    if (Array.isArray(value)) return value.map((v) => this.redactAt(v, depth + 1));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.redactAt(v, depth + 1);
      return out;
    }
    return value;
  }
}
