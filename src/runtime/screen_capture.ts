// Screen capture — the runtime backing for session recording + the desktop live-view feed
// (docs/SCREEN_CAPTURE.md §4, §5). ONE ffmpeg reads the guest display `:0` and produces three sinks:
//
//   1. Rolling fragmented-MP4 SEGMENTS → uploaded as `recording-segment` artifacts (the durable,
//      scrub-able recording / DVR). Each segment is a standalone playable MP4.
//   2. A low-fps LIVE frame (base64 JPEG) → pushed up the broker's live-view channel WHILE a viewer is
//      attached (lazy: the capture polls `liveViewWanted`, so a run with nobody watching pays nothing
//      beyond the always-on recording).
//   3. A separately scaled 320×200 JPEG → persisted as run-list thumbnail observability.
//
// The process spawn + segment file management live behind the injected `CaptureBackend` seam
// (screen_capture_backend.ts, guest-coupled: ffmpeg + fs), so this orchestration — segment upload
// sequencing, the lazy live loop, and the freeze-flush contract — is unit-tested without a guest.
//
// Suspend/resume (North Star): the recorder NEVER spans a snapshot. `stopAndFlush()` runs in the
// worker's pre-freeze hook (finalize + upload the in-flight segment, then the VM freezes); `startFresh()`
// runs post-wake (a new segment epoch). So a suspend/resume boundary is always a segment boundary, and
// no encoder ever wakes to a wall clock days ahead of its stream.

import { createLogger } from "./support/index.js";

const log = createLogger("screen_capture");

/** A completed recording segment surfaced by the backend (a rolled or finalized-on-stop MP4 file). */
export interface CaptureSegment {
  /** Read the segment's bytes as base64 (for the artifact upload). */
  read: () => Promise<string>;
  /** Delete the segment file after it's uploaded (bulk bytes stay off the snapshot + guest disk). */
  discard: () => Promise<void>;
  /** Wall-clock bounds of the captured span (best-effort, the backend's clock). */
  startedAtMs: number;
  endedAtMs: number;
}

/** A running capture: emits completed segments and exposes the latest live frame. */
export interface CaptureSession {
  /** Register the completed-segment callback (fires per rolled segment + the final one on stop). */
  onSegment: (cb: (segment: CaptureSegment) => void) => void;
  /** The most recent live frame (base64 JPEG), or null before the first frame is written. */
  latestFrame: () => Promise<string | null>;
  /** A small 16:10 JPEG for durable run-list thumbnails, or null before one is available. */
  latestThumbnail: () => Promise<string | null>;
  /** Stop ffmpeg and finalize + emit the last in-flight segment. The finalized thumbnail remains
   *  readable after this resolves so an ultrashort run can persist its first complete frame. */
  stop: () => Promise<void>;
}

/** The guest-coupled half: starts ffmpeg on the display. Production impl in screen_capture_backend.ts. */
export interface CaptureBackend {
  /** Pixel dimensions of the captured display — stamped into segment metadata. */
  readonly width: number;
  readonly height: number;
  /** Pixel dimensions of the separately encoded, bandwidth-bounded thumbnail frame. */
  readonly thumbnailWidth: number;
  readonly thumbnailHeight: number;
  /** Interval (ms) between live-frame pushes while a viewer is attached. */
  readonly liveFrameIntervalMs: number;
  /** How often (ms) to poll the broker for whether a viewer is attached. */
  readonly wantedPollIntervalMs: number;
  start: () => Promise<CaptureSession>;
}

/** Upload a recording segment as a run artifact (the broker holds the S3 credential). */
export type SegmentArtifactWriter = (
  name: string,
  contentType: string,
  base64: string,
  metadata: Record<string, unknown>,
) => Promise<{ id: string }>;

export interface ScreenCaptureDeps {
  backend: CaptureBackend;
  /** Store a completed segment as a `recording-segment` artifact. */
  writeArtifact: SegmentArtifactWriter;
  /** Push encoded live frames to the broker's live-view channel. */
  publishLiveFrames: (frames: string[]) => Promise<void>;
  /** Whether a browser is currently watching (gates the live push loop). */
  liveViewWanted: () => Promise<boolean>;
  /** Injected clock (deterministic in tests). */
  now: () => number;
  /** Bounds `stopAndFlush()` so a hung upload can't stall a suspend indefinitely. Default 20s. */
  flushTimeoutMs?: number;
}

const DEFAULT_FLUSH_TIMEOUT_MS = 20_000;
const INITIAL_THUMBNAIL_DELAY_MS = 5_000;

export class ScreenCapture {
  private session: CaptureSession | null = null;
  /** Monotonic across the whole run, so segments stay contiguous across suspend/resume epochs. */
  private segmentIndex = 0;
  /** Serializes segment uploads so `stopAndFlush()` can await the whole in-flight tail. */
  private uploadTail: Promise<void> = Promise.resolve();
  /** Serializes thumbnail reads so an initial timer racing a flush cannot land after the final frame. */
  private thumbnailCaptureTail: Promise<void> = Promise.resolve();
  private liveLoop: { stop: () => void } | null = null;
  private initialThumbnailTimer: ReturnType<typeof setTimeout> | null = null;
  /** The initial thumbnail is run-scoped, so a suspend/resume does not create another copy. */
  private initialThumbnailStored = false;

  constructor(private readonly deps: ScreenCaptureDeps) {}

  /** Begin capturing. Idempotent-safe: a second call while running is a no-op. */
  async start(): Promise<void> {
    if (this.session !== null) return;
    const session = await this.deps.backend.start();
    this.session = session;
    session.onSegment((segment) => this.enqueueSegment(segment));
    this.startLiveLoop(session);
    this.scheduleInitialThumbnail(session);
  }

  /** Post-wake: start a fresh capture (new segment files), keeping the monotonic segment index. */
  async startFresh(): Promise<void> {
    await this.start();
  }

  /**
   * Pre-freeze / terminal: stop capture, finalize + upload the in-flight segment, and drain the upload
   * tail — so the recorder never spans a snapshot and the last committed segment is always playable.
   * Bounded by `flushTimeoutMs` so a stuck upload delays (never blocks) the suspend. Safe to call with
   * no active session.
   */
  async stopAndFlush(): Promise<void> {
    const session = this.session;
    if (session === null) return;
    this.session = null;
    this.liveLoop?.stop();
    this.liveLoop = null;
    if (this.initialThumbnailTimer !== null) {
      clearTimeout(this.initialThumbnailTimer);
      this.initialThumbnailTimer = null;
    }

    const flush = (async (): Promise<void> => {
      try {
        await session.stop(); // finalizes the last segment → enqueued via onSegment
      } catch (err) {
        log.warn("screen_capture_stop_failed", { error: errMsg(err) });
      }
      // Read AFTER stop: an ultrashort run can finish before ffmpeg writes its first complete JPEG;
      // stopping finalizes that first frame. The backend keeps the thumbnail scratch file readable
      // until its delayed directory cleanup.
      await this.enqueueThumbnail(session, "flush");
      await this.uploadTail; // drain all queued segment uploads (incl. the final one)
    })();

    const timeoutMs = this.deps.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        log.warn("screen_capture_flush_timeout", { timeoutMs });
        resolve();
      }, timeoutMs);
    });
    try {
      await Promise.race([flush, bound]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Chain a segment upload onto the tail (serialized, best-effort). */
  private enqueueSegment(segment: CaptureSegment): void {
    const index = this.segmentIndex++;
    this.uploadTail = this.uploadTail.then(() => this.uploadSegment(segment, index));
  }

  private async uploadSegment(segment: CaptureSegment, index: number): Promise<void> {
    try {
      const base64 = await segment.read();
      await this.deps.writeArtifact(
        `recording-${String(index).padStart(5, "0")}.mp4`,
        "video/mp4",
        base64,
        {
          kind: "recording-segment",
          segment_index: index,
          wall_start: segment.startedAtMs,
          wall_end: segment.endedAtMs,
          width: this.deps.backend.width,
          height: this.deps.backend.height,
        },
      );
    } catch (err) {
      // Recording is observability, not a ledger: a dropped segment must never fail the run.
      log.warn("recording_segment_upload_failed", { index, error: errMsg(err) });
    } finally {
      await segment.discard().catch(() => undefined);
    }
  }

  /** Store one small representative desktop frame. Thumbnails are observability, so every failure
   *  is best-effort and joins the same serialized upload tail as recording segments. */
  private enqueueThumbnail(
    session: CaptureSession,
    capturePoint: "initial" | "flush",
  ): Promise<void> {
    this.thumbnailCaptureTail = this.thumbnailCaptureTail.then(() =>
      this.readAndEnqueueThumbnail(session, capturePoint),
    );
    return this.thumbnailCaptureTail;
  }

  private async readAndEnqueueThumbnail(
    session: CaptureSession,
    capturePoint: "initial" | "flush",
  ): Promise<void> {
    let base64: string | null;
    try {
      base64 = await session.latestThumbnail();
    } catch (err) {
      log.debug("desktop_thumbnail_read_failed", { error: errMsg(err) });
      return;
    }
    if (base64 === null || base64.length === 0) return;
    if (capturePoint === "initial") this.initialThumbnailStored = true;
    const capturedAt = this.deps.now();
    this.uploadTail = this.uploadTail.then(async () => {
      try {
        await this.deps.writeArtifact(
          `desktop-thumbnail-${String(capturedAt)}.jpg`,
          "image/jpeg",
          base64,
          {
            kind: "desktop-thumbnail",
            capture_point: capturePoint,
            captured_at: capturedAt,
            width: this.deps.backend.thumbnailWidth,
            height: this.deps.backend.thumbnailHeight,
          },
        );
      } catch (err) {
        log.debug("desktop_thumbnail_upload_failed", {
          capturePoint,
          error: errMsg(err),
        });
      }
    });
  }

  /** Give the desktop a moment to become representative, then make running rows visual without
   *  waiting for the first recording roll or terminal flush. */
  private scheduleInitialThumbnail(session: CaptureSession): void {
    if (this.initialThumbnailStored || this.initialThumbnailTimer !== null) return;
    this.initialThumbnailTimer = setTimeout(() => {
      this.initialThumbnailTimer = null;
      void this.enqueueThumbnail(session, "initial");
    }, INITIAL_THUMBNAIL_DELAY_MS);
    this.initialThumbnailTimer.unref();
  }

  /** Lazy live-view push: poll whether a viewer is attached; while attached, push the latest frame at
   *  the backend's cadence. Fully best-effort — a failed poll/push never disturbs the run. */
  private startLiveLoop(session: CaptureSession): void {
    let stopped = false;
    let wanted = false;
    let sincePollMs = Number.POSITIVE_INFINITY; // force a poll on the first tick
    const { liveFrameIntervalMs, wantedPollIntervalMs } = this.deps.backend;

    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        if (sincePollMs >= wantedPollIntervalMs) {
          wanted = await this.deps.liveViewWanted();
          sincePollMs = 0;
        }
        if (wanted) {
          const frame = await session.latestFrame();
          if (frame !== null && frame.length > 0) {
            await this.deps.publishLiveFrames([frame]);
          }
        }
      } catch (err) {
        log.debug("live_view_tick_failed", { error: errMsg(err) });
      }
      sincePollMs += liveFrameIntervalMs;
      if (!stopped) {
        timer = setTimeout(() => void tick(), liveFrameIntervalMs);
        timer.unref();
      }
    };

    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => void tick(),
      liveFrameIntervalMs,
    );
    timer.unref();
    this.liveLoop = {
      stop: () => {
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
      },
    };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
