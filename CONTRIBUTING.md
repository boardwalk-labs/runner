# Contributing to @boardwalk-labs/runner

Right now this repo is the **runner contract** (see [CONTRACT.md](./CONTRACT.md)); the client
implementation lands with Boardwalk self-hosted runners. Contributions are welcome on both, with
the security model as the hard boundary.

## Ground rules

- **The security invariants are not up for negotiation** (CONTRACT.md §security). A PR that
  adds a field for org-wide credentials, persists secrets on the runner, opens an inbound
  control channel, or weakens digest verification will be declined regardless of convenience.
- **Contract changes are spec changes.** `src/contract.ts` and `CONTRACT.md` move together in
  the same PR. While the contract is DRAFT, breaking changes are fine; after the first tagged
  release they follow semver strictly.
- **Schema discipline** (same as `@boardwalk-labs/workflow`): strict objects, unknown fields are
  errors, types derive from schemas, union members most-specific-first, round-trip tests assert
  with `toEqual`.
- **The runner consumes documented public endpoints only.** If a capability needs a private
  platform API, the public API grows first.
- **The first-party deps are EXACT-pinned — do not "tidy" them back to a caret.**
  `@boardwalk-labs/engine` and `@boardwalk-labs/workflow` are pinned to exact versions on purpose.
  The runner is installed into the hosted guest image with `npm install -g <runner-tarball>`, which
  resolves dependency RANGES from the registry at bake time — our lockfile does not apply there. With
  a caret, a guest image built today and the same image built next month silently contain different
  engines, the image label says nothing about which, and CI tests a version the guest never runs.
  (That really happened: runner 0.2.1 was published tested against engine 0.2.0 while the guest was
  installing 0.2.2.) Exact pins make `runner@X` mean one exact runtime, so moving the engine takes a
  deliberate runner release. Third-party deps still float — closing that would need an
  `npm-shrinkwrap.json`, which is a separate call.

## Workflow

```sh
pnpm install
pnpm test
pnpm lint
pnpm typecheck
pnpm format
pnpm build
```

All gates must pass; CI runs exactly these. Every contract change ships with valid + invalid
fixtures in the same PR.

## Reporting

Bugs and proposals via GitHub issues (templates provided). Security reports: see
[SECURITY.md](./SECURITY.md) — never a public issue.
