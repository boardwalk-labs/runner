// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, stat, chmod, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { saveIdentity, loadIdentity } from "./identity.js";

const IDENTITY = {
  runner_id: "01H_runner",
  runner_token: "bwkr_secret",
  control_plane_url: "https://api.example.com",
  pool: "default",
  name: "mbp",
  created_at: 1,
} as const;

const posix = process.platform !== "win32";

describe("identity file permissions", () => {
  it("round-trips save → load", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bw-id-"));
    const file = await saveIdentity(dir, { ...IDENTITY });
    const loaded = await loadIdentity(dir, IDENTITY.control_plane_url, IDENTITY.pool);
    expect(loaded?.runner_token).toBe("bwkr_secret");
    expect(path.dirname(file)).toBe(dir);
    await rm(dir, { recursive: true, force: true });
  });

  it.runIf(posix)("writes the file 0600 and the dir 0700", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bw-id-"));
    const file = await saveIdentity(dir, { ...IDENTITY });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    await rm(dir, { recursive: true, force: true });
  });

  it.runIf(posix)(
    "re-asserts 0600 over a pre-existing loosened file (writeFile mode only applies to a new file)",
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "bw-id-"));
      // Simulate a stale identity file left group/world-readable (bad umask, restored backup).
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, "api.example.com--default.json");
      await writeFile(file, "{}");
      await chmod(file, 0o644);
      expect((await stat(file)).mode & 0o777).toBe(0o644);
      // Saving over it must tighten the perms, not leave the credential world-readable.
      await saveIdentity(dir, { ...IDENTITY });
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      await rm(dir, { recursive: true, force: true });
    },
  );

  it.runIf(posix)("repairs loosened perms on load", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bw-id-"));
    const file = await saveIdentity(dir, { ...IDENTITY });
    await chmod(file, 0o644); // something loosened it after save
    await loadIdentity(dir, IDENTITY.control_plane_url, IDENTITY.pool);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await rm(dir, { recursive: true, force: true });
  });
});
