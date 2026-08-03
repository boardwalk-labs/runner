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
time; run more daemons (or machines) for concurrency. Each run executes in a container by default
(Docker or Podman required); pass `--host` to run it directly on the machine instead. `Ctrl-C`
drains: the current run
finishes, nothing new is claimed. Useful flags: `--once` (execute one run, then exit),
`--verbose` (debug-level daemon logs), `--debug` (also debug-logs inside each run process),
`--work-dir`, `--identity-dir`. Behind a corporate proxy, launch with `NODE_USE_ENV_PROXY=1`
and `HTTPS_PROXY` set; the daemon and the run processes both honor it. Runs inherit this
machine's network — a model or service reachable from the box is reachable from the run.

### Computer use (browser + desktop tiers)

`computer.openBrowser()` / `computer.openDesktop()` and `agent({ session })` drive an in-VM
browser or a whole desktop.

**Container mode (the default) works out of the box** from runner image `0.3.32` on: the image
carries the full desktop stack (Xvfb, Chromium, Playwright MCP, xdotool, ffmpeg) plus the tier
env contract, and starts its own in-container display — never your machine's — before the run.
A `BOARDWALK_*` tier variable set in the daemon's environment overrides the image default (e.g.
`BOARDWALK_RECORDING_ENABLED=0` to disable session recording, `BOARDWALK_SCREEN_WIDTH=1920`).
Note a computer-use session in a container still has the machine's network (`--network host`) —
that reach is the point of self-hosting, and it is on you.

**`--host` mode (full machine access)** drives your real environment instead — real Chrome, the
machine's own display, and (on macOS) apps like an iOS Simulator once the macOS desktop driver
lands. You provide the pieces and point the runner at them with the same env contract the hosted
image sets, so the code path is identical:

| Variable                        | Meaning                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BOARDWALK_BROWSER_TIER=1`      | Enable the per-run browser-session manager. Unset (the default) means `computer.openBrowser()` fails with a clear "not available on this runner".                        |
| `BOARDWALK_BROWSER_CHROME_PATH` | Path to a Chromium/Chrome binary the run launches with a CDP endpoint (headful, so it renders on a display).                                                             |
| `BOARDWALK_BROWSER_MCP_COMMAND` | Command to launch [Playwright MCP](https://github.com/microsoft/playwright-mcp) (e.g. a `playwright-mcp` bin, or `npx`). The runner attaches it to the browser over CDP. |
| `DISPLAY`                       | The X display the browser renders on (e.g. a headless `Xvfb :0`).                                                                                                        |

So a `--host` machine that wants the browser tier installs Chromium + Playwright MCP and sets
those variables (on Linux, also a display — a real X session or `Xvfb`; on macOS, `DISPLAY` is
ignored and Chrome opens on the real screen). Nothing else changes; a machine without them runs
every non-browser workflow exactly as before.

#### Desktop tier on macOS (`--host`)

`computer.openDesktop()` drives your real Mac screen: input via CGEvent, screenshots via
`screencapture`, no native addon or build toolchain required. Set `BOARDWALK_DESKTOP_TIER=1` in
the daemon's environment and grant the runner's terminal app **two** permissions in
**System Settings > Privacy & Security**:

| Permission           | Without it                                               |
| -------------------- | -------------------------------------------------------- |
| **Accessibility**    | clicks and keystrokes are silently swallowed by the OS   |
| **Screen Recording** | screenshots fail (`could not create image from display`) |

Both fail _silently_ at the OS level, which is exactly why `openDesktop()` checks them up front
and refuses with the fix rather than letting a run click into the void. Grant them to the app
that launches the runner (Terminal, iTerm, …), then restart it. Retina displays need no
configuration: the model sees true pixel dimensions and the driver converts coordinates.

Because it drives the real machine, an agent with a desktop session can act on anything on that
screen — the point of self-hosting, and worth deciding deliberately.

Current platform limits, stated plainly: the **desktop tier** is Linux and macOS; a **Windows**
driver (SendInput/DXGI) is not built yet. **Session recording / live view** captures via
`x11grab`, so it is Linux-only for now. Off a supported platform each declines cleanly instead
of failing runs.

## Security model

This part of the contract is settled:

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
- [`sdk-typescript`](https://github.com/boardwalk-labs/sdk-typescript) — `@boardwalk-labs/workflow`, the TypeScript API a workflow program imports
- [`cli`](https://github.com/boardwalk-labs/cli) — `boardwalk`: scaffold, validate, deploy, run
- [`examples`](https://github.com/boardwalk-labs/examples) — copyable workflow templates (`boardwalk init --template`)
- [`plugins`](https://github.com/boardwalk-labs/plugins) — coding-agent skills (Claude Code, Codex, Cursor, OpenClaw, OpenCode) + a control-plane MCP server
- [`runner-images`](https://github.com/boardwalk-labs/runner-images) — reproducible base images hosted runners execute in

Hosted platform and docs: [boardwalk.sh](https://boardwalk.sh).

## License

Apache-2.0
