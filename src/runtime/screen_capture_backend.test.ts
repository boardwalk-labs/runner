import { describe, it, expect } from "vitest";
import { ffmpegArgs, loadCaptureConfig, type CaptureConfig } from "./screen_capture_backend.js";

const cfg: CaptureConfig = {
  display: ":0",
  fps: 6,
  width: 1280,
  height: 800,
  segmentSeconds: 240,
  liveFrameIntervalMs: 1000,
  wantedPollIntervalMs: 3000,
};

describe("ffmpegArgs", () => {
  it("grabs the configured x11 display at the configured size + framerate", () => {
    const a = ffmpegArgs(cfg, "/out");
    expect(a).toContain("x11grab");
    expect(a[a.indexOf("-framerate") + 1]).toBe("6");
    expect(a[a.indexOf("-video_size") + 1]).toBe("1280x800");
    expect(a[a.indexOf("-i") + 1]).toBe(":0");
  });

  it("records change-driven: mpdecimate + fps_mode vfr on the RECORDING output", () => {
    const a = ffmpegArgs(cfg, "/out");
    // The filter + VFR must ride the recording branch so a static desktop encodes ~nothing.
    expect(a.join(" ")).toContain("-vf mpdecimate -fps_mode vfr");
    const vf = a.indexOf("-vf");
    const mp4 = a.findIndex((x) => x.endsWith("rec-%05d.mp4"));
    const jpg = a.findIndex((x) => x.endsWith("live.jpg"));
    expect(mp4).toBeGreaterThan(-1);
    expect(jpg).toBeGreaterThan(mp4); // live-JPEG output comes after the recording output
    expect(vf).toBeGreaterThan(-1);
    expect(vf).toBeLessThan(mp4); // the decimate filter belongs to the recording, not the JPEG
  });

  it("keeps the veryfast H.264 segments + the single overwritten live JPEG", () => {
    const a = ffmpegArgs(cfg, "/out");
    expect(a[a.indexOf("-preset") + 1]).toBe("veryfast");
    expect(a).toContain("libx264");
    expect(a[a.indexOf("-segment_format") + 1]).toBe("mp4");
    expect(a).toContain("-update"); // one continuously-overwritten live frame
  });
});

describe("loadCaptureConfig", () => {
  it("is null without the desktop tier (BOARDWALK_BROWSER_TIER !== '1')", () => {
    expect(loadCaptureConfig({})).toBeNull();
  });

  it("is null when the recording kill switch is set", () => {
    expect(
      loadCaptureConfig({ BOARDWALK_BROWSER_TIER: "1", BOARDWALK_RECORDING_ENABLED: "0" }),
    ).toBeNull();
  });

  it("defaults to 6fps / 1280x800 when the desktop tier is present", () => {
    const c = loadCaptureConfig({ BOARDWALK_BROWSER_TIER: "1" });
    expect(c).not.toBeNull();
    expect(c?.fps).toBe(6);
    expect(c?.width).toBe(1280);
    expect(c?.height).toBe(800);
  });

  // The worker resolves capture config from a snapshot of the platform BOOT env taken BEFORE the
  // identity relay overlays the run's author `meta.env` (index.ts `main`). This asserts the property
  // that makes that matter: recording is decided by WHICH env is passed, so reading the trusted
  // pre-overlay snapshot keeps a `BOARDWALK_RECORDING_ENABLED=0` in a run's `meta.env` inert.
  it("honors only the env it is given — the author overlay is inert against the boot snapshot", () => {
    const bootEnv = { BOARDWALK_BROWSER_TIER: "1", DISPLAY: ":0" }; // image-baked platform env
    const bootSnapshot = { ...bootEnv }; // what the worker captures before the relay overlays meta.env
    const authorOverlaid = { ...bootEnv, BOARDWALK_RECORDING_ENABLED: "0" }; // author opts out

    expect(loadCaptureConfig(bootSnapshot)).not.toBeNull(); // recording stays ON (trusted snapshot)
    expect(loadCaptureConfig(authorOverlaid)).toBeNull(); // the author value WOULD disable it if read live
  });
});
