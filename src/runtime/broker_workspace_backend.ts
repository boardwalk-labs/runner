// BrokerWorkspaceBackend — {@link WorkspaceBackend} over the Runner Credential Broker.
//
// The hosted half of docs/WORKSPACE_PERSISTENCE.md I3. The runner holds NO S3 credential: every key is
// derived server-side from the run token's scope (org + workflow + environment + workspace key), so this
// client can name a pack DIGEST but never a key, and can only ever reach its own scope.
//
// Two different transports, deliberately:
//   - **Pack bytes go straight to S3** by presigned URL. They are large, and proxying them through the
//     control plane would put the whole workspace through the api-server's body cap and memory.
//   - **The manifest goes THROUGH the broker.** It is small, it already round-trips there for footprint
//     accounting, and only a server-side write can be CONDITIONAL — which is the entire mechanism that
//     stops two concurrent runs of one scope from silently dropping each other's merge (§6).

import { createLogger } from "./support/index.js";
import type {
  WorkspaceBackend,
  WorkspaceReservation,
  ManifestWriteResult,
} from "./workspace_sync.js";

const log = createLogger("BrokerWorkspaceBackend");

/** Content type the broker signs into a pack PUT; the upload must send exactly this or S3 rejects it. */
const PACK_CONTENT_TYPE = "application/octet-stream";

/** Digests per broker request. Matches the broker's own bound; the sync layer batches above this. */
const DIGEST_BATCH = 256;

/** The broker surface this backend needs (RunnerControlClient satisfies it). */
export interface WorkspaceBrokerTransport {
  workspaceReserve(totalBytes: number): Promise<WorkspaceReservation>;
  workspaceManifestRead(): Promise<{ manifest: string | null; generation: string | null }>;
  workspaceManifestWrite(
    manifest: string,
    expected: string | null,
    totalBytes: number,
  ): Promise<ManifestWriteResult>;
  workspacePacksExist(digests: readonly string[]): Promise<string[]>;
  workspacePackUrls(op: "put" | "get", digests: readonly string[]): Promise<Record<string, string>>;
  workspacePacksDelete(digests: readonly string[]): Promise<void>;
  uploadBytes(url: string, headers: Record<string, string>, body: Uint8Array): Promise<void>;
  downloadBytes(url: string): Promise<Uint8Array | null>;
}

export class BrokerWorkspaceBackend implements WorkspaceBackend {
  /** The scope's live footprint, carried from the reserve so the manifest write can record what
   *  actually landed rather than re-deriving it. */
  private lastReservedBytes = 0;

  constructor(private readonly broker: WorkspaceBrokerTransport) {}

  async reserve(totalBytes: number): Promise<WorkspaceReservation> {
    this.lastReservedBytes = totalBytes;
    return await this.broker.workspaceReserve(totalBytes);
  }

  async readManifest(): Promise<{ bytes: Uint8Array | null; generation: string | null }> {
    const res = await this.broker.workspaceManifestRead();
    return {
      bytes: res.manifest === null ? null : new TextEncoder().encode(res.manifest),
      generation: res.generation,
    };
  }

  async writeManifest(bytes: Uint8Array, expected: string | null): Promise<ManifestWriteResult> {
    return await this.broker.workspaceManifestWrite(
      new TextDecoder().decode(bytes),
      expected,
      this.lastReservedBytes,
    );
  }

  async existingPacks(digests: readonly string[]): Promise<ReadonlySet<string>> {
    const present = new Set<string>();
    for (const batch of chunk(digests, DIGEST_BATCH)) {
      for (const digest of await this.broker.workspacePacksExist(batch)) present.add(digest);
    }
    return present;
  }

  async writePack(digest: string, bytes: Uint8Array): Promise<void> {
    const urls = await this.broker.workspacePackUrls("put", [digest]);
    const url = urls[digest];
    if (url === undefined) {
      // The broker declined to presign. Throwing rather than returning quietly is deliberate: the
      // caller would otherwise record this pack in the manifest without its bytes ever landing, which
      // is a manifest that cannot hydrate.
      throw new Error(`the broker declined to presign workspace pack ${digest.slice(0, 12)}`);
    }
    await this.broker.uploadBytes(url, { "content-type": PACK_CONTENT_TYPE }, bytes);
  }

  async readPack(digest: string): Promise<Uint8Array | null> {
    const urls = await this.broker.workspacePackUrls("get", [digest]);
    const url = urls[digest];
    if (url === undefined) {
      log.warn("workspace_pack_presign_declined", { digest });
      return null;
    }
    return await this.broker.downloadBytes(url);
  }

  async deletePacks(digests: readonly string[]): Promise<void> {
    for (const batch of chunk(digests, DIGEST_BATCH)) {
      await this.broker.workspacePacksDelete(batch);
    }
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
