# The runner contract (v0 draft)

How a runner — self-hosted or Boardwalk-hosted — talks to the Boardwalk control plane. The
typed half lives in [`src/contract.ts`](./src/contract.ts) (Zod schemas, published as
`@boardwalk/runner/contract`); this document is the prose half: flows, the lease state machine,
and the security invariants.

> **Status: DRAFT.** Breaking changes are allowed until the first tagged release, which happens
> when the Cloud implementation lands and Cloud self-hosted runners ship (Phase 3). The contract
> is designed now so the control plane and the runner client are built against one definition
> instead of inventing it twice.

## The flows

```
register ──▶ poll ──▶ claim ──▶ execute (heartbeating) ──▶ report status ──▶ poll …
   │                                                                          ▲
   └── one registration token, single-purpose ─── standing runner_token ──────┘
```

1. **Register** (`RunnerRegistrationRequest` → `RunnerRegistrationResponse`). A machine joins a
   **pool** using a short-lived registration token minted in the dashboard. It receives a
   `runner_id` and a standing `runner_token` whose capabilities are exactly: poll, claim,
   heartbeat, deregister. Nothing about any org's workflows, secrets, or runs.
2. **Poll** (`AssignmentPollResponse`). The runner long-polls (or holds a socket) for work
   matching its pool + labels (`runs_on: { kind: "self-hosted", pool, labels? }`). At most one
   assignment per response.
3. **Claim** (`ClaimRequest` → `ClaimResponse`). Lease before work — a claimed run that stops
   heartbeating is recovered by the control plane after `lease_expires_at`. An assignment the
   runner never claims goes back to the queue.
4. **Execute.** In order: hydrate the workspace (per `workspace`), fetch the program artifact
   via the control plane and **verify `program.digest` before extraction**, validate the
   manifest with `@boardwalk/workflow`'s schema, import `program.entry` (importing IS running),
   stream run events in the SDK wire format, write artifacts/secrets/child-run calls through
   the control plane API with the run token.
5. **Heartbeat** (`HeartbeatRequest` → `HeartbeatResponse`). Extends the lease AND is the
   control channel: `cancel` and `drain` arrive in the response. There are **no inbound
   connections to the runner, ever** — every control signal is a brokered poll.
6. **Report** (`StatusReport`). The terminal word: `completed` / `failed` / `cancelled`, an
   optional redacted error, and usage. Then tear down the workspace and `/tmp`, and poll again
   (unless draining).

## Lease state machine

```
offered ──claim──▶ leased ──heartbeat──▶ leased            (extends lease_expires_at)
   │                  │
   │ (unclaimed)      ├── status report ─▶ terminal (completed | failed | cancelled)
   ▼                  │
 requeued             └── lease expiry / heartbeat stops ─▶ recovered by the control plane
```

- Heartbeat cadence is the runner's choice but must beat `lease_expires_at`; the response
  always carries the new expiry.
- After `cancel`: stop the program, report `cancelled`. After `drain`: finish the current run,
  then stop claiming.
- A `StatusReport` for an expired lease is rejected — the control plane already recovered the
  run; the runner discards local state.

## Security invariants (non-negotiable)

1. **The runner never receives broad credentials.** The registration token registers; the
   runner token polls/claims/heartbeats; the per-run `control_plane.run_token` is the only
   credential with reach into an org — short-lived, bound to one run + lease, authorized per
   call against that run's manifest. The contract has no field for anything broader, on
   purpose.
2. **Secrets are never in the assignment.** They resolve per run, through the control plane,
   with the run token, fail-closed against `meta.secrets`. Nothing org-wide is ever stored on
   the runner machine.
3. **Programs are content-addressed.** No raw source, no runtime transpile, no dependency
   install. The digest is verified before extraction; a mismatch aborts the run.
4. **Per-run isolation.** Workspace, credentials, artifacts, and logs are isolated per run and
   cleaned on completion (persistence happens via the workspace store, not by leaving files
   behind). Cross-run leakage is a P0 bug.
5. **Secret values never appear** in run events, logs, status reports, or error messages.

## What the contract deliberately does not cover

Scheduling decisions, run creation, billing, and the manifest/wire-format shapes (owned by
`@boardwalk/workflow` and carried opaquely here). The runner consumes documented public
endpoints only — if a capability isn't in the public API, the API grows first.
