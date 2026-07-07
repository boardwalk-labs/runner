// Server-side single-file artifact build (web / MCP deploy surface, the workflow runtime design).
//
// The CLI bundles packages locally; web + MCP submit a single TS/JS file with no client bundler, so
// the api-server builds the IDENTICAL artifact shape: type-strip the source → `index.mjs`, pack a
// one-file deterministic tar.gz, content-address by sha256. A single file's only import is the host
// `@boardwalk-labs/workflow` SDK (left external at runtime), so there is nothing to bundle. The result
// flows through the SAME finalize path as a CLI upload (verify digest → read entry → derive manifest),
// so a server-built artifact gets the same integrity guarantees.

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import ts from "typescript";
// Inlined from the platform's domain/workflow/artifact_storage.ts (test-only helper).
const WORKFLOW_ARTIFACT_SOURCE_DIR = ".bw-src";
const WORKFLOW_ARTIFACT_SINGLE_SOURCE = `${WORKFLOW_ARTIFACT_SOURCE_DIR}/index.ts`;

/** Entry module name inside the artifact (matches the CLI builder). */
export const SINGLE_FILE_ENTRY = "index.mjs";
/** Single-file programs pin no SDK version — defer to whatever the worker image ships. */
const UNPINNED_SDK = "*";

/** A built program artifact + the metadata the version row records. */
export interface BuiltServerArtifact {
  tarball: Uint8Array;
  digest: string;
  size: number;
  entry: string;
  sdkVersion: string;
  lockfileDigest: null;
}

/**
 * Build a single-file program artifact from submitted source. Type-strips TS→ESM (no type-check;
 * imports preserved so `@boardwalk-labs/workflow` stays external), packs `index.mjs` into a deterministic
 * tar.gz, and content-addresses it. Pure (string in → bytes out) — no fs, no network.
 */
export function buildSingleFileArtifact(
  source: string,
  carryAssets: readonly { name: string; data: Buffer }[] = [],
): BuiltServerArtifact {
  const js = ts.transpileModule(source, {
    fileName: "index.ts",
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  }).outputText;

  // Pack the built (runnable) entry + the author's ORIGINAL source (verbatim, for display/quick-edit)
  // under the unified `.bw-src/` tree — so the detail read surfaces single- and multi-file the same way.
  // `carryAssets` are the prior version's bundled non-source files (skills/configs/templates), re-packed
  // verbatim so a web quick-edit (which rebuilds from source only) never drops them. They arrive already
  // sorted, so appending keeps a no-asset build byte-identical to before.
  const tar = tarFiles([
    { name: SINGLE_FILE_ENTRY, data: Buffer.from(js, "utf8") },
    { name: WORKFLOW_ARTIFACT_SINGLE_SOURCE, data: Buffer.from(source, "utf8") },
    ...carryAssets,
  ]);
  const tarball = new Uint8Array(gzipSync(tar, { level: 9 }));
  return {
    tarball,
    digest: createHash("sha256").update(tarball).digest("hex"),
    size: tarball.length,
    entry: SINGLE_FILE_ENTRY,
    sdkVersion: UNPINNED_SDK,
    lockfileDigest: null,
  };
}

const TAR_BLOCK = 512;

/** Build a standards-compliant ustar archive holding the given regular files in order (deterministic:
 *  mtime/uid/gid zeroed). Readable by node-tar / system tar (the worker extractor) and our own reader.
 *  Exported so the multi-file package builder reuses the exact same packing. */
export function tarFiles(files: { name: string; data: Buffer }[]): Buffer {
  const parts = files.map((f) => tarEntry(f.name, f.data));
  parts.push(Buffer.alloc(TAR_BLOCK * 2, 0)); // two zero blocks = end-of-archive marker
  return Buffer.concat(parts);
}

/** One ustar entry: a 512-byte header + the data padded to a block boundary (no end-of-archive). */
function tarEntry(name: string, data: Buffer): Buffer {
  if (Buffer.byteLength(name) > 100) {
    // Names are short (`index.mjs`, `.bw-src/lib/util.ts`); guard a long name (no PAX support).
    throw new Error(`tar entry name too long: ${name}`);
  }
  const header = Buffer.alloc(TAR_BLOCK, 0);
  header.write(name, 0, 100, "utf8"); // name
  writeOctal(header, 0o644, 100, 8); // mode
  writeOctal(header, 0, 108, 8); // uid
  writeOctal(header, 0, 116, 8); // gid
  writeOctal(header, data.length, 124, 12); // size
  writeOctal(header, 0, 136, 12); // mtime (deterministic)
  header.write("0", 156, 1, "ascii"); // typeflag = regular file
  header.write("ustar\0", 257, 6, "binary"); // magic
  header.write("00", 263, 2, "binary"); // version

  // Checksum: sum every header byte with the checksum field initialized to 8 spaces, then write it as
  // 6 octal digits + NUL + space (the conventional ustar form).
  header.write("        ", 148, 8, "ascii");
  let sum = 0;
  for (const b of header) sum += b;
  const chk = sum.toString(8).padStart(6, "0").slice(-6);
  header.write(`${chk}\0 `, 148, 8, "ascii");

  const padLen = (TAR_BLOCK - (data.length % TAR_BLOCK)) % TAR_BLOCK;
  return Buffer.concat([header, data, Buffer.alloc(padLen, 0)]);
}

/** Write a tar numeric field: (length-1) zero-padded octal digits + NUL. */
function writeOctal(buf: Buffer, value: number, offset: number, length: number): void {
  const digits = value
    .toString(8)
    .padStart(length - 1, "0")
    .slice(-(length - 1));
  buf.write(`${digits}\0`, offset, length, "ascii");
}
