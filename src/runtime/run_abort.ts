// run_abort — the provider-agnostic cooperative-cancellation substrate for a run (the Runner Credential Broker model
// §15 credit watching; the foundation user-initiated cancel will reuse).
//
// The cancellation primitive is a Web-standard `AbortSignal` — NOT a Strands/model concept. The worker
// owns one `AbortController` per run session; a watcher (credit, later user-cancel) calls
// `controller.abort(new RunAbortedError(reason))`. The WorkflowHost honors that signal at every hook
// boundary (`agent`/`sleep`/`workflows.call`/…), unwinding the program. The ONLY place that translates
// the signal into a model-specific stop is the Strands leaf (signal → `agent.cancel()`); a future
// non-Strands leaf honors the SAME `AbortSignal` its own way. So nothing here, in the host, or in the
// program-facing SDK depends on the model backend.
//
// `signal.aborted` is AUTHORITATIVE at the orchestrator: a program that catches RunAbortedError and
// keeps going still stops, because every subsequent host hook re-throws and the orchestrator finalizes
// the run terminal based on the signal regardless of how the program returned.

/** Why a run was aborted mid-flight. Extensible — user-initiated cancel will add to this.
 *  `lease_lost`: another worker reclaimed this run (our lease expired + a sweep re-dispatched it),
 *  so we must stop WITHOUT finalizing — the new owner owns the terminal write. */
export type AbortReason = "credit_exhausted" | "cancelled" | "lease_lost";

/** Thrown by WorkflowHost hooks once the run's AbortSignal has fired, so the program unwinds. A plain
 *  Error subclass (no AppError/model coupling) carrying the machine-readable reason. */
export class RunAbortedError extends Error {
  constructor(readonly reason: AbortReason) {
    super(`Run aborted: ${reason}`);
    this.name = "RunAbortedError";
  }
}

/** The reason an aborted signal carries (set via `controller.abort(new RunAbortedError(reason))`), or
 *  null when the signal isn't aborted / wasn't aborted with a RunAbortedError. */
export function abortReason(signal: AbortSignal): AbortReason | null {
  const r: unknown = signal.reason;
  return r instanceof RunAbortedError ? r.reason : null;
}

/** Throw if the signal has already aborted — the guard every WorkflowHost hook calls at entry. Re-uses
 *  the signal's own RunAbortedError when present, so the reason propagates verbatim. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    const r: unknown = signal.reason;
    throw r instanceof RunAbortedError ? r : new RunAbortedError("cancelled");
  }
}
