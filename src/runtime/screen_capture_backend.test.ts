import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESKTOP_THUMBNAIL_HEIGHT,
  DESKTOP_THUMBNAIL_WIDTH,
  ffmpegArgs,
  isFramelessSegment,
  loadCaptureConfig,
  mp4HasEmptyMdat,
  type CaptureConfig,
} from "./screen_capture_backend.js";

const cfg: CaptureConfig = {
  display: ":0",
  fps: 6,
  width: 1280,
  height: 800,
  segmentSeconds: 240,
  liveFrameIntervalMs: 300,
  wantedPollIntervalMs: 3000,
  liveKeepaliveMs: 10_000,
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

  it("disables B-frames so a leading idle stretch can't shift segment timestamps", () => {
    const a = ffmpegArgs(cfg, "/out");
    // Under VFR the first frame's duration = the whole pre-activity idle; with B-frames that
    // becomes the dts offset reset_timestamps re-zeroes on, opening each segment with an
    // unseekable frameless void of that length.
    const bf = a.indexOf("-bf");
    expect(a[bf + 1]).toBe("0");
    const mp4 = a.findIndex((x) => x.endsWith("rec-%05d.mp4"));
    expect(bf).toBeGreaterThan(-1);
    expect(bf).toBeLessThan(mp4); // belongs to the recording output, not the JPEGs
  });

  it("keeps the veryfast H.264 segments + the single overwritten live JPEG", () => {
    const a = ffmpegArgs(cfg, "/out");
    expect(a[a.indexOf("-preset") + 1]).toBe("veryfast");
    expect(a).toContain("libx264");
    expect(a[a.indexOf("-segment_format") + 1]).toBe("mp4");
    expect(a).toContain("-update"); // one continuously-overwritten live frame
  });

  it("encodes a separate 320x200 JPEG so list thumbnails stay bandwidth-bounded", () => {
    const a = ffmpegArgs(cfg, "/out");
    const thumbnail = a.findIndex((x) => x.endsWith("thumbnail.jpg"));
    expect(thumbnail).toBeGreaterThan(-1);
    expect(a.join(" ")).toContain(
      `scale=${String(DESKTOP_THUMBNAIL_WIDTH)}:${String(DESKTOP_THUMBNAIL_HEIGHT)}`,
    );
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

  it("defaults the live push to ~3 fps, and the encoder's live output matches", () => {
    const c = loadCaptureConfig({ BOARDWALK_BROWSER_TIER: "1" });
    expect(c?.liveFrameIntervalMs).toBe(300);
    // The loop samples slightly faster than the encoder writes (3.33/s vs 3/s) so it never lags the
    // producer — dedupe absorbs the duplicate reads that causes.
    const args = ffmpegArgs(cfg, "/out");
    // The live output block is: -map 0:v -r <fps> -q:v 6 -update 1 <dir>/live.jpg
    const liveOut = args.indexOf("/out/live.jpg");
    expect(args[liveOut - 6]).toBe("-r");
    expect(args[liveOut - 5]).toBe("3");
  });

  it("lets an operator dial the live cadence back", () => {
    expect(
      loadCaptureConfig({
        BOARDWALK_BROWSER_TIER: "1",
        BOARDWALK_LIVEVIEW_FRAME_INTERVAL_MS: "1000",
      })?.liveFrameIntervalMs,
    ).toBe(1000);
  });

  it("defaults the live-view keepalive to 10s and takes an operator override", () => {
    expect(loadCaptureConfig({ BOARDWALK_BROWSER_TIER: "1" })?.liveKeepaliveMs).toBe(10_000);
    expect(
      loadCaptureConfig({ BOARDWALK_BROWSER_TIER: "1", BOARDWALK_LIVEVIEW_KEEPALIVE_MS: "4000" })
        ?.liveKeepaliveMs,
    ).toBe(4000);
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

/** One top-level MP4 box: a 32-bit size (header included), the 4-char type, then the payload. */
function box(type: string, payloadBytes: number): Buffer {
  const b = Buffer.alloc(8 + payloadBytes);
  b.writeUInt32BE(8 + payloadBytes, 0);
  b.write(type, 4, "latin1");
  return b;
}

describe("mp4HasEmptyMdat", () => {
  // The heads of the two segments of dev run 01KYGTENYW5Y3PAZW587058E2X, byte for byte: one real
  // recording, and the 262-byte husk its ~1s post-wake epoch produced (ftyp + header-only mdat + a moov
  // with no trak). The husk played as a black frame in the run view until it stopped being committed.
  const REAL_HEAD_HEX = "000000206674797069736f6d0000020069736f6d69736f32617663316d703431";
  const framelessHead = Buffer.from(`${REAL_HEAD_HEX}0000000866726565000000086d646174`, "hex");
  const recordedHead = Buffer.from(`${REAL_HEAD_HEX}000000086672656500040c0a6d646174`, "hex");

  it("catches the real frameless husk (header-only mdat)", () => {
    expect(mp4HasEmptyMdat(framelessHead)).toBe(true);
  });

  it("passes a real segment whose mdat carries frames", () => {
    expect(mp4HasEmptyMdat(recordedHead)).toBe(false);
  });

  it("passes a payload-bearing mdat that follows other boxes", () => {
    expect(
      mp4HasEmptyMdat(Buffer.concat([box("ftyp", 24), box("free", 0), box("mdat", 4096)])),
    ).toBe(false);
  });

  // Everything below is a file we cannot PROVE empty, so it stays a segment: dropping a real recording
  // is worse than committing an odd one (the run view explains a page it can't play).
  it("passes a head with no mdat at all", () => {
    expect(mp4HasEmptyMdat(Buffer.concat([box("ftyp", 24), box("moov", 64)]))).toBe(false);
  });

  it("passes an mdat sized to end-of-file (size 0), which the head cannot measure", () => {
    const eof = box("mdat", 0);
    eof.writeUInt32BE(0, 0);
    expect(mp4HasEmptyMdat(Buffer.concat([box("ftyp", 24), eof]))).toBe(false);
  });

  it("passes a 64-bit largesize mdat", () => {
    const large = Buffer.alloc(16);
    large.writeUInt32BE(1, 0);
    large.write("mdat", 4, "latin1");
    large.writeBigUInt64BE(5n * 1024n * 1024n * 1024n, 8);
    expect(mp4HasEmptyMdat(Buffer.concat([box("ftyp", 24), large]))).toBe(false);
  });

  it("passes a truncated or malformed head instead of walking off it", () => {
    expect(mp4HasEmptyMdat(Buffer.alloc(0))).toBe(false);
    expect(mp4HasEmptyMdat(Buffer.from("0000000466747970", "hex"))).toBe(false); // size < header
  });

  describe("isFramelessSegment (reads the file's head)", () => {
    let dir = "";
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "bw-capture-test-"));
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    async function file(name: string, bytes: Buffer): Promise<string> {
      const path = join(dir, name);
      await writeFile(path, bytes);
      return path;
    }

    it("rejects the husk and keeps a real recording", async () => {
      expect(await isFramelessSegment(await file("husk.mp4", framelessHead))).toBe(true);
      expect(await isFramelessSegment(await file("real.mp4", recordedHead))).toBe(false);
    });

    it("keeps a segment it cannot read (missing file, permissions) rather than dropping it", async () => {
      expect(await isFramelessSegment(join(dir, "absent.mp4"))).toBe(false);
      expect(await isFramelessSegment(await file("empty.mp4", Buffer.alloc(0)))).toBe(false);
    });
  });
});
