// SPDX-License-Identifier: Apache-2.0

// Process entrypoint for one run: `node .../runtime/main.js` with the platform env contract
// (RUN_ID + BOARDWALK_CONTROL_PLANE_URL + BOARDWALK_RUN_TOKEN [+ BOARDWALK_API_KEY]). Used by
// the Boardwalk-hosted Fargate container AND spawned per-run by the self-hosted daemon —
// one worker, two homes (the Runner Credential Broker model). Import `./index.js` for the library.

import { main } from "./index.js";

void main();
