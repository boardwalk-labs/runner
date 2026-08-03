// Desktop-tier computer use — the runtime backing for `computer.openDesktop()` and
// `agent({ session })` with a desktop session. See docs/COMPUTER_USE_SESSION.md §6.2.
//
// One screen per run: the session binds agent tools (via the leaf's ToolHost desktop hooks, built
// from `driverFor`) and takes program-side screenshots; everything else (launching apps, files) is
// `shell` in the trusted program. The OS driver is injected (desktop_driver.ts) so this manager is
// unit-tested without a guest.

import type { ArtifactRef } from "@boardwalk-labs/workflow/runtime";
// Type-only root import: the runtime subpath doesn't re-export the desktop types (yet).
import type { DesktopSession, DesktopSessionOptions } from "@boardwalk-labs/workflow";
import { AppError, ErrorCode } from "./support/index.js";
import type { DesktopDriver } from "./desktop_driver.js";
import type { ScreenshotArtifactWriter } from "./browser_session.js";

export type DesktopSessionHandle = DesktopSession;

/** Options as they arrive off the wire (already zod-validated to "auto"|"none" by the protocol;
 *  the string widening keeps the manager's own check meaningful for embedded callers). */
export interface DesktopSessionOpenOptions extends Omit<DesktopSessionOptions, "grounding"> {
  grounding?: string;
}

/** What the agent's `screenshot` tool needs: image for the model + the artifact ref (best-effort). */
export interface AgentScreenshot {
  data: string;
  width: number;
  height: number;
  artifact?: ArtifactRef;
}

export interface DesktopSessionManagerDeps {
  driver: DesktopDriver;
  writeArtifact: ScreenshotArtifactWriter;
  /** Monotonic session-id source (injected for determinism in tests). */
  nextId: () => string;
  /** Best-effort warn sink for non-fatal failures (artifact store hiccups). */
  warn?: (message: string, fields: Record<string, unknown>) => void;
}

/**
 * Per-run manager of THE desktop session: at most one open at a time (every handle would share the
 * one screen), reopenable after close, reaped at run end. `driverFor` resolves a bound session back
 * to the OS driver so the leaf executor can assemble the per-leaf ToolHost desktop hooks.
 */
export class DesktopSessionManager {
  private current: { id: string; handle: DesktopSessionHandle } | null = null;

  constructor(private readonly deps: DesktopSessionManagerDeps) {}

  open(opts?: DesktopSessionOpenOptions): DesktopSessionHandle {
    if (opts?.grounding !== undefined && opts.grounding !== "auto" && opts.grounding !== "none") {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `desktop session grounding "${opts.grounding}" is invalid`,
        { kind: "desktop_grounding_unsupported", grounding: opts.grounding },
        'Omit `grounding` (or pass "auto"/"none") — a desktop session grounds through raw coordinates.',
      );
    }
    if (this.current !== null) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        "a desktop session is already open for this run",
        { kind: "desktop_session_already_open" },
        "Reuse the existing handle — every desktop session shares the run's one screen.",
      );
    }
    const id = this.deps.nextId();
    const handle = this.makeHandle(id);
    this.current = { id, handle };
    return handle;
  }

  /** The OS driver for a bound session handle, or null when it isn't this run's live session. */
  driverFor(session: { id: string }): DesktopDriver | null {
    return this.current?.id === session.id ? this.deps.driver : null;
  }

  /** One capture, two sinks: base64 PNG for the model, the artifact best-effort (a store hiccup
   *  must not fail the agent's screenshot — the model still sees the frame). */
  async captureForAgent(sessionId: string): Promise<AgentScreenshot> {
    this.assertLive(sessionId);
    const shot = await this.deps.driver.screenshot();
    const data = shot.png.toString("base64");
    try {
      const artifact = await this.writeShot(sessionId, data);
      return { data, width: shot.width, height: shot.height, artifact };
    } catch (err) {
      this.deps.warn?.("desktop_screenshot_artifact_failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { data, width: shot.width, height: shot.height };
    }
  }

  /** Tear down the open session, if any. Called once when the run ends. */
  async closeAll(): Promise<void> {
    await this.current?.handle.close();
  }

  private assertLive(sessionId: string): void {
    if (this.current?.id !== sessionId) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, `desktop session ${sessionId} is closed`, {
        kind: "desktop_session_closed",
      });
    }
  }

  private writeShot(sessionId: string, base64: string): Promise<ArtifactRef> {
    return this.deps.writeArtifact(
      `screenshot-${sessionId}-${Date.now().toString(36)}.png`,
      "image/png",
      base64,
      { kind: "screenshot", session_id: sessionId },
    );
  }

  private makeHandle(id: string): DesktopSessionHandle {
    return {
      id,
      screenshot: async (): Promise<ArtifactRef> => {
        this.assertLive(id);
        const shot = await this.deps.driver.screenshot();
        return await this.writeShot(id, shot.png.toString("base64"));
      },
      close: (): Promise<void> => {
        // Idempotent; the screen itself outlives the session (it's the machine's display).
        if (this.current?.id === id) this.current = null;
        return Promise.resolve();
      },
    };
  }
}
