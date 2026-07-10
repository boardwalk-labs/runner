// The guest-coupled half of screen capture (screen_capture.ts's `CaptureBackend`): one ffmpeg reading
// the X display `:0` with two outputs — rolling MP4 segments (recording) and a single low-fps JPEG that
// is continuously overwritten (the live-view frame). See docs/SCREEN_CAPTURE.md §4.
//
// Only runs where the runner IMAGE ships the desktop stack (Xvfb + ffmpeg), gated by
// BOARDWALK_BROWSER_TIER=1 (the same "desktop present" signal the browser tier uses) + a
// BOARDWALK_RECORDING_ENABLED kill switch (default on). Off on Fargate / self-hosted images with no
// display, where `loadCaptureConfig` returns null and no capture is constructed.
//
// This layer is validated by a local ffmpeg smoke + the substrate E2E (it needs a real X display), the
// same way browser_session_backend.ts is — the unit tests cover screen_capture.ts's pure orchestration.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserTierEnabled } from "./browser_session_backend.js";
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
}

const SEGMENT_PREFIX = "rec-";
const LIVE_FRAME_FILE = "live.jpg";
/** JPEG end-of-image marker — a complete frame ends with these bytes; used to skip a torn read. */
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

function intFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Read the capture config from env, or null when the desktop stack is absent or recording is off. */
export function loadCaptureConfig(env: NodeJS.ProcessEnv): CaptureConfig | null {
  // The desktop-present signal is the browser tier flag; without a display there is nothing to grab.
  if (!browserTierEnabled(env)) return null;
  // Kill switch (default on): BOARDWALK_RECORDING_ENABLED=0 disables recording + live-view capture.
  if (env.BOARDWALK_RECORDING_ENABLED === "0") return null;
  return {
    display: env.DISPLAY?.trim() || ":0",
    fps: intFromEnv(env.BOARDWALK_RECORDING_FPS, 6),
    width: intFromEnv(env.BOARDWALK_SCREEN_WIDTH, 1280),
    height: intFromEnv(env.BOARDWALK_SCREEN_HEIGHT, 800),
    segmentSeconds: intFromEnv(env.BOARDWALK_RECORDING_SEGMENT_SECONDS, 240),
    liveFrameIntervalMs: intFromEnv(env.BOARDWALK_LIVEVIEW_FRAME_INTERVAL_MS, 1000),
    wantedPollIntervalMs: intFromEnv(env.BOARDWALK_LIVEVIEW_WANTED_POLL_MS, 3000),
  };
}

/** ffmpeg args: one x11grab input, two outputs (segmented MP4 + a single overwritten JPEG). */
function ffmpegArgs(cfg: CaptureConfig, dir: string): string[] {
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
    "-map",
    "0:v",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "28",
    "-pix_fmt",
    "yuv420p",
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
  ];
}

/** The recording-segment index from a `rec-00007.mp4` filename, or null if it doesn't match. */
function segmentIndexOf(name: string): number | null {
  const m = /^rec-(\d+)\.mp4$/.exec(name);
  if (m === null || m[1] === undefined) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function makeCaptureBackend(cfg: CaptureConfig): CaptureBackend {
  return {
    width: cfg.width,
    height: cfg.height,
    liveFrameIntervalMs: cfg.liveFrameIntervalMs,
    wantedPollIntervalMs: cfg.wantedPollIntervalMs,
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
        const path = join(dir, `${SEGMENT_PREFIX}${String(index).padStart(5, "0")}.mp4`);
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
        async stop(): Promise<void> {
          clearInterval(poll);
          await stopFfmpeg(proc);
          // ffmpeg finalized the in-flight segment on exit — release every remaining segment, then
          // clean up the live frame + the scratch dir (segment files are discarded post-upload).
          await sweep(true);
          await rm(join(dir, LIVE_FRAME_FILE)).catch(() => undefined);
          // The dir itself is removed after uploads discard the segment files; a best-effort rm here
          // clears anything left (empty dir / an un-uploaded torn segment) without blocking.
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
