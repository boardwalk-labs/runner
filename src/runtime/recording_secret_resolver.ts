// RecordingSecretResolver — the redaction feeder (the platform spec, plan #9).
//
// Decorates any SecretResolver so EVERY value a run resolves — whether the workflow program asked
// via `secrets.get(name)` or a tool asked via `ctx.secrets.resolve(ref)` — is recorded into the
// run's SecretRedactor. The leaf executor then scrubs those known values out of all LLM-bound
// content. Wrapping at the resolver level means there is exactly one chokepoint: a value cannot be
// resolved without becoming redactable.
//
// A failed resolve (FORBIDDEN/NOT_FOUND) records nothing — the error propagates unchanged.

import type { SecretRefManifest } from "./wire/manifest.js";
import type { SecretResolver } from "./tools/types.js";
import type { SecretRedactor } from "./agent/secret_redactor.js";

export class RecordingSecretResolver implements SecretResolver {
  constructor(
    private readonly inner: SecretResolver,
    private readonly redactor: SecretRedactor,
  ) {}

  async resolve(ref: SecretRefManifest): Promise<string> {
    const value = await this.inner.resolve(ref);
    this.redactor.record(value);
    return value;
  }
}
