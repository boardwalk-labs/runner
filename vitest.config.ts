// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/bin.ts",
        "src/runtime/main.ts",
        "src/runtime/testing_artifact_build.ts",
      ],
      thresholds: { lines: 80, functions: 80, branches: 70 },
    },
  },
});
