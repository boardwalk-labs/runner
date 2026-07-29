// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi } from "vitest";
import {
  ByoProviderRegistry,
  directProviderFor,
  parseByoProviders,
  streamDirectTurn,
} from "./direct_inference.js";
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

describe("ByoProviderRegistry", () => {
  const OPENAI: ByoInferenceProvider = {
    name: "my-openai",
    source: "openai",
    base_url: "https://api.openai.com/v1",
    auth_secret_name: "K",
  };

  it("serves the snapshot without re-reading it", async () => {
    const refresh = vi.fn();
    const reg = new ByoProviderRegistry([VLLM], refresh);
    expect(await reg.direct("my-vllm")).toEqual(VLLM);
    expect(refresh).not.toHaveBeenCalled();
  });

  // The reason this class exists: a provider created mid-run is absent from the dispatch snapshot,
  // and brokering it fails the run.
  it("re-reads once when a name is missing, then serves it", async () => {
    const refresh = vi.fn().mockResolvedValue([VLLM, OPENAI]);
    const reg = new ByoProviderRegistry([VLLM], refresh);
    expect(await reg.direct("my-openai")).toEqual(OPENAI);
    expect(await reg.direct("my-openai")).toEqual(OPENAI);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("re-reads at most once per name, so a bad name in a loop costs one fetch", async () => {
    const refresh = vi.fn().mockResolvedValue([VLLM]);
    const reg = new ByoProviderRegistry([VLLM], refresh);
    expect(await reg.direct("typo")).toBeNull();
    expect(await reg.direct("typo")).toBeNull();
    expect(await reg.direct("typo")).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("never re-reads for the managed lane or a known-but-brokered provider", async () => {
    const refresh = vi.fn();
    const reg = new ByoProviderRegistry(
      [{ name: "my-bedrock", source: "bedrock", base_url: null, auth_secret_name: null }],
      refresh,
    );
    expect(await reg.direct(undefined)).toBeNull();
    expect(await reg.direct("boardwalk")).toBeNull();
    expect(await reg.direct("my-bedrock")).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("falls through to the broker when the re-read fails", async () => {
    const refresh = vi.fn().mockRejectedValue(new Error("broker down"));
    const reg = new ByoProviderRegistry([], refresh);
    expect(await reg.direct("my-openai")).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("works from an EMPTY snapshot — the org that had no providers at dispatch", async () => {
    const refresh = vi.fn().mockResolvedValue([OPENAI]);
    const reg = new ByoProviderRegistry([], refresh);
    expect(await reg.direct("my-openai")).toEqual(OPENAI);
  });

  it("without a refresh hook, a miss is just a miss", async () => {
    const reg = new ByoProviderRegistry([VLLM]);
    expect(await reg.direct("my-openai")).toBeNull();
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
      { registry: new ByoProviderRegistry([VLLM]), resolveSecret, fetchImpl },
      VLLM,
      { model: "qwen3", messages: [{ role: "user", content: "hi" }], tools: [] },
      (t) => deltas.push(t),
      undefined,
    );
    expect(resolveSecret).toHaveBeenCalledWith("VLLM_KEY");
    expect(out.modelRef).toBe("my-vllm/qwen3");
    expect(deltas.join("")).toBe("hello");
    // The call went to the ORG'S endpoint with the ORG'S key — no broker involved.
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://10.0.0.5:8000/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-org-own");
  });

  it("routes streamed reasoning to onReasoningDelta, separate from the answer text", async () => {
    const resolveSecret = vi.fn().mockResolvedValue("sk-org-own");
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          JSON.stringify({ choices: [{ delta: { reasoning: "thinking" } }] }),
          JSON.stringify({ choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] }),
        ]),
      );
    const deltas: string[] = [];
    const reasoning: string[] = [];
    const out = await streamDirectTurn(
      { registry: new ByoProviderRegistry([VLLM]), resolveSecret, fetchImpl },
      VLLM,
      { model: "qwen3", messages: [{ role: "user", content: "hi" }], tools: [] },
      (t) => deltas.push(t),
      (t) => reasoning.push(t),
    );
    expect(reasoning).toEqual(["thinking"]);
    expect(deltas).toEqual(["answer"]);
    expect(out.turn.text).toBe("answer");
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
        { registry: new ByoProviderRegistry([VLLM]), resolveSecret, fetchImpl },
        VLLM,
        { model: "qwen3", messages: [{ role: "user", content: "hi" }], tools: [] },
        undefined,
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
      { registry: new ByoProviderRegistry([entry]), resolveSecret, fetchImpl },
      entry,
      { model: "m", messages: [{ role: "user", content: "hi" }], tools: [] },
      undefined,
      undefined,
    );
    expect(resolveSecret).not.toHaveBeenCalled();
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });
});
