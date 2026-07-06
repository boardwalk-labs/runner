# The runner contract (v0 draft)

How a self-hosted runner machine talks to the Boardwalk control plane. The typed half lives
in [`src/contract.ts`](./src/contract.ts) (Zod schemas, published as
`@boardwalk-labs/runner/contract`); this document is the prose half: flows, the lease state
machine, and the security invariants.

> **Status: DRAFT.** Breaking changes are allowed until the first tagged release, which
> happens when Boardwalk self-hosted runners ship. Revised 2026-07: credentials moved from
> the polled assignment to the CLAIM response, and the execute phase now reuses the
> run-token'd Runner Control API a hosted worker already speaks, so this contract covers
> only enrollment and the pool lease.

## The flows

```
register ──▶ poll ──▶ claim ──▶ execute (run-token broker, heartbeating) ──▶ finalize ──▶ poll …
   │                    │
   │                    └── credentials exist from HERE (run token + api token + env + BYO registry)
   └── one registration token, single-purpose ── standing runner_token ──────────────────────┘
```

1. **Register** (`RunnerRegistrationRequest` → `RunnerRegistrationResponse`). A machine
   presents a short-lived `bwkreg_…` registration token (minted by an org admin; single-use,
   1h TTL, bound to a pool at mint, so the request names no pool). It receives a `runner_id`
   and a standing `bwkr_…` `runner_token` whose capabilities are exactly: poll, claim,
   heartbeat, deregister. Nothing about any org's workflows, secrets, or runs.
2. **Poll** (`AssignmentPollResponse`). The runner long-polls (the server holds ~22s) for
   work matching its pool + labels. At most one **credential-free offer** per response:
   identity + `runs_on` selector only. A draining runner receives `action: "drain"` and
   stops claiming.
3. **Claim** (`ClaimResponse`). Lease before work: POST the offer's claim URL; first claim
   wins, a loser gets a conflict and polls again. The response is the ONLY payload carrying
   per-run credentials: the `control_plane` handle (run token + run API token + base URL),
   the resolved non-secret `env`, and the org's `byo_providers` registry (runner-direct
   inference; the managed lane stays brokered).
4. **Execute.** With the run token, the runner speaks the SAME Runner Control API a
   Boardwalk-hosted worker does: claim the run lease, fetch the manifest + content-addressed
   program (digest-verified before extraction), resolve secrets fail-closed, stream events in
   the SDK wire format, write artifacts and child-run calls through the control plane. One
   contract, hosted and self-hosted.
5. **Heartbeat** (`HeartbeatRequest` → `HeartbeatResponse`). Extends the assignment lease AND
   is the control channel: `cancel` and `drain` arrive in the response. There are **no
   inbound connections to the runner, ever** — every control signal is a brokered poll.
6. **Finalize.** The runner's last word on a run is the run-token'd `finalize` call on the
   Runner Control API (exactly like a hosted worker); the control plane closes out the
   assignment and flips the runner back to idle. Then tear down the workspace and poll again
   (unless draining). There is no separate pool-level status report.

## Lease state machine

```
offered ──claim──▶ leased ──heartbeat──▶ leased            (extends lease_expires_at)
   │                  │
   │ (unclaimed)      ├── run finalize ─▶ terminal (completed | failed | cancelled)
   ▼                  │
 requeued             └── lease expiry / heartbeat stops ─▶ recovered by the control plane
```

- Heartbeat cadence is the runner's choice but must beat `lease_expires_at`; the response
  always carries the new expiry.
- After `cancel`: stop the program; the broker records the terminal state. After `drain`:
  finish the current run, then stop claiming.
- A heartbeat for an expired lease is rejected — the control plane already recovered the
  run; the runner discards local state.

## Security invariants (non-negotiable)

1. **The runner never receives broad credentials.** The registration token registers (and is
   pool-bound at mint); the runner token polls/claims/heartbeats/deregisters; org reach
   exists only in a claim's `control_plane.run_token` — short-lived, bound to one run,
   authorized per call against that run's manifest. The polled offer carries no credential
   at all, so an unclaimed assignment can neither leak nor age one out.
2. **Secrets are never in any pool payload.** They resolve per run, through the control
   plane, with the run token, fail-closed. A `byo_providers` entry names its auth secret;
   the value never rides the wire here.
3. **Programs are content-addressed.** Fetched after claim via the Runner Control API; the
   digest is verified before extraction; no raw source, no runtime transpile, no dependency
   install.
4. **Per-run isolation.** Workspace, credentials, artifacts, and logs are isolated per run
   and cleaned on completion (persistence happens via the workspace store, not by leaving
   files behind). Cross-run leakage is a P0 bug.
5. **Secret values never appear** in run events, logs, or error messages.

## What the contract deliberately does not cover

Scheduling decisions, run creation, billing, the manifest/wire-format shapes (owned by
`@boardwalk-labs/workflow`), and the execute phase itself (the Runner Control API, documented
by the platform). The runner consumes documented public endpoints only — if a capability
isn't in the public API, the API grows first.
