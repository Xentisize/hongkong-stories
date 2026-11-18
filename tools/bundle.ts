/**
 * The portable game bundle (`game.zip`) — root document, pack and media, in one file.
 *
 * The bundle is the "export everything to create a game" artifact: one `game.json` that names the
 * pack, its resolved identity and every media file the content references, followed by those bytes
 * under the same relative paths the clients already use. Import is the same gate as publish — verify
 * the hashes, resolve inheritance, validate — so a bundle from someone else either loads or says
 * exactly why it does not.
 *
 * One deliberate exclusion: binary media is carried as files, never base64 inside JSON. The root
 * document indexes it by path, size and hash instead, which keeps the text reviewable and makes a
 * swapped or truncated asset a verification failure rather than a silent visual bug.
 *
 * The logic here is pure — no filesystem, no zipping — so the verification rules can be tested
 * without writing a 7 MB archive per case.
 */

import { collectAssetRefs, isRecord, toKey, type ContentEntity } from "@hkstories/core";

/** Bumped when a change would make an older importer misread a newer bundle. */
export const BUNDLE_SCHEMA = 1;

export interface BundleContent {
  /** Pack version from the manifest this bundle was cut from. */
  version: number;
  /** Byte hash the manifest recorded for the *source* files. */
  content_hash: string;
  /** `canonicalJson` hash of the resolved pack — what a client would actually load. */
  resolved_hash: string;
  /** Bundle-relative document paths, sorted. */
  files: string[];
}

export interface BundleAsset {
  /** Bundle-relative path, e.g. `assets/tiles/p1_tiles.png`. */
  path: string;
  bytes: number;
  sha256: string;
  /** References in content that pointed here, so a missing file names who needed it. */
  refs: string[];
}

export interface GameManifest {
  bundle_schema: number;
  game: { id: string; title?: unknown };
  created_at: string;
  content: BundleContent;
  assets: BundleAsset[];
}

/** Where a file lives inside the bundle: the two roots the clients already resolve against. */
export function bundlePath(root: "content" | "assets", path: string): string {
  return `${root}/${path}`;
}

/** Sort and de-duplicate what the export found, so the same content always produces the same index. */
export function buildAssetIndex(
  found: Array<{ path: string; bytes: number; sha256: string; refs: string[] }>,
): BundleAsset[] {
  const byPath = new Map<string, BundleAsset>();
  for (const entry of found) {
    const existing = byPath.get(entry.path);
    if (existing) {
      existing.refs = [...new Set([...existing.refs, ...entry.refs])].sort();
      continue;
    }
    byPath.set(entry.path, { ...entry, refs: [...new Set(entry.refs)].sort() });
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Every asset the content references must be inside the bundle.
 *
 * This is the check that makes the manifest trustworthy rather than merely self-consistent: an
 * export that cannot find a referenced file omits it from the index, so "the index matches the
 * archive" stays true while the game is missing art. Verifying from the *content* is the only way
 * to see that, and it is why the importer re-derives the references instead of trusting the list.
 */
export function verifyContentAssets(
  entries: Record<string, ContentEntity>,
  has: (path: string) => boolean,
): BundleIssue[] {
  const issues: BundleIssue[] = [];
  for (const asset of collectAssetRefs(entries)) {
    const path = bundlePath(asset.root, asset.path);
    if (!has(path)) {
      issues.push({
        level: "error",
        path,
        message: `referenced by content ('${asset.ref}') but not in the bundle`,
      });
    }
  }
  return issues;
}

export type BundleIssueLevel = "error";

export interface BundleIssue {
  level: BundleIssueLevel;
  path: string;
  message: string;
}

/** What the verifier is allowed to know about the unpacked bundle. */
export interface BundleReader {
  has(path: string): boolean;
  read(path: string): Uint8Array | null;
  /** sha256 hex of the bytes, supplied so this stays free of platform crypto. */
  digest(bytes: Uint8Array): string;
}

/** True when the value claims to be a game manifest at all — the cheap gate before reading it. */
export function isGameManifest(value: unknown): value is GameManifest {
  return isRecord(value) && typeof value["bundle_schema"] === "number";
}

/**
 * Check a bundle against its own manifest.
 *
 * Errors only, and every one of them is a reason not to import: an unknown schema version (an
 * importer that guesses is an importer that corrupts a pack), a document the manifest lists but the
 * archive lacks, a media file that is missing or whose bytes are not the ones that were exported.
 */
export function verifyBundle(manifest: unknown, reader: BundleReader): BundleIssue[] {
  const issues: BundleIssue[] = [];
  const err = (path: string, message: string) => issues.push({ level: "error", path, message });

  if (!isRecord(manifest)) {
    err("game.json", "not a JSON object");
    return issues;
  }

  const schema = toKey(manifest["bundle_schema"]);
  if (schema !== String(BUNDLE_SCHEMA)) {
    err("game.json", `bundle_schema '${schema}' is not supported (this build reads ${BUNDLE_SCHEMA})`);
    return issues; // the rest of the shape is only meaningful for a version we understand
  }

  const game = manifest["game"];
  if (!isRecord(game) || toKey(game["id"]) === "") {
    err("game.json", "game.id is required");
  }

  const content = manifest["content"];
  if (!isRecord(content)) {
    err("game.json", "content block is required");
    return issues;
  }

  const files = content["files"];
  if (!Array.isArray(files) || files.length === 0) {
    err("game.json", "content.files must list the documents");
  } else {
    for (const file of files) {
      const path = toKey(file);
      if (path === "") err("game.json", "content.files contains a non-string entry");
      else if (!reader.has(path)) err(path, "listed in the manifest but missing from the bundle");
    }
  }

  const resolvedHash = toKey(content["resolved_hash"]);
  if (resolvedHash === "") err("game.json", "content.resolved_hash is required");

  const assets = manifest["assets"];
  if (!Array.isArray(assets)) {
    err("game.json", "assets must be a list");
    return issues;
  }

  for (const entry of assets) {
    if (!isRecord(entry)) {
      err("game.json", "assets contains a non-object entry");
      continue;
    }
    const path = toKey(entry["path"]);
    if (path === "") {
      err("game.json", "an asset entry has no path");
      continue;
    }
    if (!reader.has(path)) {
      const wanted = Array.isArray(entry["refs"]) ? entry["refs"].map(toKey).filter(Boolean) : [];
      err(path, wanted.length > 0 ? `missing (needed by ${wanted.join(", ")})` : "missing");
      continue;
    }

    const bytes = reader.read(path);
    if (bytes === null) {
      err(path, "could not be read");
      continue;
    }

    const expected = toKey(entry["sha256"]);
    const actual = reader.digest(bytes);
    if (expected !== "" && expected !== actual) {
      err(path, `sha256 mismatch (manifest ${expected.slice(0, 12)}…, file ${actual.slice(0, 12)}…)`);
      continue;
    }

    const declared = Number(entry["bytes"]);
    if (Number.isFinite(declared) && declared !== bytes.byteLength) {
      err(path, `size mismatch (manifest ${declared} bytes, file ${bytes.byteLength})`);
    }
  }

  return issues;
}
