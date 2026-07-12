// On-screen run-output mirror. Formats the run's (already-redacted) event stream into readable,
// ANSI-colored lines appended to a local file, which an xterm in the ambient desktop tails so the
// live-view / recording shows the run working (docs/SCREEN_CAPTURE.md). Gated on
// BOARDWALK_RUN_LOG_FILE — the desktop guest image sets it. This ONLY ever sees events that already
// passed the run's redactor (the same stream the web run-detail renders), so the file is safe to
// capture in a durable recording.

import { createWriteStream, type WriteStream } from "node:fs";
import type { RunEvent } from "./agent/events.js";

function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function safeJson(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** One readable, ANSI-colored line for a run event, or null to skip it (streaming text/reasoning
 *  deltas are buffered by the sink, not formatted here). Reads only a few fields off the SDK's typed
 *  event and degrades gracefully on anything unexpected. */
export function formatRunEventLine(event: RunEvent): string | null {
  const e = event as unknown as Record<string, unknown>;
  const k = typeof e.kind === "string" ? e.kind : "";
  const s = (v: unknown): string => (typeof v === "string" ? v : "");
  switch (k) {
    case "run_status":
      return `\x1b[1;32m● ${s(e.status)}\x1b[0m`;
    case "phase":
      return `\x1b[1;36m▸ ${s(e.name)}\x1b[0m`;
    case "program_output": {
      const t = s(e.text).replace(/\s+$/, "");
      return t ? `  ${t}` : null;
    }
    case "turn_started":
      return `\x1b[35m· agent ${s(e.agentName) || s(e.agentId)}\x1b[0m`;
    case "tool_call_start":
      return `  \x1b[33m⚙ ${s(e.toolName)}\x1b[0m`;
    case "tool_output_delta": {
      const t = s(e.text).replace(/\s+$/, "");
      return t ? `    \x1b[90m${oneLine(t, 200)}\x1b[0m` : null;
    }
    case "tool_call_result":
      return `  \x1b[32m✓ done\x1b[0m`;
    case "tool_call_error":
      return `  \x1b[31m✗ tool error\x1b[0m`;
    case "output":
      return `\x1b[1;32m✔ output  ${oneLine(safeJson(e.value), 300)}\x1b[0m`;
    case "human_input_requested":
      return `\x1b[1;33m⏸ awaiting human input\x1b[0m`;
    case "human_input_resolved":
      return `\x1b[33m▶ input received\x1b[0m`;
    case "suspended":
      return `\x1b[90m⏸ suspended\x1b[0m`;
    case "resumed":
      return `\x1b[90m▶ resumed\x1b[0m`;
    case "egress_denied":
      return `  \x1b[31m⛔ egress denied\x1b[0m`;
    default:
      return null; // turn_ended, text_*, tool_call_input_*, tool_call_executing — noise for the terminal
  }
}

/** Build the {@link WorkerRunEventEmitter} local sink: append formatted lines to `path`, buffering
 *  streaming agent text/reasoning into whole lines. Best-effort — a broken stream (full disk, closed
 *  pipe) is swallowed and disables the sink; it never throws into the run. */
export function makeRunLogFileSink(path: string): (event: RunEvent) => void {
  let stream: WriteStream | null = null;
  try {
    stream = createWriteStream(path, { flags: "a" });
    stream.on("error", () => {
      stream = null;
    });
    stream.write("\n\x1b[1;36m── boardwalk run ──\x1b[0m\n");
  } catch {
    stream = null;
  }

  let textBuf = "";
  const flushText = (): void => {
    if (textBuf.trim() !== "" && stream !== null) {
      stream.write(`  \x1b[37m${oneLine(textBuf, 2000)}\x1b[0m\n`);
    }
    textBuf = "";
  };

  return (event: RunEvent): void => {
    if (stream === null) return;
    const e = event as unknown as Record<string, unknown>;
    const k = typeof e.kind === "string" ? e.kind : "";
    if (k === "text_delta" || k === "reasoning_delta") {
      textBuf += typeof e.text === "string" ? e.text : "";
      return;
    }
    if (k === "text_start") return;
    if (k === "text_end") {
      flushText();
      return;
    }
    flushText(); // a non-text event ends any in-flight text line
    const line = formatRunEventLine(event);
    if (line !== null) stream.write(line + "\n");
  };
}
