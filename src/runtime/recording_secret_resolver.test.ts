import { describe, it, expect } from "vitest";
import { AppError, ErrorCode } from "./support/index.js";
import { SecretRedactor } from "./agent/secret_redactor.js";
import type { SecretResolver } from "./tools/types.js";
import { RecordingSecretResolver } from "./recording_secret_resolver.js";

function innerReturning(value: string): SecretResolver {
  return { resolve: () => Promise.resolve(value) };
}

describe("RecordingSecretResolver", () => {
  it("returns the inner resolver's value verbatim", async () => {
    const redactor = new SecretRedactor();
    const r = new RecordingSecretResolver(innerReturning("sk-live-12345"), redactor);
    await expect(r.resolve({ name: "api_key" })).resolves.toBe("sk-live-12345");
  });

  it("records the resolved value so the redactor scrubs it afterwards", async () => {
    const redactor = new SecretRedactor();
    const r = new RecordingSecretResolver(innerReturning("topsecretvalue"), redactor);
    await r.resolve({ name: "api_key" });
    expect(redactor.size).toBe(1);
    expect(redactor.redactText("leak topsecretvalue end")).toBe("leak [REDACTED] end");
  });

  it("records nothing when the inner resolve fails (error propagates)", async () => {
    const redactor = new SecretRedactor();
    const failing: SecretResolver = {
      resolve: () => Promise.reject(new AppError(ErrorCode.NOT_FOUND, "no such secret")),
    };
    const r = new RecordingSecretResolver(failing, redactor);
    await expect(r.resolve({ name: "missing" })).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
    expect(redactor.size).toBe(0);
  });

  it("feeds a shared redactor from multiple resolves", async () => {
    const redactor = new SecretRedactor();
    await new RecordingSecretResolver(innerReturning("first-secret"), redactor).resolve({
      name: "a",
    });
    await new RecordingSecretResolver(innerReturning("second-secret"), redactor).resolve({
      name: "b",
    });
    expect(redactor.size).toBe(2);
    expect(redactor.redactText("first-secret / second-secret")).toBe("[REDACTED] / [REDACTED]");
  });
});
