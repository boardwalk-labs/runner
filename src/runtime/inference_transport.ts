// The broker inference transport the engine-backed leaf streams a model turn through
// (the Runner Credential Broker model — "Inference (class 2)").
//
// Under the Runner Credential Broker the runner invokes NO model directly: it holds neither the
// managed-inference key nor any BYO provider key. So the `agent()` leaf's `LeafIo.streamModel`
// forwards the neutral conversation here, and this transport POSTs it to the broker's `/inference`
// endpoint; the broker resolves the real model server-side and relays its stream back as the wire's
// `InferenceFrame`s (delta / result / error). `RunnerControlClient.streamInference` satisfies it.

import type { InferenceFrame, InferenceProxyRequest } from "./wire/inference_proxy.js";

/** Streams one model turn through the broker as `InferenceFrame`s (RunnerControlClient satisfies it). */
export interface InferenceProxyTransport {
  streamInference(req: InferenceProxyRequest): AsyncIterable<InferenceFrame>;
}
