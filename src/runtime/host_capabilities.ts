// SPDX-License-Identifier: Apache-2.0

// buildHostCapabilities — adapt the runner's WorkerWorkflowHost onto the protocol server's
// `HostCapabilities` seam. Nearly an identity mapping (the host already implements every
// capability under the abort/freeze gate); the two real translations live here:
//
//   - `workflows.call` must resolve `{output, output_schema}` — the callee's declared output
//     schema is what lets the SDK revive a typed child's return (a child returning a `Date`
//     hands its parent a `Date`). The broker's child-run completion payload does NOT carry the
//     callee's schema today, so this honestly reports `output_schema: null` (plain JSON — the
//     revival pass passes it through) and warns once per run. Backend follow-up: the child
//     endpoints must return the callee's stored `output_schema` alongside `output`.
//   - `phase` maps onto the host's `setPhase` (the fire-and-forget timeline marker).

import { createLogger } from "./support/index.js";
import type { HostCapabilities, CapabilityCallResult } from "./host_server.js";
import type { WorkerWorkflowHost } from "./workflow_host.js";

const log = createLogger("HostCapabilities");

/** Build the protocol server's capability seam over the run's {@link WorkerWorkflowHost}. */
export function buildHostCapabilities(host: WorkerWorkflowHost): HostCapabilities {
  let warnedCallSchema = false;
  return {
    agent: (prompt, opts) => host.agent(prompt, opts),
    callWorkflow: async (slug, input, opts): Promise<CapabilityCallResult> => {
      const output = await host.callWorkflow(slug, input, opts);
      if (!warnedCallSchema) {
        warnedCallSchema = true;
        log.warn("workflows_call_output_schema_unavailable", {
          slug,
          note: "child completion payload carries no output_schema; typed child returns are not revived (backend follow-up)",
        });
      }
      return { output, outputSchema: null };
    },
    runWorkflow: (slug, input, opts) => host.runWorkflow(slug, input, opts),
    scheduleWorkflow: (slug, input, opts) => host.scheduleWorkflow(slug, input, opts),
    sleep: (arg) => host.sleep(arg),
    humanInput: (opts) => host.humanInput(opts),
    getSecret: (name) => host.getSecret(name),
    writeArtifact: (name, contentType, body, metadata) =>
      host.writeArtifact(name, contentType, body, metadata),
    openBrowser: (opts) => host.openBrowserSession(opts),
    shell: (cmd, opts) => host.shell(cmd, opts),
    phase: (name, opts) => {
      host.setPhase(name, opts);
    },
    idToken: (audience) => host.idToken(audience),
    apiToken: () => host.apiToken(),
    usage: () => host.usage(),
  };
}
