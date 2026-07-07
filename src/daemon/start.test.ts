// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi } from "vitest";
import {
  defaultImage,
  packageVersion,
  processSpawn,
  resolveSpawner,
  NoContainerRuntimeError,
} from "./start.js";

describe("packageVersion / defaultImage", () => {
  it("reads a concrete version and pins the image to it", () => {
    const v = packageVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
    expect(defaultImage()).toBe(`ghcr.io/boardwalk-labs/runner:${v}`);
  });
});

describe("resolveSpawner", () => {
  const noLog = (): void => undefined;

  it("host mode returns the raw process spawner (no runtime probe)", async () => {
    const detect = vi.fn();
    const spawner = await resolveSpawner({ mode: "host" }, noLog, detect as never);
    expect(spawner).toBe(processSpawn);
    expect(detect).not.toHaveBeenCalled();
  });

  it("container mode with no runtime throws (never silently unisolated)", async () => {
    await expect(
      resolveSpawner({ mode: "container" }, noLog, () => Promise.resolve(null)),
    ).rejects.toBeInstanceOf(NoContainerRuntimeError);
  });

  it("container mode with a runtime returns a container spawner", async () => {
    const spawner = await resolveSpawner(
      { mode: "container", image: "img:test", network: "bridge" },
      noLog,
      () => Promise.resolve("podman"),
    );
    // It's a distinct function from the process spawner (i.e. the container path was taken).
    expect(spawner).not.toBe(processSpawn);
    expect(typeof spawner).toBe("function");
  });
});
