// The flat budget-guardrail rate — the FALLBACK basis for the in-run `max_usd` cap (BudgetMeter).
//
// A MANAGED turn now caps on OpenRouter's EXACT per-request `usage.cost`, forwarded from the broker to
// the worker (inference_proxy result frame → BudgetMeter.addUsage `realCostUsd`), so the cap tracks
// real spend — already cache-discounted + model-correct. This flat rate is used ONLY when a turn has
// no upstream cost: a BYO-provider turn (the org pays its own key), or a managed turn whose cost the
// broker couldn't read. It bounds runaway loops; it is NOT the bill. Actual billing is per-request
// COST PASS-THROUGH (OpenRouter's reported cost × margin) via Stripe meters (domain/billing +
// run_usage_service).
//
// Deliberately NOT a per-model table with a silent fallback: a lookup that returns a Sonnet-class
// default for any unknown id only created the ILLUSION of precision. The real per-request cost (above)
// is the precise path; this rate is just the model-agnostic backstop. Un-metered managed models are
// rejected fail-closed at resolution (domain/inference/model_resolver), so the cap never has to price
// a model we don't support.

import type { ModelRate } from "./budget.js";

/**
 * The flat representative rate (USD / million tokens) the BudgetMeter applies to the `max_usd` cap
 * ONLY as the fallback for a turn with no real upstream cost (BYO / unavailable); a managed turn caps
 * on its exact `usage.cost`. Sonnet-class list pricing — a model-agnostic backstop, not the billed price.
 */
export const BUDGET_GUARDRAIL_RATE: ModelRate = { inputPerMillion: 3, outputPerMillion: 15 };
