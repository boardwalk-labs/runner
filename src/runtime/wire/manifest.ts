// SPDX-License-Identifier: Apache-2.0

// Manifest surface for the runtime: the schema itself is the SDK's (single source of truth);
// this module adds the few platform-side helpers the worker uses, ported from the backend's
// domain/models (keep in sync until the backend consumes this package).

import type { SecretRef, WorkflowManifest } from "@boardwalk-labs/workflow";

export { workflowManifestSchema } from "@boardwalk-labs/workflow";
export type { WorkflowManifest } from "@boardwalk-labs/workflow";

/** The manifest's zod-derived budget shape (matches the platform's `domain/models` alias). */
export type Budget = NonNullable<WorkflowManifest["budget"]>;

/** Pre-rename alias — runtime code (secret resolvers, tool context) imports this name. */
export type SecretRefManifest = SecretRef;

/** The ONLY supported interpolation: a whole-value `${{ secrets.NAME }}` reference. */
const SECRET_ENV_REF_RE = /^\$\{\{\s*secrets\.([A-Za-z0-9_-]+)\s*\}\}$/;

/** The secret name a whole-value `${{ secrets.NAME }}` env value references, or null. */
export function parseSecretEnvRef(value: string): string | null {
  return SECRET_ENV_REF_RE.exec(value.trim())?.[1] ?? null;
}

/**
 * The secret names a run may resolve — mirrors the broker's server-side allowlist
 * (`permissions.secrets` exactly; see the backend's domain/models/manifest.ts).
 */
export function effectiveSecretAllowlist(
  manifest: Pick<WorkflowManifest, "permissions">,
): { name: string }[] {
  const names = new Set<string>();
  for (const ref of manifest.permissions?.secrets ?? []) names.add(ref.name);
  return [...names].map((name) => ({ name }));
}
