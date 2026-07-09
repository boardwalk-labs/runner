// artifacts — persist + reference run outputs. Available to any agent
// (no sandbox required). Three operations:
//   * write(name, content_type, body)   → store a file under the run's prefix; returns id + a signed URL.
//   * list()                            → artifacts produced in THIS run.
//   * signed_url(artifact_id, ttl?)     → mint a fresh signed download URL.
//
// This tool is a THIN agent-facing surface: it validates input + formats output and delegates the
// actual storage to an injected `ArtifactStore`. Under the Runner Credential Broker
// (the Runner Credential Broker model) the store is broker-backed — the broker computes the S3 key, neutralizes
// the content type, PUTs with its own creds, and records the catalog row, so the
// untrusted runner holds no S3 credential and can't bypass those server-side rules.

import { z } from "zod";
import { ARTIFACT_MAX_BYTES } from "../wire/artifact_storage.js";
import type { BoardwalkTool, ToolContext } from "./types.js";

// Body cap: a small write travels through the broker's buffered Runner Control endpoint (≤5 MiB
// wire); a large one takes the presigned-PUT path (the Runner Credential Broker model) that streams the
// body straight to S3. Either way the artifact is bounded by ARTIFACT_MAX_BYTES — the cap here is on
// the body STRING, sized for a full-size binary artifact carried as base64 (~4/3 inflation). The
// broker re-validates the true byte size server-side (the authoritative check).
const MAX_BODY_CHARS = Math.ceil(ARTIFACT_MAX_BYTES / 3) * 4;
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_TTL_SECONDS = 3600;

const artifactsInput = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("write"),
    name: z.string().min(1).max(255),
    content_type: z.string().min(1).max(200),
    body: z.string().max(MAX_BODY_CHARS),
    /** How `body` is encoded. `base64` lets agents persist binary content. */
    encoding: z.enum(["utf8", "base64"]).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ op: z.literal("list") }),
  z.object({
    op: z.literal("signed_url"),
    artifact_id: z.string().min(1).max(64),
    ttl_seconds: z.number().int().positive().max(MAX_TTL_SECONDS).optional(),
  }),
]);

type ArtifactsInput = z.infer<typeof artifactsInput>;

const artifactSummary = z.object({
  id: z.string(),
  name: z.string(),
  contentType: z.string(),
  sizeBytes: z.number(),
  createdAt: z.number(),
});

export type ArtifactSummary = z.infer<typeof artifactSummary>;

const artifactsData = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("write"),
    id: z.string(),
    name: z.string(),
    sizeBytes: z.number(),
    signedUrl: z.string(),
    expiresAt: z.number(),
  }),
  z.object({ op: z.literal("list"), artifacts: z.array(artifactSummary) }),
  z.object({
    op: z.literal("signed_url"),
    id: z.string(),
    signedUrl: z.string(),
    expiresAt: z.number(),
  }),
]);

export type ArtifactsData = z.infer<typeof artifactsData>;

const artifactsOutput = z.object({
  kind: z.literal("artifacts"),
  humanSummary: z.string(),
  data: artifactsData,
});

export type ArtifactsOutput = z.infer<typeof artifactsOutput>;

/** What the tool asks the store to persist. The store owns the S3 key, content-type neutralization,
 *  the actual write, and the catalog row — none of which the (untrusted) runner controls. */
export interface ArtifactWriteInput {
  name: string;
  contentType: string;
  /** The body as a string; `encoding` says how to decode it. */
  body: string;
  encoding?: "utf8" | "base64";
  metadata?: Record<string, unknown>;
}

export interface ArtifactWriteResult {
  id: string;
  name: string;
  sizeBytes: number;
  signedUrl: string;
  /** Absolute expiry (ms since epoch) of the returned signed URL. */
  expiresAt: number;
}

export interface ArtifactSignResult {
  signedUrl: string;
  expiresAt: number;
}

/** Phase 1 of the large-artifact path: what the worker asks the broker to presign. The bytes then go
 *  straight to S3, never through the broker. `sizeBytes` is the decoded body length the runner reports
 *  (the broker re-validates it against the hard ceiling and rejects an over-cap artifact BEFORE the
 *  runner uploads). No catalog row is written yet — that happens at commit. */
export interface ArtifactPresignInput {
  name: string;
  contentType: string;
  sizeBytes: number;
}

/** The broker's presign response: where + how to PUT the bytes, and the chosen `s3Key` the worker
 *  echoes back at commit. No catalog id / download URL yet — the row doesn't exist until the upload
 *  succeeds and the worker commits. */
export interface ArtifactPresignResult {
  /** The S3 key the broker derived (under the run's prefix); echoed back to {@link commitArtifact}. */
  s3Key: string;
  /** Presigned S3 PUT URL — the runner uploads the bytes here directly (no broker body cap). */
  uploadUrl: string;
  /** Headers the PUT MUST send: the content type is pinned into the presigned signature, so a
   *  mismatched type is rejected by S3 (the runner can't store an active/XSS-able served type). */
  uploadHeaders: Record<string, string>;
  expiresAt: number;
}

/** Phase 2 of the large-artifact path: register the catalog row AFTER the bytes have landed in S3.
 *  The worker echoes the presign's `s3Key`; the broker re-validates the run prefix + re-neutralizes
 *  the content type server-side. Returns an {@link ArtifactWriteResult} (id + signed download URL). */
export interface ArtifactCommitInput {
  s3Key: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  metadata?: Record<string, unknown>;
}

/** The storage backend the tool delegates to. The run is implied (the store is per-run bound —
 *  brokered: the run token; local: the run's context). */
export interface ArtifactStore {
  write(input: ArtifactWriteInput): Promise<ArtifactWriteResult>;
  list(): Promise<ArtifactSummary[]>;
  signedUrl(artifactId: string, ttlSeconds: number): Promise<ArtifactSignResult>;
}

export interface ArtifactsDeps {
  store: ArtifactStore;
  /** Default TTL for the `signed_url` op when the caller doesn't request one. */
  defaultTtlSeconds?: number;
}

export function makeArtifactsTool(
  deps: ArtifactsDeps,
): BoardwalkTool<ArtifactsInput, ArtifactsOutput> {
  const defaultTtl = deps.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS;

  return {
    name: "artifacts",
    description:
      "Persist and reference run outputs. write({name, content_type, body}) stores a file; list() shows this run's artifacts; signed_url({artifact_id}) mints a download link.",
    inputSchema: artifactsInput,
    outputSchema: artifactsOutput,
    secretsRequired: [],
    async invoke(input: ArtifactsInput, _ctx: ToolContext): Promise<ArtifactsOutput> {
      switch (input.op) {
        case "write": {
          const writeInput: ArtifactWriteInput = {
            name: input.name,
            contentType: input.content_type,
            body: input.body,
            ...(input.encoding !== undefined ? { encoding: input.encoding } : {}),
            ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
          };
          const r = await deps.store.write(writeInput);
          return {
            kind: "artifacts",
            humanSummary: `Wrote artifact ${r.name} (${r.sizeBytes.toString()} bytes)`,
            data: {
              op: "write",
              id: r.id,
              name: r.name,
              sizeBytes: r.sizeBytes,
              signedUrl: r.signedUrl,
              expiresAt: r.expiresAt,
            },
          };
        }
        case "list": {
          const artifacts = await deps.store.list();
          return {
            kind: "artifacts",
            humanSummary: `Listed ${artifacts.length.toString()} artifact(s) for this run`,
            data: { op: "list", artifacts },
          };
        }
        case "signed_url": {
          const ttl = input.ttl_seconds ?? defaultTtl;
          const r = await deps.store.signedUrl(input.artifact_id, ttl);
          return {
            kind: "artifacts",
            humanSummary: `Minted signed URL for artifact ${input.artifact_id}`,
            data: {
              op: "signed_url",
              id: input.artifact_id,
              signedUrl: r.signedUrl,
              expiresAt: r.expiresAt,
            },
          };
        }
      }
    },
  };
}
