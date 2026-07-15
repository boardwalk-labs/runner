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

### Browser tier (computer use)

`computer.openBrowser()` and `agent({ session })` drive an in-VM browser. On the hosted
runners the environment ships it; on a self-hosted machine you provide the pieces and point the
runner at them with a small env contract — the same contract the hosted image sets, so the code
path is identical:

| Variable                        | Meaning                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BOARDWALK_BROWSER_TIER=1`      | Enable the per-run browser-session manager. Unset (the default) means `computer.openBrowser()` fails with a clear "not available on this runner".                        |
| `BOARDWALK_BROWSER_CHROME_PATH` | Path to a Chromium/Chrome binary the run launches with a CDP endpoint (headful, so it renders on a display).                                                             |
| `BOARDWALK_BROWSER_MCP_COMMAND` | Command to launch [Playwright MCP](https://github.com/microsoft/playwright-mcp) (e.g. a `playwright-mcp` bin, or `npx`). The runner attaches it to the browser over CDP. |
| `DISPLAY`                       | The X display the browser renders on (e.g. a headless `Xvfb :0`).                                                                                                        |

So a self-hosted machine that wants the browser tier installs Chromium + Playwright MCP, runs a
display (e.g. `Xvfb`), and sets those variables. Nothing else changes; a machine without them
runs every non-browser workflow exactly as before.

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

## The Boardwalk repos

- [`boardwalk`](https://github.com/boardwalk-labs/boardwalk) — the open-source single-node engine: cron scheduling, webhooks, durable runs, run history
- [`sdk`](https://github.com/boardwalk-labs/sdk) — `@boardwalk-labs/workflow`, the TypeScript API a workflow program imports
- [`cli`](https://github.com/boardwalk-labs/cli) — `boardwalk`: scaffold, validate, run locally, deploy
- [`examples`](https://github.com/boardwalk-labs/examples) — copyable workflow templates (`boardwalk init --template`)
- [`plugins`](https://github.com/boardwalk-labs/plugins) — skills + MCP server for Claude Code, Codex, Cursor, OpenClaw, OpenCode
- [`runner-images`](https://github.com/boardwalk-labs/runner-images) — reproducible base images hosted runners execute in

Hosted platform and docs: [boardwalk.sh](https://boardwalk.sh).

## License

Apache-2.0
