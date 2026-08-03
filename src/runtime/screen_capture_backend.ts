// The guest-coupled half of screen capture (screen_capture.ts's `CaptureBackend`): one ffmpeg reading
// the X display `:0` with three outputs — rolling MP4 segments (recording), a full-size low-fps JPEG
// that is continuously overwritten (live-view), and a separately scaled JPEG (run-list thumbnail).
// See docs/SCREEN_CAPTURE.md §4.
//
// The recording is CHANGE-DRIVEN (mpdecimate + VFR): it stays always-on but only encodes frames that
// differ from the previous one, so an idle/headless desktop encodes ~nothing (a blank desktop collapses
// to ~1 frame) while a changing screen records in full. This keeps the always-on desktop cheap enough
// to run on every VM without a "record only when watched" gate.
//
// Only runs where the runner IMAGE ships the desktop stack (Xvfb + ffmpeg), gated by
// BOARDWALK_BROWSER_TIER=1 (the same "desktop present" signal the browser tier uses) + a
// BOARDWALK_RECORDING_ENABLED kill switch (default on). Off on Fargate / self-hosted images with no
// display, where `loadCaptureConfig` returns null and no capture is constructed.
//
// This layer is validated by a local ffmpeg smoke + the substrate E2E (it needs a real X display), the
// same way browser_session_backend.ts is — the unit tests cover screen_capture.ts's pure orchestration.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, open, readdir, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserTierEnabled } from "./browser_session_backend.js";
import { desktopTierEnabled } from "./desktop_driver.js";
import type { CaptureBackend, CaptureSegment, CaptureSession } from "./screen_capture.js";
import { createLogger } from "./support/index.js";

const log = createLogger("screen_capture_backend");

export interface CaptureConfig {
  /** X display to grab (DISPLAY, default ":0"). */
  display: string;
  /** Recording capture frame rate (fps). */
  fps: number;
  /** Screen dimensions (must match the ambient desktop — SCREEN_CAPTURE §1.3). */
  width: number;
  height: number;
  /** Recording segment roll interval (seconds). A suspend/resume also forces a boundary. */
  segmentSeconds: number;
  /** Live-view push cadence (ms) — how often the latest frame is pushed while a viewer is attached. */
  liveFrameIntervalMs: number;
  /** How often (ms) the capture polls the broker for viewer presence. */
  wantedPollIntervalMs: number;
  /** Longest (ms) a viewer goes without a frame while the screen is unchanged. */
  liveKeepaliveMs: number;
}

const SEGMENT_PREFIX = "rec-";
const LIVE_FRAME_FILE = "live.jpg";
const THUMBNAIL_FRAME_FILE = "thumbnail.jpg";
export const DESKTOP_THUMBNAIL_WIDTH = 320;
export const DESKTOP_THUMBNAIL_HEIGHT = 200;
/** JPEG end-of-image marker — a complete frame ends with these bytes; used to skip a torn read. */
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

function intFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Read the capture config from env, or null when the desktop stack is absent or recording is off. */
export function loadCaptureConfig(env: NodeJS.ProcessEnv): CaptureConfig | null {
  // Desktop-present: either tier implies a display to grab (a macOS/Windows self-hosted runner may
  // one day set only the desktop tier). Neither ⇒ nothing to capture.
  if (!browserTierEnabled(env) && !desktopTierEnabled(env)) return null;
  // Kill switch (default on): BOARDWALK_RECORDING_ENABLED=0 disables recording + live-view capture.
  if (env.BOARDWALK_RECORDING_ENABLED === "0") return null;
  return {
    display: env.DISPLAY?.trim() || ":0",
    fps: intFromEnv(env.BOARDWALK_RECORDING_FPS, 6),
    width: intFromEnv(env.BOARDWALK_SCREEN_WIDTH, 1280),
    height: intFromEnv(env.BOARDWALK_SCREEN_HEIGHT, 800),
    segmentSeconds: intFromEnv(env.BOARDWALK_RECORDING_SEGMENT_SECONDS, 240),
    // ~3 fps. 1 fps read as a slideshow — a cursor teleports and a page load is never seen happening
    // — and it was only that low because every tick paid full price. Now that identical frames are
    // suppressed, a still desktop costs nothing at any cadence and this spends only on real motion.
    // Deliberately a touch faster than the 3 fps the encoder writes below, so the loop never lags the
    // producer; the duplicate reads that oversampling causes are exactly what the dedupe absorbs.
    liveFrameIntervalMs: intFromEnv(env.BOARDWALK_LIVEVIEW_FRAME_INTERVAL_MS, 300),
    wantedPollIntervalMs: intFromEnv(env.BOARDWALK_LIVEVIEW_WANTED_POLL_MS, 3000),
    liveKeepaliveMs: intFromEnv(env.BOARDWALK_LIVEVIEW_KEEPALIVE_MS, 10_000),
  };
}

/** ffmpeg args: one x11grab input, three outputs (change-driven segmented MP4 + full-size and
 *  bandwidth-bounded overwritten JPEGs). Exported for unit testing. */
export function ffmpegArgs(cfg: CaptureConfig, dir: string): string[] {
  const liveFps = Math.max(1, Math.round(1000 / cfg.liveFrameIntervalMs));
  return [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "x11grab",
    "-framerate",
    String(cfg.fps),
    "-video_size",
    `${String(cfg.width)}x${String(cfg.height)}`,
    "-i",
    cfg.display,
    // Recording: H.264 MP4 segments, each a standalone playable file (docs/SCREEN_CAPTURE.md §4.2).
    // Change-driven: `mpdecimate` drops near-duplicate frames and `-fps_mode vfr` lets the muxer honor
    // those drops, so a static/idle desktop encodes ~nothing (collapses to ~1 frame) while a changing
    // screen still records in full. Always-on — cost tracks on-screen activity, not a flat framerate.
    // (`-preset ultrafast` would cut per-frame CPU further on busy screens but inflates file size; kept
    //  `veryfast` so the change is a pure win with no storage/bandwidth regression.)
    "-map",
    "0:v",
    "-vf",
    "mpdecimate",
    "-fps_mode",
    "vfr",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "28",
    "-pix_fmt",
    "yuv420p",
    // No B-frames: x264's reorder delay is two FRAME DURATIONS of dts offset, and under VFR the
    // first frame's duration is the whole leading idle stretch — `-reset_timestamps 1` re-zeroes on
    // that dts, shifting every segment up by it, so players saw a frameless void (black/gray, and
    // unseekable in Safari/Chrome) as long as the pre-activity idle. dts==pts keeps segments at 0.
    "-bf",
    "0",
    "-g",
    String(cfg.fps * 2),
    "-f",
    "segment",
    "-segment_time",
    String(cfg.segmentSeconds),
    "-reset_timestamps",
    "1",
    "-segment_format",
    "mp4",
    join(dir, `${SEGMENT_PREFIX}%05d.mp4`),
    // Live-view: a single low-fps JPEG, continuously overwritten (the latest frame).
    "-map",
    "0:v",
    "-r",
    String(liveFps),
    "-q:v",
    "6",
    "-update",
    "1",
    join(dir, LIVE_FRAME_FILE),
    // Run-list thumbnail: separately scaled so a 100-row page never downloads full desktop frames.
    "-map",
    "0:v",
    "-vf",
    `scale=${String(DESKTOP_THUMBNAIL_WIDTH)}:${String(DESKTOP_THUMBNAIL_HEIGHT)}`,
    "-r",
    "1",
    "-q:v",
    "8",
    "-update",
    "1",
    join(dir, THUMBNAIL_FRAME_FILE),
  ];
}

/** The recording-segment index from a `rec-00007.mp4` filename, or null if it doesn't match. */
function segmentIndexOf(name: string): number | null {
  const m = /^rec-(\d+)\.mp4$/.exec(name);
  if (m === null || m[1] === undefined) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function segmentPath(dir: string, index: number): string {
  return join(dir, `${SEGMENT_PREFIX}${String(index).padStart(5, "0")}.mp4`);
}

/** Bytes of an MP4 to inspect for the payload check. ffmpeg writes `ftyp`/`free`/`mdat` at the very
 *  head (no faststart, so `moov` lands last), which puts every box header we read inside 100 bytes. */
const MP4_HEAD_BYTES = 4096;

/**
 * True when an MP4 head positively shows an `mdat` box carrying NO payload — the shape ffmpeg leaves
 * when it is stopped before encoding a single frame: `ftyp` + an 8-byte (header-only) `mdat` + a `moov`
 * holding no track at all, 262 bytes in all. No player can open that file.
 *
 * Deliberately conservative: a missing `mdat`, a walk that runs past the head, a `size === 0` box (runs
 * to EOF) or any malformed length answers false. Dropping a real segment is worse than uploading an odd
 * one, so only the husk we can PROVE empty is rejected. Pure — exported for unit tests.
 */
export function mp4HasEmptyMdat(head: Buffer): boolean {
  let offset = 0;
  while (offset + 8 <= head.length) {
    const declared = head.readUInt32BE(offset);
    const type = head.toString("latin1", offset + 4, offset + 8);
    let headerBytes = 8;
    let size = declared;
    if (declared === 1) {
      // A 64-bit `largesize` follows the type — a box that big plainly carries payload.
      if (offset + 16 > head.length) return false;
      headerBytes = 16;
      size = Number(head.readBigUInt64BE(offset + 8));
    }
    if (type === "mdat") return declared !== 0 && size === headerBytes;
    if (size < headerBytes) return false;
    offset += size;
  }
  return false;
}

/** Read a finalized segment's head and answer whether it is the frameless husk. Unreadable answers
 *  false (see {@link mp4HasEmptyMdat} — only a proven-empty file is dropped). */
export async function isFramelessSegment(path: string): Promise<boolean> {
  try {
    const file = await open(path, "r");
    try {
      const buf = Buffer.alloc(MP4_HEAD_BYTES);
      const { bytesRead } = await file.read(buf, 0, MP4_HEAD_BYTES, 0);
      return mp4HasEmptyMdat(buf.subarray(0, bytesRead));
    } finally {
      await file.close();
    }
  } catch {
    return false;
  }
}

export function makeCaptureBackend(cfg: CaptureConfig): CaptureBackend {
  return {
    width: cfg.width,
    height: cfg.height,
    thumbnailWidth: DESKTOP_THUMBNAIL_WIDTH,
    thumbnailHeight: DESKTOP_THUMBNAIL_HEIGHT,
    liveFrameIntervalMs: cfg.liveFrameIntervalMs,
    wantedPollIntervalMs: cfg.wantedPollIntervalMs,
    liveKeepaliveMs: cfg.liveKeepaliveMs,
    async start(): Promise<CaptureSession> {
      const dir = await mkdtemp(join(tmpdir(), "bw-capture-"));
      const proc = spawn("ffmpeg", ffmpegArgs(cfg, dir), {
        stdio: ["ignore", "ignore", "inherit"],
      });
      proc.once("error", (err) => log.error("ffmpeg_spawn_error", { error: err.message }));

      let onSegmentCb: ((segment: CaptureSegment) => void) | null = null;
      const emitted = new Set<number>();
      // A ffmpeg segment is COMPLETE once the next-index file exists (or once ffmpeg exits). Poll the
      // dir and emit every rec file below the current highest index that hasn't been emitted yet.
      let lastEmitAtMs = Date.now();

      const makeSegment = (index: number): CaptureSegment => {
        const path = segmentPath(dir, index);
        const startedAtMs = lastEmitAtMs;
        const endedAtMs = Date.now();
        lastEmitAtMs = endedAtMs;
        return {
          startedAtMs,
          endedAtMs,
          read: async () => (await readFile(path)).toString("base64"),
          discard: () => unlink(path).catch(() => undefined),
        };
      };

      const sweep = async (includeHighest: boolean): Promise<void> => {
        let names: string[];
        try {
          names = await readdir(dir);
        } catch {
          return;
        }
        const indices = names
          .map(segmentIndexOf)
          .filter((n): n is number => n !== null)
          .sort((a, b) => a - b);
        if (indices.length === 0) return;
        const highest = indices[indices.length - 1] ?? 0;
        for (const index of indices) {
          // While running, the highest-index file is still being written — hold it back until the next
          // one appears (or until stop, when `includeHighest` releases it).
          if (!includeHighest && index === highest) continue;
          if (emitted.has(index)) continue;
          emitted.add(index);
          // An epoch that ends before ffmpeg encodes one frame — a sub-second post-wake stretch, where
          // the program returns a breath after the resume — leaves a trackless husk. Committing it puts
          // a page in the run's screen pager that no player can open, so it never becomes a segment:
          // the last COMMITTED segment is always playable (SCREEN_CAPTURE §4.3).
          const path = segmentPath(dir, index);
          if (await isFramelessSegment(path)) {
            log.debug("recording_segment_frameless_skipped", { index });
            await unlink(path).catch(() => undefined);
            continue;
          }
          onSegmentCb?.(makeSegment(index));
        }
      };

      const poll = setInterval(() => void sweep(false), 2000);
      poll.unref();

      return {
        onSegment(cb): void {
          onSegmentCb = cb;
        },
        async latestFrame(): Promise<string | null> {
          try {
            const bytes = await readFile(join(dir, LIVE_FRAME_FILE));
            // Skip a torn read (ffmpeg mid-overwrite) — a complete JPEG ends with the EOI marker.
            if (bytes.length < 2 || !bytes.subarray(-2).equals(JPEG_EOI)) return null;
            return bytes.toString("base64");
          } catch {
            return null;
          }
        },
        async latestThumbnail(): Promise<string | null> {
          try {
            const bytes = await readFile(join(dir, THUMBNAIL_FRAME_FILE));
            if (bytes.length < 2 || !bytes.subarray(-2).equals(JPEG_EOI)) return null;
            return bytes.toString("base64");
          } catch {
            return null;
          }
        },
        async stop(): Promise<void> {
          clearInterval(poll);
          await stopFfmpeg(proc);
          // ffmpeg finalized the in-flight segment and JPEG outputs on exit — release every remaining
          // segment. The live frame is no longer needed; keep the thumbnail readable until the
          // orchestrator persists the terminal frame immediately after stop().
          await sweep(true);
          await rm(join(dir, LIVE_FRAME_FILE)).catch(() => undefined);
          // The dir itself is removed after uploads discard the segment files; a best-effort rm here
          // clears the retained thumbnail and anything else left without blocking.
          setTimeout(
            () => void rm(dir, { recursive: true, force: true }).catch(() => undefined),
            30_000,
          ).unref();
        },
      };
    },
  };
}

/** SIGINT ffmpeg so it flushes the current segment's moov atom, then wait (bounded) for it to exit. */
async function stopFfmpeg(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(kill);
      resolve();
    };
    proc.once("exit", done);
    proc.kill("SIGINT");
    // If ffmpeg doesn't exit promptly, SIGKILL it (the last segment may be lost — acceptable).
    const kill = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 5000);
    kill.unref();
  });
}
