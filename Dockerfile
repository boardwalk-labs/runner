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

# 0.3.5 carries the full desktop stack (Xvfb/openbox/Chromium/Playwright MCP/xdotool/ffmpeg) plus
# the browser/desktop tier env contract — so a containerized self-hosted run gets computer use too.
FROM ghcr.io/boardwalk-labs/boardwalk-runner-linux:0.3.5@sha256:f6c4cf240281504cfcd72d354749ba1c02338072f1c2886444bd9f3425b33e75

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

# In-container desktop boot: the hosted guest's init starts the desktop before the worker parks;
# a container has no init, so the entry script does it — self-contained Xvfb inside the container
# (never the host's display), mirroring the hosted isolation model. Tier off ⇒ straight exec.
USER root
RUN printf '%s\n' \
  '#!/bin/sh' \
  'if [ "$BOARDWALK_BROWSER_TIER" = "1" ] || [ "$BOARDWALK_DESKTOP_TIER" = "1" ]; then' \
  '  boardwalk-start-desktop || echo "boardwalk-start-desktop failed; computer use unavailable" >&2' \
  'fi' \
  'exec "$@"' \
  > /usr/local/bin/bw-container-entry && chmod 0755 /usr/local/bin/bw-container-entry
USER node

# The per-run workspace is bind-mounted here by the daemon (`-v <host>:/workspace`).
WORKDIR /workspace
# One-shot: execute the single run described by the env, then exit (the daemon runs one container per
# claimed run). NOT a long-lived daemon.
ENTRYPOINT ["/usr/local/bin/bw-container-entry"]
CMD ["node", "/app/node_modules/@boardwalk-labs/runner/dist/runtime/main.js"]
