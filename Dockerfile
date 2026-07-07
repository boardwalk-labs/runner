# The self-hosted runner's RUN image = the PUBLIC hosted-runner base + the published runtime layer.
# A self-hosted daemon (`boardwalk-runner start` / `boardwalk runner start`) spawns one per run:
#   docker run --rm --network host -v <workspace>:/workspace ghcr.io/boardwalk-labs/runner:<version>
# The container executes the SAME one-shot runtime a hosted Boardwalk worker boots, reading the run
# assignment + per-run credentials from the env the daemon passes, then exits.
#
# This mirrors how the hosted worker image is built (base pinned by digest + a thin runtime layer),
# except the runtime layer here is the PUBLIC @boardwalk-labs/runner npm package instead of a private
# one. We DERIVE from the curated base (git, ca-certificates, the Node userland, the unprivileged
# `node` user, /workspace, the npm-global PATH) — we do NOT re-curate a toolchain.
#
# Isolation is the point: a run (and its agent() tool calls) sees only /workspace + the machine's
# network, never the host home dir, the runner identity file, or the rest of the filesystem.

FROM ghcr.io/boardwalk-labs/boardwalk-runner-linux:0.1.2@sha256:01e5f4030efa8f3dfe4a23ec21e01361b7b0a04740fe32337dfb1ba053525b6e

# The exact @boardwalk-labs/runner version to bake in — passed by CI, pinned to the release tag so
# the container runtime matches the daemon that spawns it.
ARG RUNNER_VERSION

# Install the PUBLISHED runtime package into /app (the base runs as `node`; switch to root only to
# lay down /app, then hand it back). npm (not pnpm) here: the published package has no build step and
# its deps are prebuilt, so there's no ignored-build-scripts dance.
USER root
RUN mkdir -p /app && chown node:node /app
USER node
WORKDIR /app
RUN npm install --omit=dev --no-audit --no-fund "@boardwalk-labs/runner@${RUNNER_VERSION}"

# The per-run workspace is bind-mounted here by the daemon (`-v <host>:/workspace`).
WORKDIR /workspace
# One-shot: execute the single run described by the env, then exit (the daemon runs one container per
# claimed run). NOT a long-lived daemon.
ENTRYPOINT ["node", "/app/node_modules/@boardwalk-labs/runner/dist/runtime/main.js"]
