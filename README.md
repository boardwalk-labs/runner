# @boardwalk-labs/runner

The [Boardwalk](https://boardwalk.sh) **self-hosted runner**: your machines execute runs that
hosted Boardwalk schedules — for data residency, special hardware, or internal-network access.
The mental model is a CI self-hosted runner; the contract is Boardwalk-native.

> Not to be confused with the [Boardwalk engine](https://github.com/boardwalk-labs/boardwalk):
> the engine runs the entire control plane on your hardware, with no hosted Boardwalk
> involvement. This runner executes hosted-Boardwalk-scheduled work on your machines.

## Status

**Pre-release, functional.** The package now carries all three layers:

- **`@boardwalk-labs/runner/contract`** — the canonical registration / offer / claim /
  heartbeat payload types (Zod schemas, derived TS types). [`CONTRACT.md`](./CONTRACT.md) is
  the prose half: flows, the lease state machine, and the security invariants.
- **`@boardwalk-labs/runner/runtime`** — the Boardwalk worker runtime itself: the same code a
  Boardwalk-hosted Fargate worker boots executes each claimed run here (one worker, two homes).
- **`boardwalk-runner`** (the bin) + **`@boardwalk-labs/runner/daemon`** — the machine daemon:
  register once, then poll → claim → run → heartbeat → clean.

## Quickstart

An org admin mints a one-time registration token (Boardwalk Settings > Runners), then on the
machine:

```sh
boardwalk-runner register --url https://api.boardwalk.sh --token bwkreg_...
boardwalk-runner start --url https://api.boardwalk.sh --pool default
```

`start` polls for runs targeting `runs_on: { kind: "self-hosted" }` and executes one at a
time; run more daemons (or machines) for concurrency. `Ctrl-C` drains: the current run
finishes, nothing new is claimed. Useful flags: `--once` (execute one run, then exit),
`--verbose` (debug-level daemon logs), `--debug` (also debug-logs inside each run process),
`--work-dir`, `--identity-dir`. Behind a corporate proxy, launch with `NODE_USE_ENV_PROXY=1`
and `HTTPS_PROXY` set; the daemon and the run processes both honor it. Runs inherit this
machine's network — a model or service reachable from the box is reachable from the run.

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
