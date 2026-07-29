// The empty-input rule: what a program actually receives when its trigger supplied nothing.
//
// A cron trigger declaring no static `input`, a `boardwalk run` with no `--input`, a webhook with
// no projection — all arrive here as `null`. For a typed `run(input: ScanInput)` whose properties
// are all optional that `null` is a value the workflow's OWN derived schema rejects while `{}`
// satisfies it, so the platform was handing author code something its declared contract said could
// never arrive (`input.repos` → "Cannot read properties of null").
//
// So coerce in exactly that gap and nowhere else: the schema REJECTS what arrived and ACCEPTS the
// empty object. An untyped or `any` contract (null is valid) and an explicitly nullable one are
// left alone, and a contract with required properties is left as `null` for the control plane's
// deploy-time check to reject — manufacturing `{}` there would only trade a legible TypeError at
// the first field access for a subtler failure deeper in.

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

/**
 * The input to hand `run()`, given the run's raw JSON input and the stored derived `input_schema`.
 * Anything that actually arrived passes through untouched; only absent input is ever reshaped.
 * An uncompilable schema is a deriver bug, not the author's problem — fail soft (same policy as
 * the output validator) and pass the raw input through.
 */
export function effectiveProgramInput(
  input: unknown,
  inputSchema: Record<string, unknown> | null,
): unknown {
  if (input !== null && input !== undefined) return input;
  if (inputSchema === null) return null;
  let validate: ValidateFunction;
  try {
    // Same Ajv config as the output validator + the control plane's static-input check: structural
    // only, lax about unknown keywords, formats not enforced.
    validate = new Ajv2020({ strict: false, validateFormats: false }).compile(inputSchema);
  } catch {
    return null;
  }
  return !validate(null) && validate({}) ? {} : null;
}
