import { describe, it, expect } from "vitest";
import { sandboxConfigFromManifest } from "./sandbox_config.js";
import type { WorkflowManifest } from "./wire/manifest.js";

// The function only reads `.env`; cast a minimal fixture so the test isn't coupled to unrelated
// required manifest fields.
function mf(partial: Partial<WorkflowManifest>): WorkflowManifest {
  return { permissions: {}, ...partial } as unknown as WorkflowManifest;
}

describe("sandboxConfigFromManifest", () => {
  it("splits env into non-secret literals and ${{ secrets.X }} references", () => {
    const cfg = sandboxConfigFromManifest(
      mf({ env: { REGION: "us-west-2", TOKEN: "${{ secrets.gh }}" } }),
    );
    expect(cfg.env).toEqual({ REGION: "us-west-2" });
    expect(cfg.secretEnv).toEqual({ TOKEN: "gh" });
  });

  it("omits keys with no content (shell uses its built-in default allowlist — no manifest config)", () => {
    expect(sandboxConfigFromManifest(mf({}))).toEqual({});
    expect(sandboxConfigFromManifest(mf({ env: {} }))).toEqual({});
  });
});
