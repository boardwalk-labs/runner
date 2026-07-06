// SPDX-License-Identifier: Apache-2.0

// Content-addressed program verification (runner/CONTRACT.md invariant 3): the digest is
// checked BEFORE extraction; a mismatch aborts the run.

import { createHash } from "node:crypto";

export function verifyArtifactDigest(bytes: Uint8Array, expectedDigest: string): boolean {
  const actual = createHash("sha256").update(bytes).digest("hex");
  return actual === expectedDigest.toLowerCase();
}
