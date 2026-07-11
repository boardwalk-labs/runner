// Reset the global HTTP connection pool after a snapshot restore.
//
// The North Star substrate freezes the whole VM (memory + every socket) and restores it later,
// possibly minutes or days on. Keep-alive TCP sockets do NOT survive that: undici pools them, but
// on restore the frozen socket state is stale and the peer — the per-host egress proxy (a CONNECT
// tunnel) and, through it, the broker — long since closed its end. undici would REUSE such a socket
// for the next request, which then hangs (no bytes flow, no RST arrives on a half-dead tunnel) until
// the control client's 30s AbortSignal.timeout fires and aborts it. On a woken run's FIRST broker
// call (finalize) that abort crashes the run — the "socket is dead but never reset" gap the control
// client's timeout only papered over (see runner_control_client.ts).
//
// The fix is to discard the dead pool on resume. Swapping in a fresh EnvHttpProxyAgent — which
// re-reads the unchanged HTTP(S)_PROXY env, so proxying is preserved — means every post-wake request
// opens a NEW socket instead of reusing a frozen one. Node's global `fetch` reads the same global
// dispatcher, so this covers the control client, inference, artifacts, and any author fetch alike.

import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { createLogger } from "./support/index.js";

const log = createLogger("http_pool_reset");

/** Discard the global HTTP connection pool so post-restore requests open fresh sockets. Never
 *  throws (a wake must not fail on pool hygiene) and never blocks (the dead pool drains in the
 *  background). Returns true if the dispatcher was swapped. */
export function resetHttpConnectionPool(): boolean {
  try {
    const prev = getGlobalDispatcher();
    setGlobalDispatcher(new EnvHttpProxyAgent());
    // Drain the old pool's dead sockets in the background; never block the wake on it.
    const drain = async (): Promise<void> => {
      try {
        await prev?.close?.();
      } catch {
        try {
          await prev?.destroy?.(new Error("http pool reset on wake"));
        } catch {
          /* already gone */
        }
      }
    };
    void drain();
    return true;
  } catch (err) {
    log.warn("http_pool_reset_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
