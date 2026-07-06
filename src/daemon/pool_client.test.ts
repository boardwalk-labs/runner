// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi } from "vitest";
import { PoolClient, PoolClientError } from "./pool_client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const REGISTRATION = {
  runner_id: "01H_runner",
  pool: "default",
  runner_token: "bwkr_raw",
  poll: { url: "https://api.example/runner/v1/pool/poll", interval_seconds: 5 },
};

describe("PoolClient", () => {
  it("register posts the token and parses the response (no auth header)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, REGISTRATION));
    const client = new PoolClient({ baseUrl: "https://api.example/", fetchImpl });
    const res = await client.register({
      registration_token: "bwkreg_raw",
      name: "mbp",
      labels: [],
    });
    expect(res.runner_id).toBe("01H_runner");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example/runner/v1/register");
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("poll sends the bearer and validates the shape", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { assignment: null }));
    const client = new PoolClient({
      baseUrl: "https://api.example",
      runnerToken: "bwkr_raw",
      fetchImpl,
    });
    expect(await client.poll()).toEqual({ assignment: null });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer bwkr_raw");
  });

  it("claim returns null on 409 (another runner won)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("conflict", { status: 409 }));
    const client = new PoolClient({
      baseUrl: "https://api.example",
      runnerToken: "t",
      fetchImpl,
    });
    expect(await client.claim("01H_assignment")).toBeNull();
  });

  it("heartbeat returns null on 409 (lease lost)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("gone", { status: 409 }));
    const client = new PoolClient({
      baseUrl: "https://api.example",
      runnerToken: "t",
      fetchImpl,
    });
    expect(await client.heartbeat("l", "r", "running")).toBeNull();
  });

  it("throws PoolClientError with status + operation on other failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    const client = new PoolClient({
      baseUrl: "https://api.example",
      runnerToken: "t",
      fetchImpl,
    });
    await expect(client.poll()).rejects.toSatisfy(
      (e: unknown) => e instanceof PoolClientError && e.status === 401 && e.operation === "poll",
    );
  });

  it("rejects a malformed contract payload", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { assignment: { nope: 1 } }));
    const client = new PoolClient({
      baseUrl: "https://api.example",
      runnerToken: "t",
      fetchImpl,
    });
    await expect(client.poll()).rejects.toThrow(/Invalid poll response/);
  });
});
