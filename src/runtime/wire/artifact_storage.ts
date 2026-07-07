// Artifact storage policy — the server-side rules for turning an agent's artifact-write request into
// a stored S3 object (the platform spec). These used to live in the `artifacts` TOOL,
// which runs on the UNTRUSTED runner; under the Runner Credential Broker (the Runner Credential Broker model) the
// broker owns them so a malicious runner can't bypass content-type neutralization or escape its
// run's key prefix. Pure functions — unit-tested exhaustively.

import * as nodePath from "node:path";

/** S3 key for a workflow's persistent workspace snapshot. Scoped PER WORKFLOW (not per run), so the
 *  snapshot carries across every run of the workflow. Derived server-side from the run token's
 *  org + workflow, so a runner can only ever reach its own workflow's workspace. */
export function workspaceS3Key(orgId: string, workflowId: string): string {
  return `orgs/${orgId}/workflows/${workflowId}/workspace.tar.gz`;
}

// ---- run-artifact retention tag (Phase 18.5 S3 lifecycle safety net) ----
//
// Run artifacts share the `orgs/{org}/...` prefix with workspace snapshots (`.../workflows/...`) and
// program artifacts (`.../program-artifacts/...`), and S3 lifecycle prefix filters can't express
// `orgs/*/runs/*` (the org id is a wildcard segment). So the safety-net rule keys off an OBJECT TAG
// applied at write time to run artifacts ONLY — never to workspace snapshots or program code, which
// must persist. The bucket's lifecycle rule (cdk/foundation/buckets.ts) expires objects carrying this
// tag after 365 days, catching orphans the reaper never sees (e.g. a large upload that never committed
// a catalog row). Tag at PUT time (inline + presigned) so an uncommitted orphan is still covered.

/** Tag key/value the lifecycle rule filters on. */
export const RUN_ARTIFACT_RETENTION_TAG = { key: "boardwalk-retention", value: "run-artifact" };

/** The same tag as the URL-encoded query string S3's `Tagging` param / `x-amz-tagging` header want. */
export const RUN_ARTIFACT_RETENTION_TAGGING = `${RUN_ARTIFACT_RETENTION_TAG.key}=${RUN_ARTIFACT_RETENTION_TAG.value}`;

/** S3 key for a run's artifact. The prefix is the per-run isolation boundary the broker enforces:
 *  `orgs/{org}/runs/{run}/...` (ArtifactService.register re-checks it). */
export function artifactS3Key(
  orgId: string,
  runId: string,
  token: string,
  name: string,
  contentType: string,
): string {
  return `orgs/${orgId}/runs/${runId}/${token}${extFor(name, contentType)}`;
}

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "application/json": ".json",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/markdown": ".md",
  "text/html": ".html",
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
};

/** Pick a file extension: prefer the name's own, else map the content type, else none. */
export function extFor(name: string, contentType: string): string {
  const fromName = nodePath.extname(name);
  if (fromName !== "") return fromName;
  return EXT_BY_CONTENT_TYPE[contentType.toLowerCase()] ?? "";
}

/** Content types a browser renders as ACTIVE content (can run script) when navigated to. */
const ACTIVE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/xml",
  "text/xml",
  "text/javascript",
  "application/javascript",
  "application/ecmascript",
]);
const NEUTRAL_CONTENT_TYPE = "text/plain; charset=utf-8";

/**
 * Map an agent-supplied content type to one safe to serve inline from a Boardwalk origin. Active
 * types are forced to text/plain so the browser renders them as inert text instead of executing
 * embedded script. The base type (before any `;` params) is what's matched. The body is
 * never altered — only the type the object is SERVED as.
 *
 * MUST run server-side (in the broker), never on the untrusted runner: the served content type is
 * what the CDN returns, so the runner must not be able to choose an active type.
 */
export function neutralizeActiveContentType(contentType: string): string {
  const base = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return ACTIVE_CONTENT_TYPES.has(base) ? NEUTRAL_CONTENT_TYPE : contentType;
}

// ---- size policy: proxy small bodies through the broker, presign large ones straight to S3 ----
//
// The proxy path (`POST .../artifacts`) buffers the base64 body through the Runner Control body
// limit (5 MiB wire), so it's bounded WELL under that. Anything larger takes the presigned-PUT path
// (`POST .../artifacts/presign`, the Runner Credential Broker model): the broker signs an S3 PUT and the
// runner streams the bytes straight to S3, so the body never passes through the control plane.

/** Largest raw artifact body the broker will accept INLINE (proxied). Comfortably under the 5 MiB
 *  control-plane body cap so the base64 string + JSON envelope fit. Above this ⇒ presigned PUT. */
export const ARTIFACT_PROXY_MAX_BYTES = 4 * 1024 * 1024;

/** Hard ceiling on a single artifact (presigned path included) — bounds runner + broker memory. */
export const ARTIFACT_MAX_BYTES = 100 * 1024 * 1024;

/** True when a body must use the presigned-PUT path instead of the inline proxy (it's too big to
 *  buffer through the broker). Pure — the worker's BrokerArtifactStore routes on it. */
export function shouldPresignArtifact(byteLength: number): boolean {
  return byteLength > ARTIFACT_PROXY_MAX_BYTES;
}

/** Decode an artifact body string to its raw bytes (base64 → binary, else UTF-8). The decoded length
 *  is the artifact's true byte size — what the proxy/presign routing + the catalog row key off. */
export function decodeArtifactBody(body: string, encoding?: "utf8" | "base64"): Buffer {
  return Buffer.from(body, encoding === "base64" ? "base64" : "utf8");
}
