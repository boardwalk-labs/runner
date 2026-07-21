// SPDX-License-Identifier: Apache-2.0

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "*.mjs", "*.ts"] },
  {
    files: ["src/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      // Platform config lives in the platform's own `BOARDWALK_*` namespace, but the workflow AUTHOR
      // owns process.env (no reserved keys — docs/RUN_ENV_AND_CREDS.md), so `process.env.BOARDWALK_*`
      // is author-shadowable. Read platform config from the trusted BOOT-env snapshot (`platformBootEnv`
      // in `main`) instead. Relay-delivered per-run keys (asserted by `applyIdentityToEnv`) and the
      // operator's pre-boot CLI writes are the only sanctioned exceptions (marked with a disable).
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.object.name='process'][object.property.name='env'][property.name=/^BOARDWALK_/]",
          message:
            "Don't read/write process.env.BOARDWALK_* — the workflow author owns process.env and can shadow it. Resolve platform config from the trusted boot-env snapshot (platformBootEnv) instead. See docs/RUN_ENV_AND_CREDS.md (Addendum 2026-07-21).",
        },
        {
          selector:
            "MemberExpression[object.object.name='process'][object.property.name='env'][property.value=/^BOARDWALK_/]",
          message:
            "Don't read/write process.env['BOARDWALK_*'] — the workflow author owns process.env and can shadow it. Resolve platform config from the trusted boot-env snapshot (platformBootEnv) instead. See docs/RUN_ENV_AND_CREDS.md (Addendum 2026-07-21).",
        },
      ],
    },
  },
);
