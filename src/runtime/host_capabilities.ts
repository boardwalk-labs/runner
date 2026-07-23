// SPDX-License-Identifier: Apache-2.0

// buildHostCapabilities — adapt the runner's WorkerWorkflowHost onto the protocol server's
// `HostCapabilities` seam. Nearly an identity mapping (the host already implements every
// capability under the abort/freeze gate); the two real translations live here:
//
//   - `workflows.call` resolves `{output, output_schema}` — the callee's PINNED version's
//     stored output schema (delivered by the broker's child endpoints, P3.7) is what lets the
//     SDK revive a typed child's return (a child returning a `Date` hands its parent a `Date`).
//     An untyped callee (or an older backend) yields `null` — plain JSON, honestly.
//   - `phase` maps onto the host's `setPhase` (the fire-and-forget timeline marker).

import type { HostCapabilities, CapabilityCallResult } from "./host_server.js";
import type { WorkerWorkflowHost } from "./workflow_host.js";

/** Build the protocol server's capability seam over the run's {@link WorkerWorkflowHost}. */
export function buildHostCapabilities(host: WorkerWorkflowHost): HostCapabilities {
  return {
    agent: (prompt, opts) => host.agent(prompt, opts),
    callWorkflow: async (slug, input, opts): Promise<CapabilityCallResult> => {
      const { output, outputSchema } = await host.callWorkflow(slug, input, opts);
      return { output, outputSchema };
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
