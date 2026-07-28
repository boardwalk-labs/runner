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
  const latestThumbnailFn = vi.fn<() => Promise<string | null>>(() => Promise.resolve(null));
  const stopFn = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const session: CaptureSession = {
    onSegment: (cb) => {
      segCb = cb;
    },
    latestFrame: latestFrameFn,
    latestThumbnail: latestThumbnailFn,
    stop: stopFn,
  };
  const startFn = vi.fn<() => Promise<CaptureSession>>(() => Promise.resolve(session));
  const backend: CaptureBackend = {
    width: 1280,
    height: 800,
    thumbnailWidth: 320,
    thumbnailHeight: 200,
    liveFrameIntervalMs: 1000,
    wantedPollIntervalMs: 3000,
    liveKeepaliveMs: 10_000,
    start: startFn,
    ...over,
  };
  return {
    backend,
    emitSegment: (s: CaptureSegment) => segCb?.(s),
    latestFrameFn,
    latestThumbnailFn,
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

  // The runner's onAfterWake hook calls `void capture.startFresh()`, so a program that returns a breath
  // after its resume flushes WHILE the recorder is still spawning. The flush must join that start, or the
  // epoch's ffmpeg outlives the run: its segment never uploads and the process runs into teardown.
  it("a flush that lands mid-spawn waits for the start, then stops it and uploads its segment", async () => {
    const fb = fakeBackend();
    let releaseStart = (): void => undefined;
    const pending = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const session = await fb.backend.start(); // the fake's session, captured before start() goes slow
    fb.startFn.mockClear();
    fb.startFn.mockImplementation(async () => {
      await pending;
      return session;
    });
    // The real backend's stop() finalizes ffmpeg and sweeps the in-flight file out as a segment.
    const { segment } = fakeSegment();
    fb.stopFn.mockImplementation(() => {
      fb.emitSegment(segment);
      return Promise.resolve();
    });
    const writeArtifact = vi.fn<SegmentArtifactWriter>(() => Promise.resolve({ id: "art" }));
    const cap = new ScreenCapture({ ...makeDeps(), backend: fb.backend, writeArtifact });

    void cap.startFresh(); // fire-and-forget, exactly as onAfterWake does
    const flush = cap.stopAndFlush(); // the program already returned
    releaseStart();
    await flush;

    expect(fb.stopFn).toHaveBeenCalledTimes(1);
    expect(writeArtifact).toHaveBeenCalledTimes(1);
    expect(writeArtifact.mock.calls[0]?.[0]).toBe("recording-00000.mp4");
  });

  it("a second start while one is spawning joins it instead of racing a second recorder", async () => {
    const fb = fakeBackend();
    const cap = new ScreenCapture({ ...makeDeps(), backend: fb.backend });

    await Promise.all([cap.start(), cap.start(), cap.startFresh()]);

    expect(fb.startFn).toHaveBeenCalledTimes(1);
    await cap.stopAndFlush();
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

describe("ScreenCapture — desktop thumbnails", () => {
  it("stores an initial bandwidth-bounded thumbnail after the desktop settles", async () => {
    vi.useFakeTimers();
    const fb = fakeBackend();
    fb.latestThumbnailFn.mockResolvedValue("THUMBNAIL_B64");
    const writeArtifact = vi.fn(() => Promise.resolve({ id: "thumb_1" }));
    const cap = new ScreenCapture({ ...makeDeps(), backend: fb.backend, writeArtifact });

    await cap.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await cap.stopAndFlush();

    expect(writeArtifact).toHaveBeenCalledWith(
      "desktop-thumbnail-5000.jpg",
      "image/jpeg",
      "THUMBNAIL_B64",
      {
        kind: "desktop-thumbnail",
        capture_point: "initial",
        captured_at: 5000,
        width: 320,
        height: 200,
      },
    );
  });

  it("stores the latest thumbnail before a terminal or suspend flush", async () => {
    const fb = fakeBackend();
    fb.latestThumbnailFn.mockResolvedValue("FINAL_THUMBNAIL_B64");
    const writeArtifact = vi.fn(() => Promise.resolve({ id: "thumb_final" }));
    const cap = new ScreenCapture({ ...makeDeps(), backend: fb.backend, writeArtifact });

    await cap.start();
    await cap.stopAndFlush();

    expect(fb.latestThumbnailFn).toHaveBeenCalledTimes(1);
    expect(writeArtifact).toHaveBeenCalledWith(
      "desktop-thumbnail-5000.jpg",
      "image/jpeg",
      "FINAL_THUMBNAIL_B64",
      expect.objectContaining({ kind: "desktop-thumbnail", capture_point: "flush" }),
    );
  });

  it("stores a thumbnail that only becomes readable when an ultrashort run stops", async () => {
    const fb = fakeBackend();
    let stopped = false;
    fb.latestThumbnailFn.mockImplementation(() =>
      Promise.resolve(stopped ? "FINALIZED_THUMBNAIL_B64" : null),
    );
    fb.stopFn.mockImplementation(() => {
      stopped = true;
      return Promise.resolve();
    });
    const writeArtifact = vi.fn(() => Promise.resolve({ id: "thumb_short" }));
    const cap = new ScreenCapture({ ...makeDeps(), backend: fb.backend, writeArtifact });

    await cap.start();
    await cap.stopAndFlush();

    expect(writeArtifact).toHaveBeenCalledWith(
      "desktop-thumbnail-5000.jpg",
      "image/jpeg",
      "FINALIZED_THUMBNAIL_B64",
      expect.objectContaining({ kind: "desktop-thumbnail", capture_point: "flush" }),
    );
  });

  it("does not create another initial thumbnail after a suspend/resume", async () => {
    vi.useFakeTimers();
    const fb = fakeBackend();
    fb.latestThumbnailFn.mockResolvedValue("THUMBNAIL_B64");
    const writeArtifact = vi.fn<SegmentArtifactWriter>(() => Promise.resolve({ id: "thumb" }));
    const cap = new ScreenCapture({ ...makeDeps(), backend: fb.backend, writeArtifact });

    await cap.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await cap.stopAndFlush();
    await cap.startFresh();
    await vi.advanceTimersByTimeAsync(5_000);
    await cap.stopAndFlush();

    const initialWrites = writeArtifact.mock.calls.filter(
      (call) => call[3]?.capture_point === "initial",
    );
    expect(initialWrites).toHaveLength(1);
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

  it("suppresses frames identical to the last one published", async () => {
    vi.useFakeTimers();
    const fb = fakeBackend(); // latestFrame always resolves the same "FRAME_B64"
    const publishLiveFrames = vi.fn(() => Promise.resolve());
    const cap = new ScreenCapture({
      ...makeDeps(),
      backend: fb.backend,
      publishLiveFrames,
      liveViewWanted: () => Promise.resolve(true),
    });
    await cap.start();
    // 5 ticks, all the same pixels, well inside the 10s keepalive: only the first goes out.
    await vi.advanceTimersByTimeAsync(5000);

    expect(fb.latestFrameFn).toHaveBeenCalledTimes(5);
    expect(publishLiveFrames).toHaveBeenCalledTimes(1);
    await cap.stopAndFlush();
  });

  it("pushes again as soon as the screen changes", async () => {
    vi.useFakeTimers();
    const fb = fakeBackend();
    fb.latestFrameFn
      .mockResolvedValueOnce("FRAME_A")
      .mockResolvedValueOnce("FRAME_A")
      .mockResolvedValueOnce("FRAME_B");
    const publishLiveFrames = vi.fn(() => Promise.resolve());
    const cap = new ScreenCapture({
      ...makeDeps(),
      backend: fb.backend,
      publishLiveFrames,
      liveViewWanted: () => Promise.resolve(true),
    });
    await cap.start();
    await vi.advanceTimersByTimeAsync(3000);

    expect(publishLiveFrames.mock.calls).toEqual([[["FRAME_A"]], [["FRAME_B"]]]);
    await cap.stopAndFlush();
  });

  it("resends an unchanged frame once the keepalive falls due", async () => {
    vi.useFakeTimers();
    const fb = fakeBackend({ liveKeepaliveMs: 3000 });
    const publishLiveFrames = vi.fn(() => Promise.resolve());
    const cap = new ScreenCapture({
      ...makeDeps(),
      backend: fb.backend,
      publishLiveFrames,
      liveViewWanted: () => Promise.resolve(true),
    });
    await cap.start();
    // 6 identical ticks with a 3s keepalive: the initial push plus one resend per elapsed window,
    // so the stream never goes fully silent under a proxy idle timer.
    await vi.advanceTimersByTimeAsync(6000);

    expect(publishLiveFrames.mock.calls.length).toBeGreaterThan(1);
    expect(publishLiveFrames.mock.calls.length).toBeLessThan(6);
    await cap.stopAndFlush();
  });

  it("resends to a viewer that attaches after the last one left, even on a static screen", async () => {
    vi.useFakeTimers();
    const fb = fakeBackend();
    const publishLiveFrames = vi.fn(() => Promise.resolve());
    let attached = true;
    const cap = new ScreenCapture({
      ...makeDeps(),
      backend: fb.backend,
      publishLiveFrames,
      liveViewWanted: () => Promise.resolve(attached),
    });
    await cap.start();
    await vi.advanceTimersByTimeAsync(1000); // first viewer gets the frame
    expect(publishLiveFrames).toHaveBeenCalledTimes(1);

    attached = false;
    await vi.advanceTimersByTimeAsync(4000); // detaches — polls see it, nothing pushed
    publishLiveFrames.mockClear();

    // A new viewer attaches while the screen has not changed at all. Without the rising-edge reset
    // the dedupe would hold the frame back and leave them on "Connecting…" indefinitely.
    attached = true;
    await vi.advanceTimersByTimeAsync(4000);
    expect(publishLiveFrames).toHaveBeenCalledWith(["FRAME_B64"]);
    await cap.stopAndFlush();
  });

  it("retries the same frame after a failed publish", async () => {
    vi.useFakeTimers();
    const fb = fakeBackend();
    const publishLiveFrames = vi
      .fn<(frames: string[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error("broker down"))
      .mockResolvedValue(undefined);
    const cap = new ScreenCapture({
      ...makeDeps(),
      backend: fb.backend,
      publishLiveFrames,
      liveViewWanted: () => Promise.resolve(true),
    });
    await cap.start();
    await vi.advanceTimersByTimeAsync(2000);

    // The failed push must not count as "already sent" — the frame goes out on the next tick.
    expect(publishLiveFrames).toHaveBeenCalledTimes(2);
    expect(publishLiveFrames.mock.calls[1]).toEqual([["FRAME_B64"]]);
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
