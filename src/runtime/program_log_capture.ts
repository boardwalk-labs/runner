// Capture a workflow program's console output as run-events, so a plain `console.log` program shows
// up in the run's activity tail (not just the worker's CloudWatch logs).
//
// Boundary: we patch the GLOBAL `console` only for the duration of the program body. The worker's
// own structured logger (Powertools) captured its console reference at construction (module load,
// before the program runs), so its logs are NOT captured here — only the program's `console.*`,
// which resolves the global at call time. Each call is still forwarded to the original console (so
// it also lands in CloudWatch), then formatted and handed to the sink.
//
// Performance: lines ride the run's shared event emitter (→ the batched BrokerEventPublisher the
// run-event path uses), so logging is off the per-line HTTP hot path. We cap total frames + truncate
// huge lines so a runaway `console.log` loop can't flood Redis/S3/the broker. Frames are v1
// `program_output` events (`log` channel) interleaved on the run's single ordered cursor stream.

import { format } from "node:util";
import type { TurnEventSink } from "./agent/events.js";

export type LogStream = "stdout" | "stderr";

/** `console` methods mapped to a stream. log/info/debug → stdout; warn/error → stderr. */
const STREAM_BY_METHOD: Record<string, LogStream> = {
  log: "stdout",
  info: "stdout",
  debug: "stdout",
  warn: "stderr",
  error: "stderr",
};

type ConsoleMethod = (...args: unknown[]) => void;

/**
 * Patch the global console so each call is forwarded to the original AND handed (formatted) to
 * `sink`. Returns a restore function — ALWAYS call it (the worker runs `restore()` in a finally).
 */
export function captureConsole(
  sink: (stream: LogStream, text: string) => void,
  /** Scrub known secret values from each formatted line before it reaches EITHER sink. A program
   *  that `console.log`s a resolved secret must not leak it — to the run's `program_output` events
   *  OR to container stdout (CloudWatch). We format+redact once and print the SAME redacted string
   *  to the original console (equivalent output; `util.format` is what console does internally).
   *  Defaults to identity (tests/local). */
  redact: (text: string) => string = (t) => t,
): () => void {
  const console_ = globalThis.console as unknown as Record<string, ConsoleMethod>;
  const originals: Record<string, ConsoleMethod> = {};

  for (const [method, stream] of Object.entries(STREAM_BY_METHOD)) {
    const original = console_[method];
    if (typeof original !== "function") continue;
    originals[method] = original;
    console_[method] = (...args: unknown[]): void => {
      const text = redact(format(...args));
      original.call(console_, text); // print the REDACTED line to container stdout (CloudWatch)
      try {
        sink(stream, text);
      } catch {
        // best-effort — a telemetry hiccup must never break the program's own logging
      }
    };
  }

  return () => {
    for (const [method, original] of Object.entries(originals)) {
      console_[method] = original;
    }
  };
}

export interface ProgramLogSinkOptions {
  /** The run's shared event emitter — program logs ride the one ordered stream (`log` channel). */
  sink: TurnEventSink;
  /** Stop emitting after this many frames (the rest still print to CloudWatch). Default 10_000. */
  maxFrames?: number;
  /** Truncate a single line longer than this many chars. Default 8 KiB. */
  maxLineLength?: number;
}

const DEFAULT_MAX_FRAMES = 10_000;
const DEFAULT_MAX_LINE = 8 * 1024;

/**
 * Build the sink `captureConsole` feeds: turn each formatted console line into a v1
 * `program_output` event (best-effort). Caps + truncates to stay efficient.
 */
export function createProgramLogSink(
  opts: ProgramLogSinkOptions,
): (stream: LogStream, text: string) => void {
  const maxFrames = opts.maxFrames ?? DEFAULT_MAX_FRAMES;
  const maxLine = opts.maxLineLength ?? DEFAULT_MAX_LINE;
  let frames = 0;
  let truncationNoticeSent = false;

  return (stream, text) => {
    if (frames >= maxFrames) {
      if (!truncationNoticeSent) {
        // Emit one truncation notice, then go quiet (still prints to CloudWatch above).
        truncationNoticeSent = true;
        opts.sink.emit({
          kind: "program_output",
          stream: "stderr",
          text: "… console output truncated (too many lines)",
        });
      }
      return;
    }
    const line = text.length > maxLine ? `${text.slice(0, maxLine)}… (truncated)` : text;
    frames += 1;
    opts.sink.emit({ kind: "program_output", stream, text: line });
  };
}
