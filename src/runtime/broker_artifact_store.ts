// BrokerArtifactStore — the ArtifactStore the `artifacts` tool uses under the Runner Credential
// Broker (the Runner Credential Broker model). It forwards every op to the Runner Control API:
// the broker computes the S3 key, neutralizes the served content type, PUTs with its
// own creds, and records the catalog row — so the untrusted runner holds no S3 credential and can't
// bypass those server-side rules. A thin adapter over the run-bound RunnerControlClient.
//
// Writes route by size (the Runner Credential Broker model): a SMALL body is proxied inline through the
// broker (`POST .../artifacts`); a LARGE one takes the presigned-PUT path — the broker signs an S3
// PUT (still owning the key + content-type neutralization + catalog row) and the runner streams the
// bytes straight to S3, so they never pass through the control plane (no body cap).

import { decodeArtifactBody, shouldPresignArtifact } from "./wire/artifact_storage.js";
import type {
  ArtifactCommitInput,
  ArtifactPresignInput,
  ArtifactPresignResult,
  ArtifactSignResult,
  ArtifactStore,
  ArtifactSummary,
  ArtifactWriteInput,
  ArtifactWriteResult,
} from "./tools/artifacts.js";

/** The broker surface the store needs (RunnerControlClient satisfies it). */
export interface ArtifactBrokerTransport {
  writeArtifact(input: ArtifactWriteInput): Promise<ArtifactWriteResult>;
  presignArtifact(input: ArtifactPresignInput): Promise<ArtifactPresignResult>;
  uploadBytes(url: string, headers: Record<string, string>, body: Uint8Array): Promise<void>;
  commitArtifact(input: ArtifactCommitInput): Promise<ArtifactWriteResult>;
  listArtifacts(): Promise<ArtifactSummary[]>;
  signArtifactUrl(artifactId: string, ttlSeconds: number): Promise<ArtifactSignResult>;
}

export class BrokerArtifactStore implements ArtifactStore {
  constructor(private readonly broker: ArtifactBrokerTransport) {}

  async write(input: ArtifactWriteInput): Promise<ArtifactWriteResult> {
    const bytes = decodeArtifactBody(input.body, input.encoding);
    if (!shouldPresignArtifact(bytes.length)) {
      // Small: proxy the bytes inline (the broker neutralizes + PUTs + catalogs in one round trip).
      return this.broker.writeArtifact(input);
    }
    // Large: presign → PUT bytes straight to S3 → commit. The broker owns the key, content-type
    // neutralization, and the catalog row; only the byte transfer skips the control plane. The row is
    // registered at commit, AFTER the PUT — so a failed upload (uploadBytes throws here) leaves none.
    const presign = await this.broker.presignArtifact({
      name: input.name,
      contentType: input.contentType,
      sizeBytes: bytes.length,
    });
    await this.broker.uploadBytes(presign.uploadUrl, presign.uploadHeaders, bytes);
    return this.broker.commitArtifact({
      s3Key: presign.s3Key,
      name: input.name,
      contentType: input.contentType,
      sizeBytes: bytes.length,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });
  }

  list(): Promise<ArtifactSummary[]> {
    return this.broker.listArtifacts();
  }

  signedUrl(artifactId: string, ttlSeconds: number): Promise<ArtifactSignResult> {
    return this.broker.signArtifactUrl(artifactId, ttlSeconds);
  }
}
