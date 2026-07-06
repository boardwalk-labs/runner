// SPDX-License-Identifier: Apache-2.0

// Persisted runner identity — the standing credential + coordinates a machine keeps between
// restarts (`runner start` after a reboot skips registration). One JSON file per
// (control plane, pool), mode 0600: the runner token is a credential.

import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { z } from "zod";

export const runnerIdentitySchema = z.strictObject({
  runner_id: z.string().min(1),
  runner_token: z.string().min(1),
  control_plane_url: z.string().url(),
  pool: z.string().min(1),
  /** Org slug, when known (the one-step CLI flow records it for display). */
  org: z.string().optional(),
  name: z.string().min(1),
  created_at: z.number().int().nonnegative(),
});
export type RunnerIdentity = z.infer<typeof runnerIdentitySchema>;

export function defaultIdentityDir(): string {
  return path.join(os.homedir(), ".boardwalk", "runner");
}

function identityFile(dir: string, controlPlaneUrl: string, pool: string): string {
  const host = new URL(controlPlaneUrl).host.replace(/[^A-Za-z0-9.-]/g, "_");
  return path.join(dir, `${host}--${pool}.json`);
}

export async function saveIdentity(dir: string, identity: RunnerIdentity): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = identityFile(dir, identity.control_plane_url, identity.pool);
  await writeFile(file, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export async function loadIdentity(
  dir: string,
  controlPlaneUrl: string,
  pool: string,
): Promise<RunnerIdentity | null> {
  try {
    const raw = await readFile(identityFile(dir, controlPlaneUrl, pool), "utf8");
    const parsed = runnerIdentitySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function removeIdentity(
  dir: string,
  controlPlaneUrl: string,
  pool: string,
): Promise<void> {
  await unlink(identityFile(dir, controlPlaneUrl, pool)).catch(() => undefined);
}
