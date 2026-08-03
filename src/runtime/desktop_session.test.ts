// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { ArtifactRef } from "@boardwalk-labs/workflow/runtime";
import { AppError } from "./support/index.js";
import type { DesktopDriver } from "./desktop_driver.js";
import { DesktopSessionManager, type DesktopSessionManagerDeps } from "./desktop_session.js";

const REF: ArtifactRef = { id: "art_1", name: "shot.png", url: "https://cdn/shot.png" };

function makeDeps(over: Partial<DesktopSessionManagerDeps> = {}): DesktopSessionManagerDeps {
  let n = 0;
  const driver: DesktopDriver = {
    screenshot: vi.fn().mockResolvedValue({ png: Buffer.from("pixels"), width: 1280, height: 800 }),
    click: vi.fn(),
    type: vi.fn(),
    key: vi.fn(),
    scroll: vi.fn(),
    drag: vi.fn(),
  };
  return {
    driver,
    writeArtifact: vi.fn().mockResolvedValue(REF),
    nextId: () => `desk_${String(++n)}`,
    ...over,
  };
}

describe("DesktopSessionManager", () => {
  it("opens at most one session; a second open errors; reopen after close works", () => {
    const mgr = new DesktopSessionManager(makeDeps());
    const first = mgr.open();
    expect(first.id).toBe("desk_1");
    expect(() => mgr.open()).toThrow(/already open/);
    void first.close();
    expect(mgr.open().id).toBe("desk_2");
  });

  it('rejects grounding values other than "auto"/"none" with the hint', () => {
    const mgr = new DesktopSessionManager(makeDeps());
    try {
      mgr.open({ grounding: "a11y" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect(err instanceof AppError ? err.message : "").toContain('"a11y" is invalid');
    }
    expect(mgr.open({ grounding: "none" }).id).toBe("desk_1");
  });

  it("program-side screenshot stores the artifact and returns its ref", async () => {
    const deps = makeDeps();
    const mgr = new DesktopSessionManager(deps);
    const session = mgr.open();
    await expect(session.screenshot()).resolves.toEqual(REF);
    expect(deps.writeArtifact).toHaveBeenCalledWith(
      expect.stringMatching(/^screenshot-desk_1-/),
      "image/png",
      Buffer.from("pixels").toString("base64"),
      { kind: "screenshot", session_id: "desk_1" },
    );
  });

  it("a closed handle refuses further screenshots", async () => {
    const mgr = new DesktopSessionManager(makeDeps());
    const session = mgr.open();
    await session.close();
    await expect(session.screenshot()).rejects.toThrow(/closed/);
  });

  it("driverFor resolves only the live session", () => {
    const deps = makeDeps();
    const mgr = new DesktopSessionManager(deps);
    const session = mgr.open();
    expect(mgr.driverFor(session)).toBe(deps.driver);
    expect(mgr.driverFor({ id: "desk_999" })).toBeNull();
    void session.close();
    expect(mgr.driverFor(session)).toBeNull();
  });

  it("captureForAgent dual-sinks: base64 + artifact ref", async () => {
    const mgr = new DesktopSessionManager(makeDeps());
    const session = mgr.open();
    await expect(mgr.captureForAgent(session.id)).resolves.toEqual({
      data: Buffer.from("pixels").toString("base64"),
      width: 1280,
      height: 800,
      artifact: REF,
    });
  });

  it("captureForAgent still serves the model when the artifact store fails (warn, no artifact)", async () => {
    const warn = vi.fn();
    const mgr = new DesktopSessionManager(
      makeDeps({ writeArtifact: vi.fn().mockRejectedValue(new Error("store down")), warn }),
    );
    const session = mgr.open();
    const shot = await mgr.captureForAgent(session.id);
    expect(shot.artifact).toBeUndefined();
    expect(shot.data.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledWith(
      "desktop_screenshot_artifact_failed",
      expect.objectContaining({ sessionId: "desk_1" }),
    );
  });

  it("closeAll reaps the open session and is a no-op when none", async () => {
    const mgr = new DesktopSessionManager(makeDeps());
    await expect(mgr.closeAll()).resolves.toBeUndefined();
    const session = mgr.open();
    await mgr.closeAll();
    await expect(session.screenshot()).rejects.toThrow(/closed/);
  });
});
