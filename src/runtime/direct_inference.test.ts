// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi } from "vitest";
import { directProviderFor, parseByoProviders, streamDirectTurn } from "./direct_inference.js";
import type { ByoInferenceProvider } from "../contract.js";

const VLLM: ByoInferenceProvider = {
  name: "my-vllm",
  source: "openai_compatible",
  base_url: "http://10.0.0.5:8000",
  auth_secret_name: "VLLM_KEY",
};

describe("parseByoProviders", () => {
  it("parses a valid registry", () => {
    expect(parseByoProviders(JSON.stringify([VLLM]))).toEqual([VLLM]);
  });

  it("returns [] for absent / malformed / schema-invalid input", () => {
    expect(parseByoProviders(undefined)).toEqual([]);
    expect(parseByoProviders("")).toEqual([]);
    expect(parseByoProviders("{not json")).toEqual([]);
    expect(parseByoProviders(JSON.stringify([{ nope: 1 }]))).toEqual([]);
  });
});

describe("directProviderFor", () => {
  const registry = [
    VLLM,
    { name: "my-bedrock", source: "bedrock", base_url: null, auth_secret_name: null },
    { name: "no-url", source: "anthropic", base_url: null, auth_secret_name: "K" },
  ];

  it("matches a key-based HTTP provider", () => {
    expect(directProviderFor(registry, "my-vllm")).toEqual(VLLM);
  });

  it("never routes the managed lane or an unknown provider direct", () => {
    expect(directProviderFor(registry, undefined)).toBeNull();
    expect(directProviderFor(registry, "boardwalk")).toBeNull();
    expect(directProviderFor(registry, "who")).toBeNull();
  });

  it("keeps bedrock (role-credentialed) and url-less providers brokered", () => {
    expect(directProviderFor(registry, "my-bedrock")).toBeNull();
    expect(directProviderFor(registry, "no-url")).toBeNull();
  });
});

describe("streamDirectTurn", () => {
  function sseResponse(lines: string[]): Response {
    return new Response(lines.map((l) => `data: ${l}\n\n`).join("") + "data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  it("resolves the key by name, calls the endpoint, streams deltas, returns the turn", async () => {
    const resolveSecret = vi.fn().mockResolvedValue("sk-org-own");
    const fetchImpl = vi.fn().mockResolvedValue(
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: "hel" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "lo" } }] }),
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
      ]),
    );
    const deltas: string[] = [];
    const out = await streamDirectTurn(
      { registry: [VLLM], resolveSecret, fetchImpl },
      VLLM,
      { model: "qwen3", messages: [{ role: "user", text: "hi" }], tools: [] },
      (t) => deltas.push(t),
    );
    expect(resolveSecret).toHaveBeenCalledWith("VLLM_KEY");
    expect(out.modelRef).toBe("my-vllm/qwen3");
    expect(deltas.join("")).toBe("hello");
    // The call went to the ORG'S endpoint with the ORG'S key — no broker involved.
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://10.0.0.5:8000/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-org-own");
  });

  it("registers the resolved key with the leaf redactor before the model call (leak guard)", async () => {
    const resolveSecret = vi.fn().mockResolvedValue("sk-org-own");
    // Endpoint 401s with a body echoing the key (a hostile/naive BYO endpoint).
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "bad key: Bearer sk-org-own" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const registered: string[] = [];
    await expect(
      streamDirectTurn(
        { registry: [VLLM], resolveSecret, fetchImpl },
        VLLM,
        { model: "qwen3", messages: [{ role: "user", text: "hi" }], tools: [] },
        undefined,
        (v) => registered.push(v),
      ),
    ).rejects.toBeDefined();
    // The key was registered BEFORE the failing call, so the leaf redactor can scrub the error.
    expect(registered).toEqual(["sk-org-own"]);
  });

  it("passes apiKey null through for a keyless endpoint (e.g. LAN ollama)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
        ]),
      );
    const entry: ByoInferenceProvider = { ...VLLM, auth_secret_name: null };
    const resolveSecret = vi.fn();
    await streamDirectTurn(
      { registry: [entry], resolveSecret, fetchImpl },
      entry,
      { model: "m", messages: [{ role: "user", text: "hi" }], tools: [] },
      undefined,
    );
    expect(resolveSecret).not.toHaveBeenCalled();
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });
});
