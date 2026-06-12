# SPEC — `runner`

> The self-hosted runner client: **your hardware executes runs for Boardwalk's hosted control plane.** Apache-2.0. Public in **Phase 3** (when Boardwalk self-hosted runners ship).
>
> Governing context: root [`MASTER_SPEC.md`](../MASTER_SPEC.md) §1, §9. Do not confuse with the flagship engine: the flagship is the _entire control plane on your hardware, no Boardwalk involvement_; this runner is _Boardwalk-scheduled work executing on your machines_. Different users, different trust model.

> **Naming:** repo `runner` · package `@boardwalk-labs/runner` · binary **`boardwalk-runner`**. The command is brand-prefixed (a bare `runner` on a user's PATH collides with other tools; cf. `gitlab-runner`) — the same split the `cli` repo uses to ship the `boardwalk` binary. The npm `bin` is wired to `boardwalk-runner` when the binary lands (Phase 3).

## 1. Purpose

Organizations that want the Boardwalk platform's scheduling, console, and governance but their own compute (data residency, special hardware, internal network access) register runner machines that pull and execute assigned runs. The mental model is a CI self-hosted runner; the contract is Boardwalk-native.

## 2. Security model (non-negotiable)

- **The runner never receives broad credentials.** It authenticates with a registration token, then receives only **short-lived, run-scoped assignment tokens and per-run capabilities**.
- Secrets resolve per run through the platform's brokered API surface with the run token — never as org-wide material stored on the runner.
- Workspace, credentials, artifacts, and logs are isolated per run and cleaned on completion; cross-run leakage is a P0 bug (CODE_QUALITY §1.8).

## 3. Contents

- `boardwalk-runner register --pool <name> --token <token>` + the registration flow.
- Assignment client (long-poll/WebSocket), claim/lease handling, heartbeats, graceful drain + revoke behavior.
- Runner label/OS/arch advertisement (`runs_on` matching).
- Per-run workspace creation, isolation, and cleanup.
- Artifact upload + run-event/log streaming clients (the same wire format as everywhere, MASTER_SPEC §2.5).
- OIDC request-token flow for runs that need identity tokens.
- **The runner contract itself** — registration/assignment/claim/heartbeat/status payload types — published from this repo as the canonical types. **Status: v0 DRAFT landed** (`src/contract.ts` Zod schemas + `CONTRACT.md` flows/lease state machine/security invariants), built ahead of the client so the platform control plane and the runner implement one definition; breaking changes allowed until the first tagged release.
- **WorkspaceStore protocol** (`hydrate` / `persist` / `capabilities`) + a `local` reference implementation; custom store implementations are a self-hosted-only capability.

## 4. Out of scope

Control-plane behavior (scheduling decisions, run creation, billing), the platform's hosted-worker runtime layer, and anything requiring non-public platform APIs. The runner consumes documented endpoints only.

## 5. Ready to go public when

1. A runner on a clean host registers, advertises labels, claims an assigned run, executes it, streams events/artifacts, and cleans up — against the platform's public runner endpoints.
2. Drain/revoke and lease-expiry behaviors covered by integration tests against a fake control plane.
3. Contract types published and consumed by at least the platform implementation; publication checklist (MASTER_SPEC §8) passes.
