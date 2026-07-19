// SPDX-License-Identifier: Apache-2.0

// Runner-direct BYO inference (the self-hosted runner design): the managed lane stays
// brokered (the platform key never leaves the platform), but a BYO provider is the ORG'S OWN
// endpoint + key — class-3 material the runner may hold — so the runtime calls it directly
// with the SAME engine adapters the broker uses. This is what makes a LAN-only model work on
// a runner inside that LAN, and it removes a hop for public BYO endpoints.
//
// Scope: key-based HTTP providers (openai_compatible / openai / azure_openai / anthropic).
// `bedrock` (and anything credentialed by a cross-account role rather than an org secret)
// STAYS brokered — that credential is the broker's to assume, never the runner's.
//
// The provider registry arrives as DATA on the claim (BOARDWALK_BYO_PROVIDERS: name, adapter
// source, base_url, auth secret NAME). The key resolves once per provider through the broker's
// secrets endpoint via the run's RecordingSecretResolver, so the value registers with the
// SecretRedactor and can never leak into LLM context, events, or logs.

import { chatAnthropic, chatOpenAi } from "@boardwalk-labs/engine/core";
import type { ChatMessage, ChatTurn, ToolSpec } from "@boardwalk-labs/engine/core";
import type { NormalizedReasoning } from "@boardwalk-labs/workflow";
import { z } from "zod";
import { byoInferenceProviderSchema, type ByoInferenceProvider } from "../contract.js";
import { createLogger } from "./support/index.js";

const log = createLogger("DirectInference");

/** The adapter sources the runtime can call directly (a key-based HTTP request). */
const DIRECT_SOURCES = new Set(["openai_compatible", "openai", "azure_openai", "anthropic"]);

/** Parse the claim-delivered registry (BOARDWALK_BYO_PROVIDERS). Absent/malformed ⇒ empty —
 *  the run still works; BYO calls simply fall back to the broker's clear error. */
export function parseByoProviders(raw: string | undefined): ByoInferenceProvider[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  try {
    const parsed = z.array(byoInferenceProviderSchema).safeParse(JSON.parse(raw));
    if (!parsed.success) {
      log.warn("byo_registry_invalid", { issues: parsed.error.issues.length });
      return [];
    }
    return parsed.data;
  } catch {
    log.warn("byo_registry_unparseable", {});
    return [];
  }
}

/** The registry entry for a per-`agent()` provider name, when the runtime may call it
 *  directly. Null ⇒ use the broker (managed lane, unknown provider, or a brokered-only
 *  source like bedrock). */
export function directProviderFor(
  registry: readonly ByoInferenceProvider[],
  provider: string | undefined,
): ByoInferenceProvider | null {
  if (provider === undefined || provider === "boardwalk") return null;
  const entry = registry.find((p) => p.name === provider);
  if (entry === undefined) return null;
  if (!DIRECT_SOURCES.has(entry.source) || entry.base_url === null) return null;
  return entry;
}

export interface DirectTurnRequest {
  model: string;
  messages: readonly ChatMessage[];
  tools: readonly ToolSpec[];
  reasoning?: NormalizedReasoning;
}

export interface DirectInferenceDeps {
  registry: readonly ByoInferenceProvider[];
  /** Resolves the provider's auth secret by NAME (the run's RecordingSecretResolver, so the
   *  value registers with the redactor). */
  resolveSecret: (name: string) => Promise<string>;
  fetchImpl?: typeof fetch;
}

/** One model turn, straight to the org's endpoint. Returns the ChatTurn + canonical model ref;
 *  BYO carries no platform cost (costMicros stays 0 — BYO is never metered). */
export async function streamDirectTurn(
  deps: DirectInferenceDeps,
  entry: ByoInferenceProvider,
  req: DirectTurnRequest,
  onDelta: ((text: string) => void) | undefined,
  onReasoningDelta: ((text: string) => void) | undefined,
  /** Register the resolved key with the CURRENT leaf's engine redactor, before the model call.
   *  The key resolves mid-leaf (after the leaf's redactor snapshot is seeded), so without this a
   *  provider that echoes the Authorization header in an error body would leak it into that
   *  leaf's error run event. The run-level redactor already has it via resolveSecret; this closes
   *  the per-leaf gap. */
  registerSecret?: (value: string) => void,
): Promise<{ turn: ChatTurn; modelRef: string }> {
  const apiKey =
    entry.auth_secret_name === null ? null : await deps.resolveSecret(entry.auth_secret_name);
  if (apiKey !== null) registerSecret?.(apiKey);
  if (entry.base_url === null) {
    throw new Error(`BYO provider '${entry.name}' has no base_url`);
  }
  const args = {
    baseUrl: entry.base_url,
    apiKey,
    model: req.model,
    messages: req.messages,
    tools: req.tools,
    ...(req.reasoning !== undefined ? { reasoning: req.reasoning } : {}),
  };
  const io = {
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(onDelta !== undefined ? { onDelta } : {}),
    ...(onReasoningDelta !== undefined ? { onReasoningDelta } : {}),
  };
  log.debug("direct_turn", { provider: entry.name, source: entry.source, model: req.model });
  const turn =
    entry.source === "anthropic"
      ? await chatAnthropic(args, io)
      : await chatOpenAi({ ...args, reasoningStyle: "openai_effort" }, io);
  return { turn, modelRef: `${entry.name}/${req.model}` };
}
