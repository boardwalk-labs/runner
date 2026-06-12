# @boardwalk-labs/runner

The [Boardwalk](https://boardwalk.sh) **self-hosted runner**: your machines execute runs that
hosted Boardwalk schedules — for data residency, special hardware, or internal-network access.
The mental model is a CI self-hosted runner; the contract is Boardwalk-native.

> Not to be confused with the [Boardwalk engine](https://github.com/boardwalk-labs/boardwalk):
> the engine runs the entire control plane on your hardware, with no hosted Boardwalk
> involvement. This runner executes hosted-Boardwalk-scheduled work on your machines.

## Status

**Pre-release.** What exists today is the **runner contract** — the canonical registration /
assignment / claim / heartbeat / status payload types, as Zod schemas with derived TS types:

```ts
import { runnerAssignmentSchema, parseContract } from "@boardwalk-labs/runner/contract";
```

[`CONTRACT.md`](./CONTRACT.md) is the prose half: flows, the lease state machine, and the
security invariants. The contract is defined ahead of the client so the control plane and the
runner are built against one definition. The client itself (register → poll → claim → execute →
stream → report) ships when Boardwalk self-hosted runners do.

## Security model

This part of the contract is settled, even though the client isn't built yet:

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
  treated as a critical (P0) bug.

## Develop

```sh
pnpm install
pnpm test
pnpm lint && pnpm typecheck && pnpm build
```

## License

Apache-2.0
