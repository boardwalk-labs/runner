import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ScreenCapture,
  type CaptureBackend,
  type CaptureSegment,
  type CaptureSession,
  type ScreenCaptureDeps,
  type SegmentArtifactWriter,
} from "./screen_capture.js";

function fakeSegment(over: Partial<CaptureSegment> = {}) {
  const readFn = vi.fn<() => Promise<string>>(() => Promise.resolve("SEGMENT_BYTES_B64"));
  const discardFn = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const segment: CaptureSegment = {
    read: readFn,
    discard: discardFn,
    startedAtMs: 1000,
    endedAtMs: 2000,
    ...over,
  };
  return { segment, readFn, discardFn };
}

function fakeBackend(over: Partial<CaptureBackend> = {}) {
  let segCb: ((s: CaptureSegment) => void) | null = null;
  const latestFrameFn = vi.fn<() => Promise<string | null>>(() => Promise.resolve("FRAME_B64"));
  const stopFn = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const session: CaptureSession = {
    onSegment: (cb) => {
      segCb = cb;
    },
    latestFrame: latestFrameFn,
    stop: stopFn,
  };
  const startFn = vi.fn<() => Promise<CaptureSession>>(() => Promise.resolve(session));
  const backend: CaptureBackend = {
    width: 1280,
    height: 800,
    liveFrameIntervalMs: 1000,
    wantedPollIntervalMs: 3000,
    start: startFn,
    ...over,
  };
  return {
    backend,
    emitSegment: (s: CaptureSegment) => segCb?.(s),
    latestFrameFn,
    stopFn,
    startFn,
  };
}

function makeDeps(over: Partial<ScreenCaptureDeps> = {}): ScreenCaptureDeps {
  const { backend } = fakeBackend();
  return {
    backend,
    writeArtifact: vi.fn(() => Promise.resolve({ id: "art_1" })),
    publishLiveFrames: vi.fn(() => Promise.resolve()),
    liveViewWanted: vi.fn(() => Promise.resolve(false)),
    now: () => 5000,
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("ScreenCapture — recording segments", () => {
  it("uploads a completed segment as a recording-segment artifact, then discards it", async () => {
    const fb = fakeBackend();
    const writeArtifact = vi.fn(() => Promise.resolve({ id: "art_1" }));
    const cap = new ScreenCapture({ ...makeDeps(), backend: fb.backend, writeArtifact });
    await cap.start();
    const { segment, discardFn } = fakeSegment({ startedAtMs: 1000, endedAtMs: 2000 });
    fb.emitSegment(segment);
    await cap.stopAndFlush(); // drains the upload tail

    expect(writeArtifact).toHaveBeenCalledTimes(1);
    expect(writeArtifact).toHaveBeenCalledWith(
      "recording-00000.mp4",
      "video/mp4",
      "SEGMENT_BYTES_B64",
      {
        kind: "recording-segment",
        segment_index: 0,
        wall_start: 1000,
        wall_end: 2000,
        width: 1280,
        height: 800,
      },
    );
    // Bytes are discarded from guest disk after upload.
    expect(discardFn).toHaveBeenCalledTimes(1);
  });

  it("indexes segments monotonically across a suspend/resume (start → flush → startFresh)", async () => {
    const fb = fakeBackend();
    const writeArtifact = vi.fn<SegmentArtifactWriter>(() => Promise.resolve({ id: "art" }));
    const cap = new ScreenCapture({ ...makeDeps(), backend: fb.backend, writeArtifact });

    await cap.start();
    fb.emitSegment(fakeSegment().segment);
    await cap.stopAndFlush();

    await cap.startFresh(); // post-wake epoch, same monotonic index
    fb.emitSegment(fakeSegment().segment);
    await cap.stopAndFlush();

    expect(writeArtifact.mock.calls[0]?.[0]).toBe("recording-00000.mp4");
    expect(writeArtifact.mock.calls[0]?.[3]).toMatchObject({ segment_index: 0 });
    expect(writeArtifact.mock.calls[1]?.[0]).toBe("recording-00001.mp4");
    expect(writeArtifact.mock.calls[1]?.[3]).toMatchObject({ segment_index: 1 });
  });

  it("a failed upload never throws and still discards the segment (best-effort)", async () => {
    const fb = fakeBackend();
    const writeArtifact = vi.fn(() => Promise.reject(new Error("s3 down")));
    const cap = new ScreenCapture({ ...makeDeps(), backend: fb.backend, writeArtifact });
    await cap.start();
    const { segment, discardFn } = fakeSegment();
    fb.emitSegment(segment);
    await expect(cap.stopAndFlush()).resolves.toBeUndefined();
    expect(discardFn).toHaveBeenCalledTimes(1);
  });

  it("stopAndFlush stops the session and is a no-op when nothing is running", async () => {
    const fb = fakeBackend();
    const cap = new ScreenCapture({ ...makeDeps(), backend: fb.backend });
    await cap.start();
    await cap.stopAndFlush();
    expect(fb.stopFn).toHaveBeenCalledTimes(1);
    // Second flush with no active session does nothing (no throw, no extra stop).
    await cap.stopAndFlush();
    expect(fb.stopFn).toHaveBeenCalledTimes(1);
  });
});

describe("ScreenCapture — live-view push loop", () => {
  it("pushes the latest frame while a viewer is attached", async () => {
    vi.useFakeTimers();
    const fb = fakeBackend();
    const publishLiveFrames = vi.fn(() => Promise.resolve());
    const liveViewWanted = vi.fn(() => Promise.resolve(true));
    const cap = new ScreenCapture({
      ...makeDeps(),
      backend: fb.backend,
      publishLiveFrames,
      liveViewWanted,
    });
    await cap.start();
    await vi.advanceTimersByTimeAsync(1000); // one live tick

    expect(liveViewWanted).toHaveBeenCalled();
    expect(fb.latestFrameFn).toHaveBeenCalled();
    expect(publishLiveFrames).toHaveBeenCalledWith(["FRAME_B64"]);
    await cap.stopAndFlush();
  });

  it("does NOT push when no viewer is attached", async () => {
    vi.useFakeTimers();
    const fb = fakeBackend();
    const publishLiveFrames = vi.fn(() => Promise.resolve());
    const cap = new ScreenCapture({
      ...makeDeps(),
      backend: fb.backend,
      publishLiveFrames,
      liveViewWanted: () => Promise.resolve(false),
    });
    await cap.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(publishLiveFrames).not.toHaveBeenCalled();
    await cap.stopAndFlush();
  });

  it("stops pushing after stopAndFlush", async () => {
    vi.useFakeTimers();
    const fb = fakeBackend();
    const publishLiveFrames = vi.fn(() => Promise.resolve());
    const cap = new ScreenCapture({
      ...makeDeps(),
      backend: fb.backend,
      publishLiveFrames,
      liveViewWanted: () => Promise.resolve(true),
    });
    await cap.start();
    await cap.stopAndFlush();
    publishLiveFrames.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(publishLiveFrames).not.toHaveBeenCalled();
  });
});
