# @boardwalk/runner

The [Boardwalk](https://boardwalk.sh) **self-hosted runner**: your machines execute runs that
Boardwalk Cloud schedules — for data residency, special hardware, or internal-network access.
The mental model is a CI self-hosted runner; the contract is Boardwalk-native.

> Not to be confused with the [flagship engine](https://github.com/boardwalk-dev/boardwalk):
> the engine is the _entire control plane on your hardware, no Boardwalk involvement_. This
> runner is _Cloud-scheduled work executing on your machines_.

## Status

**Pre-release.** What exists today is the **runner contract** — the canonical registration /
assignment / claim / heartbeat / status payload types, as Zod schemas with derived TS types:

```ts
import { runnerAssignmentSchema, parseContract } from "@boardwalk/runner/contract";
```

[`CONTRACT.md`](./CONTRACT.md) is the prose half: flows, the lease state machine, and the
security invariants. The contract is defined ahead of the client so the control plane and the
runner are built against one definition. The client itself (register → poll → claim → execute →
stream → report) ships when Cloud self-hosted runners do.

## Security model (the part that's already final)

- The runner **never receives broad credentials**: a single-purpose registration token to join,
  a standing runner token that can only poll/claim/heartbeat, and a short-lived **run-scoped**
  token as the only credential with reach into an org — authorized per call against that run's
  manifest.
- Secrets are never in an assignment and never at rest on the runner; they resolve per run
  through the control plane, fail-closed.
- Programs are content-addressed built artifacts: digest verified before extraction, no raw
  source, no runtime installs.
- All control signals (cancel, drain) arrive in heartbeat _responses_ — there are no inbound
  connections to your machines.
- Per-run isolation of workspace, credentials, artifacts, and logs; cross-run leakage is
  treated as a P0.

## Develop

```sh
pnpm install
pnpm test
pnpm lint && pnpm typecheck && pnpm build
```

## License

Apache-2.0
