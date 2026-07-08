/*
 * bw_reseed — the clause-3 userspace-CSPRNG reseed (SNAPSHOT_UNIQUENESS_CONTRACT).
 *
 * A memory snapshot freezes OpenSSL's DRBG state, so two clones of one base snapshot hand every
 * run byte-identical `crypto.*` output. The kernel CSPRNG diverges across clones (VMGenID), but
 * that reseed never reaches OpenSSL. A pure-JS monkeypatch was proven insufficient (named ESM
 * imports of node:crypto bypass it), so this native step reseeds OpenSSL's DRBG UNDERNEATH every
 * caller — the only robust fix.
 *
 * OpenSSL 3 DRBG chain: the primary DRBG seeds from the OS entropy source; the public + private
 * DRBGs (what RAND_bytes / Node crypto actually draw from) seed from the primary. We reseed the
 * primary first (pulling the now-diverged OS entropy) then the public + private so the fresh
 * entropy propagates immediately, and call RAND_poll() as a belt. Everything is guarded on NULL so
 * a non-default RAND provider degrades to whatever succeeded rather than crashing.
 *
 * Symbols (RAND_get0_*, EVP_RAND_reseed, RAND_poll) come from the OpenSSL that Node links; on a
 * Node build that does not export them the addon fails to load and the JS layer no-ops with a warn
 * (uniqueness_reseed.ts). Linux-only in practice (the snapshot substrate is Linux microVMs).
 */
#include <node_api.h>
#include <openssl/rand.h>
#include <openssl/evp.h>

static int reseed_ctx(EVP_RAND_CTX *ctx) {
  if (ctx == NULL) return 1; /* absent layer: nothing to do, not a failure */
  return EVP_RAND_reseed(ctx, /*prediction_resistance=*/0, NULL, 0, NULL, 0);
}

static napi_value Reseed(napi_env env, napi_callback_info info) {
  int ok = 1;
  /* Reseed the primary FIRST (it pulls fresh OS entropy), then the layers that serve draws. */
  if (!reseed_ctx(RAND_get0_primary(NULL))) ok = 0;
  if (!reseed_ctx(RAND_get0_public(NULL))) ok = 0;
  if (!reseed_ctx(RAND_get0_private(NULL))) ok = 0;
  /* Legacy belt: also nudge the default method's entropy pool. */
  RAND_poll();

  napi_value result;
  napi_get_boolean(env, ok ? true : false, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  if (napi_create_function(env, "reseed", NAPI_AUTO_LENGTH, Reseed, NULL, &fn) != napi_ok) {
    return exports;
  }
  napi_set_named_property(env, exports, "reseed", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
