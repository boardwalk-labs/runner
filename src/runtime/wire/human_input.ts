// Human-input form spec + response validation (the durable-suspension design).
//
// The `HumanInputSpec` is the single source of truth for BOTH the UI form and server-side
// validation, so a `humanInput()` gate needs no JSON Schema. A responder's raw submission (from
// REST / MCP / CLI / web) is validated here against the gate's stored spec into a typed
// `HumanInputResult`, the value the seam returns to the program. Pure + exhaustively testable.
//
// These mirror the SDK's `@boardwalk-labs/workflow` types exactly (the wire contract); we re-derive
// them as Zod schemas because the stored `input_spec` is `unknown` jsonb that must be parsed at the
// boundary, never trusted (CLAUDE.md: predicates/Zod, no casts).

import { z } from "zod";
import type {
  HumanInputResult,
  HumanChoiceResult,
  HumanMultiSelectResult,
  HumanTextResult,
  JsonValue,
} from "@boardwalk-labs/workflow";
import { AppError, ErrorCode } from "../support/index.js";

/** The response form a gate presents — discriminated on `kind`. Mirrors SDK `HumanInputSpec` (the
 *  inferred output widens optionals to `T | undefined`; {@link parseHumanInputSpec} returns it). */
export const humanInputSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    multiline: z.boolean().optional(),
    placeholder: z.string().optional(),
    required: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("choice"),
    options: z.array(z.string()).min(1),
    allowOther: z.boolean().optional(),
    otherLabel: z.string().optional(),
  }),
  z.object({
    kind: z.literal("multiselect"),
    options: z.array(z.string()).min(1),
    allowOther: z.boolean().optional(),
    otherLabel: z.string().optional(),
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().nonnegative().optional(),
  }),
]);

/** Parsed spec shape (optionals as `T | undefined`); a SDK `HumanInputSpec` is assignable to it. */
export type ParsedHumanInputSpec = z.infer<typeof humanInputSpecSchema>;

/** The validated per-kind result, for parsing a stored (jsonb) result back. */
const storedResultSchema = z.union([
  z.object({ value: z.string(), isOther: z.boolean() }).strict(),
  z.object({ value: z.string() }).strict(),
  z.object({ values: z.array(z.string()), other: z.string().optional() }).strict(),
]);

/** Parse an `unknown` (jsonb) spec into a typed spec. A tool-level gate may omit a spec entirely
 *  (the model just asked a free-text question) → text; a malformed/foreign spec also degrades to
 *  free text rather than stranding the gate unanswerable. */
export function parseHumanInputSpec(raw: unknown): ParsedHumanInputSpec {
  if (raw === undefined || raw === null) return { kind: "text" };
  const parsed = humanInputSpecSchema.safeParse(raw);
  return parsed.success ? parsed.data : { kind: "text" };
}

/** Re-hydrate a stored (jsonb) human-input result into the exact-optional SDK {@link HumanInputResult}
 *  (the host returns it from a resumed `humanInput()` seam). The value was validated on submit, so a
 *  parse failure here is a corrupt stored answer — surfaced as a clear program error. */
export function normalizeHumanInputResult(raw: unknown): HumanInputResult {
  const parsed = storedResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(ErrorCode.INTERNAL_ERROR, "Stored human-input result is malformed", {
      kind: "human_input_corrupt",
    });
  }
  const r = parsed.data;
  if ("values" in r)
    return r.other !== undefined ? { values: r.values, other: r.other } : { values: r.values };
  if ("isOther" in r) return { value: r.value, isOther: r.isOther };
  return { value: r.value };
}

/** Convert a validated {@link HumanInputResult} to a {@link JsonValue} for storage (the result is an
 *  interface with optional props, which TS won't structurally accept as JsonValue; an explicit object
 *  literal IS assignable to the index signature). The inverse of {@link normalizeHumanInputResult}. */
export function humanInputResultToJson(result: HumanInputResult): JsonValue {
  if ("values" in result) {
    return result.other !== undefined
      ? { values: result.values, other: result.other }
      : { values: result.values };
  }
  if ("isOther" in result) return { value: result.value, isOther: result.isOther };
  return { value: result.value };
}

/** What to do when a gate's `timeout` elapses with no answer (the durable-suspension design). Mirrors the
 *  SDK's `HumanInputOptions.onTimeout`: fail the run, or resolve the gate with a default value. */
export type OnTimeoutPolicy = { kind: "fail" } | { kind: "value"; value: HumanInputResult };

/** Parse a stored (jsonb) `on_timeout` into a policy. NULL / unrecognized ⇒ the SDK default `fail`;
 *  a `{ value }` whose value doesn't validate as a result also degrades to `fail` (never strands). */
export function parseOnTimeout(raw: unknown): OnTimeoutPolicy {
  if (raw === null || raw === undefined || raw === "fail") return { kind: "fail" };
  if (typeof raw === "object" && "value" in raw) {
    const result = storedResultSchema.safeParse(raw.value);
    if (result.success) return { kind: "value", value: normalizeHumanInputResult(raw.value) };
  }
  return { kind: "fail" };
}

/** A responder's raw submission, before validation against the gate's spec. */
export interface RawHumanInputSubmission {
  /** Free text, or the chosen option / typed "other" value for a `choice` gate. */
  value?: unknown;
  /** Selected values for a `multiselect` gate. */
  values?: unknown;
  /** The typed freeform value for a `multiselect` "Other..." entry. */
  other?: unknown;
}

/**
 * Validate a raw submission against the gate's spec, producing the typed {@link HumanInputResult}
 * the program receives. Throws `VALIDATION_FAILED` with a precise message on any mismatch — the
 * respond surfaces turn that into a 400 so a bad answer never resumes the run with garbage.
 */
export function validateHumanInputResponse(
  spec: ParsedHumanInputSpec,
  raw: RawHumanInputSubmission,
): HumanInputResult {
  switch (spec.kind) {
    case "text":
      return validateText(spec, raw);
    case "choice":
      return validateChoice(spec, raw);
    case "multiselect":
      return validateMultiSelect(spec, raw);
  }
}

function fail(message: string): never {
  throw new AppError(ErrorCode.VALIDATION_FAILED, message, { kind: "human_input_invalid" });
}

function validateText(
  spec: Extract<ParsedHumanInputSpec, { kind: "text" }>,
  raw: RawHumanInputSubmission,
): HumanTextResult {
  if (typeof raw.value !== "string") fail("This question expects a text `value`.");
  const value = raw.value;
  if (spec.required === true && value.trim().length === 0) fail("A response is required.");
  return { value };
}

function validateChoice(
  spec: Extract<ParsedHumanInputSpec, { kind: "choice" }>,
  raw: RawHumanInputSubmission,
): HumanChoiceResult {
  if (typeof raw.value !== "string") fail("This question expects a single `value`.");
  const value = raw.value;
  const isOther = !spec.options.includes(value);
  if (isOther && spec.allowOther === false) {
    fail(`"${value}" is not one of the allowed options.`);
  }
  return { value, isOther };
}

function validateMultiSelect(
  spec: Extract<ParsedHumanInputSpec, { kind: "multiselect" }>,
  raw: RawHumanInputSubmission,
): HumanMultiSelectResult {
  if (!Array.isArray(raw.values) || !raw.values.every((v): v is string => typeof v === "string")) {
    fail("This question expects an array of string `values`.");
  }
  const values: string[] = raw.values;
  for (const v of values) {
    if (!spec.options.includes(v)) fail(`"${v}" is not one of the allowed options.`);
  }
  let other: string | undefined;
  if (raw.other !== undefined) {
    if (typeof raw.other !== "string") fail("`other` must be a string.");
    if (spec.allowOther === false) fail("This question does not allow an open-text answer.");
    if (raw.other.trim().length > 0) other = raw.other;
  }
  const total = values.length + (other !== undefined ? 1 : 0);
  if (spec.min !== undefined && total < spec.min) {
    fail(`Select at least ${String(spec.min)} option(s).`);
  }
  if (spec.max !== undefined && total > spec.max) {
    fail(`Select at most ${String(spec.max)} option(s).`);
  }
  return other !== undefined ? { values, other } : { values };
}
