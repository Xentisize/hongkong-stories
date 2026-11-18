import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  BUNDLE_SCHEMA,
  buildAssetIndex,
  bundlePath,
  canonicalJson,
  collectAssetRefs,
  resolveInheritance,
  type BundleAsset,
  type GameManifest,
} from "@hkstories/core";

import { assetsDir, contentDir, loadEntriesFrom } from "@/lib/content";

/**
 * Build the portable game bundle — the artifact a person or a model receives.
 *
 * One `game.json` describing the pack (version, byte hash, resolved hash, document list) plus every
 * media file the content references, hashed. The same build is what `tools/export_bundle.ts` writes
 * and what `tools/import_bundle.ts` verifies, so an export from the admin and an export from a
 * terminal are the same bytes-and-shape, and the CI round trip exercises the product's path.
 *
 * Zip comes from the `zip` binary: writing one in-process would mean a second implementation of an
 * archive format, and a single-operator admin is not the place to save a subprocess. A host without
 * it fails loudly (see `zipDirectory`) rather than producing an unopenable file.
 */

export interface BuiltBundle {
  /**
   * The archive bytes, as the `Buffer<ArrayBuffer>` that `readFile` returns — a plain
   * `Buffer<ArrayBufferLike>` is not assignable to `BodyInit`, which is why the type is spelled out.
   */
  zip: Buffer<ArrayBuffer>;
  manifest: GameManifest;
  /** Referenced files that were not on disk. Non-empty means the bundle is incomplete. */
  missing: Array<{ path: string; refs: string[] }>;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function buildGameBundle(): Promise<BuiltBundle> {
  const content = contentDir();
  const assets = assetsDir();
  const { entries, manifest: source } = await loadEntriesFrom(content);
  const files = Array.isArray(source["files"]) ? (source["files"] as string[]) : [];

  // Resolve inheritance first: the bundle describes what a client would load, so a chain that would
  // ship unresolved is caught here rather than by whoever opens the bundle.
  const resolved = resolveInheritance(entries);
  const resolvedHash = sha256Hex(new TextEncoder().encode(canonicalJson(resolved.entries))).slice(0, 12);

  const staged: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const relative of files) {
    staged.push({ path: bundlePath("content", relative), bytes: await readFile(join(content, relative)) });
  }

  const wanted = new Map<string, { path: string; refs: string[]; source: string }>();
  for (const asset of collectAssetRefs(resolved.entries)) {
    const path = bundlePath(asset.root, asset.path);
    const sourcePath = join(asset.root === "content" ? content : assets, asset.path);
    const existing = wanted.get(path);
    if (existing) existing.refs.push(asset.ref);
    else wanted.set(path, { path, refs: [asset.ref], source: sourcePath });
  }

  const missing: BuiltBundle["missing"] = [];
  const found: BundleAsset[] = [];
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await readFile(join(content, "settings", "game.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    // A pack without a settings document is the validator's problem, not the exporter's.
  }

  for (const entry of [...wanted.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(entry.source));
    } catch {
      missing.push({ path: entry.path, refs: entry.refs });
      continue;
    }
    staged.push({ path: entry.path, bytes });
    found.push({ path: entry.path, bytes: bytes.byteLength, sha256: sha256Hex(bytes), refs: entry.refs });
  }

  const manifest: GameManifest = {
    bundle_schema: BUNDLE_SCHEMA,
    game: { id: "hongkong-stories", title: settings["title"] },
    created_at: new Date().toISOString(),
    content: {
      version: Number(source["version"] ?? 0),
      content_hash: String(source["content_hash"] ?? ""),
      resolved_hash: resolvedHash,
      files: files.map((relative) => bundlePath("content", relative)),
    },
    assets: buildAssetIndex(found),
  };

  staged.push({
    path: "game.json",
    bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n"),
  });

  const stage = await mkdtemp(join(tmpdir(), "hks-bundle-"));
  try {
    for (const file of staged) {
      const target = join(stage, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.bytes);
    }

    const zipPath = join(stage, "..", `hks-bundle-${manifest.content.resolved_hash}.zip`);
    const result = Bun.spawnSync(["zip", "-r", "-q", "-X", zipPath, "."], { cwd: stage });
    if (result.exitCode !== 0) {
      throw new Error(
        `zip failed (${result.stderr.toString().trim() || `exit ${result.exitCode}`}) — the host needs the 'zip' CLI to export a bundle`,
      );
    }
    const zip = await readFile(zipPath);
    await rm(zipPath, { force: true });
    return { zip, manifest, missing };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Kept next to the bundle build so a caller can list what a pack references without building one. */
export async function referencedAssets(): Promise<string[]> {
  const { entries } = await loadEntriesFrom(contentDir());
  return collectAssetRefs(resolveInheritance(entries).entries).map(
    (asset) => `${asset.root}/${asset.path}`,
  );
}
