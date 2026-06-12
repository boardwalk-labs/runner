# Security

Boardwalk workflows handle real credentials, so we treat security reports with urgency.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

- Preferred: use GitHub's private vulnerability reporting ("Report a vulnerability" under the
  Security tab of this repository).
- Or email **security@boardwalk.sh**.

Include what you found, a reproduction, and the impact you believe it has. You'll get an
acknowledgement within 72 hours and a status update at least weekly until resolution.

## Scope notes

- Secret values must never appear in logs, run-event streams, error messages, or model context.
  Anything that makes them do so is a vulnerability — report it.
- A workflow program is the org's own trusted code; reports should concern the platform's
  boundaries (secret handling, credential scoping, template fetching, auth flows), not what a
  program can do to its own workspace.
