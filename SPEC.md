# SPEC — `boardwalk-runner`

> The self-hosted runner client: **your hardware executes runs for Boardwalk Cloud's control plane.** Apache-2.0. Public in **Phase 3** (when Cloud self-hosted runners ship).
>
> Governing context: root [`MASTER_SPEC.md`](../MASTER_SPEC.md) §1, §9. Do not confuse with the flagship engine: the flagship is the *entire control plane on your hardware, no Boardwalk involvement*; this runner is *Cloud-scheduled work executing on your machines*. Different users, different trust model.

## 1. Purpose

Organizations that want Boardwalk Cloud's scheduling, console, and governance but their own compute (data residency, special hardware, internal network access) register runner machines that pull and execute assigned runs. The mental model is a CI self-hosted runner; the contract is Boardwalk-native.

## 2. Security model (non-negotiable)

- **The runner never receives broad credentials.** It authenticates with a registration token, then receives only **short-lived, run-scoped assignment tokens and per-run capabilities**.
- Secrets resolve per run through the Cloud's brokered API surface with the run token — never as org-wide material stored on the runner.
- Workspace, credentials, artifacts, and logs are isolated per run and cleaned on completion; cross-run leakage is a P0 bug (CODE_QUALITY §1.8).

## 3. Contents

- `boardwalk-runner register --pool <name> --token <token>` + the registration flow.
- Assignment client (long-poll/WebSocket), claim/lease handling, heartbeats, graceful drain + revoke behavior.
- Runner label/OS/arch advertisement (`runs_on` matching).
- Per-run workspace creation, isolation, and cleanup.
- Artifact upload + run-event/log streaming clients (the same wire format as everywhere, MASTER_SPEC §2.5).
- OIDC request-token flow for runs that need identity tokens.
- **The runner contract itself** — registration/assignment/claim/heartbeat/status payload types — published from this repo as the canonical types.
- **WorkspaceStore protocol** (`hydrate` / `persist` / `capabilities`) + a `local` reference implementation; custom store implementations are a self-hosted-only capability.

## 4. Out of scope

Control-plane behavior (scheduling decisions, run creation, billing), the Cloud's hosted-worker runtime layer, and anything requiring non-public Cloud APIs. The runner consumes documented endpoints only.

## 5. Ready to go public when

1. A runner on a clean host registers, advertises labels, claims an assigned run, executes it, streams events/artifacts, and cleans up — against Cloud's public runner endpoints.
2. Drain/revoke and lease-expiry behaviors covered by integration tests against a fake control plane.
3. Contract types published and consumed by at least the Cloud implementation; publication checklist (MASTER_SPEC §8) passes.
