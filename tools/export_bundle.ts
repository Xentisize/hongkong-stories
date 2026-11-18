#!/usr/bin/env bun
/**
 * Export the whole game as one portable bundle — `game.zip` (PLAN: everything-is-data).
 *
 * Usage: bun tools/export_bundle.ts [--out build/game.zip] [--content client/content]
 *
 * The bundle is `game.json` plus the pack and every media file the content references, under the
 * two roots the clients already resolve against (`content/…`, `assets/…`). It is the artifact you
 * hand to someone else, or to a model, and it is self-describing: the root document records the pack
 * version, the resolved identity of the content and a sha256 per media file.
 *
 * Nothing here writes into the repo except the output archive.
 */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  canonicalJson,
  collectAssetRefs,
  resolveInheritance,
  type ContentEntity,
} from "@hkstories/core";

import {
  BUNDLE_SCHEMA,
  buildAssetIndex,
  bundlePath,
  type BundleAsset,
  type GameManifest,
} from "./bundle";
import { sha256Hex, stageFiles, zipDirectory, type StagedFile } from "./bundle_io";

const repoRoot = join(import.meta.dir, "..");

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

const contentDir = resolve(option("content", join(repoRoot, "client", "content")));
const assetsDir = resolve(option("assets", join(repoRoot, "client", "assets")));
const output = resolve(option("out", join(repoRoot, "build", "game.zip")));

const manifestText = await readFile(join(contentDir, "manifest.json"), "utf8").catch((error) => {
  console.error(`cannot read the manifest in ${contentDir}: ${String(error)}`);
  console.error("if it is missing or stale: bun tools/gen_content_manifest.ts");
  process.exit(1);
});
const sourceManifest = JSON.parse(manifestText) as { version?: number; content_hash?: string; files?: string[] };
const files = Array.isArray(sourceManifest.files) ? sourceManifest.files : [];

// --- the pack -----------------------------------------------------------------------------

const entries: Record<string, ContentEntity> = {};
const staged: StagedFile[] = [];
for (const relative of files) {
  const bytes = new Uint8Array(await readFile(join(contentDir, relative)));
  entries[relative] = JSON.parse(new TextDecoder().decode(bytes)) as ContentEntity;
  staged.push({ path: bundlePath("content", relative), bytes });
}

// Resolve inheritance first: the bundle describes what a client would actually load, so a chain
// that would ship unresolved is caught here rather than by whoever opens the bundle.
const resolved = resolveInheritance(entries);
const resolvedHash = sha256Hex(new TextEncoder().encode(canonicalJson(resolved.entries))).slice(0, 12);

// --- the media the content needs ----------------------------------------------------------

const wanted = new Map<string, { path: string; refs: string[]; source: string }>();
for (const asset of collectAssetRefs(resolved.entries)) {
  const path = bundlePath(asset.root, asset.path);
  const source = join(asset.root === "content" ? contentDir : assetsDir, asset.path);
  const entry = wanted.get(path);
  if (entry) entry.refs.push(asset.ref);
  else wanted.set(path, { path, refs: [asset.ref], source });
}

const missing: Array<{ path: string; refs: string[] }> = [];
const found: BundleAsset[] = [];
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

// --- game.json ----------------------------------------------------------------------------

const gameManifest: GameManifest = {
  bundle_schema: BUNDLE_SCHEMA,
  game: {
    id: "hongkong-stories",
    title: JSON.parse(
      new TextDecoder().decode(
        await readFile(join(contentDir, "settings", "game.json")).catch(() => Buffer.from("{}")),
      ),
    )?.["title"],
  },
  created_at: new Date().toISOString(),
  content: {
    version: Number(sourceManifest.version ?? 0),
    content_hash: String(sourceManifest.content_hash ?? ""),
    resolved_hash: resolvedHash,
    files: files.map((relative) => bundlePath("content", relative)),
  },
  assets: buildAssetIndex(found),
};

staged.push({
  path: "game.json",
  bytes: new TextEncoder().encode(JSON.stringify(gameManifest, null, 2) + "\n"),
});

// --- zip ----------------------------------------------------------------------------------

const stage = await mkdtemp(join(tmpdir(), "hks-bundle-"));
try {
  await stageFiles(stage, staged);
  await mkdir(resolve(output, ".."), { recursive: true });
  await zipDirectory(stage, output);

  const archive = new Uint8Array(await readFile(output));
  const assetBytes = found.reduce((total, entry) => total + entry.bytes, 0);

  console.log(`bundle → ${output}`);
  console.log(
    `  ${files.length} document(s), ${found.length} media file(s) (${(assetBytes / 1024 / 1024).toFixed(1)} MiB)`,
  );
  console.log(`  archive ${(archive.byteLength / 1024 / 1024).toFixed(1)} MiB`);
  console.log(
    `  content v${gameManifest.content.version} · resolved ${resolvedHash} · source ${gameManifest.content.content_hash || "(none)"}`,
  );

  if (resolved.issues.length > 0) {
    console.log("\nresolve issues:");
    for (const issue of resolved.issues) console.log(`  [${issue.level[0]!.toUpperCase()}] ${issue.path}: ${issue.message}`);
  }
  if (missing.length > 0) {
    console.error(`\n${missing.length} referenced file(s) missing — the bundle is incomplete:`);
    for (const entry of missing) console.error(`  ${entry.path} ← ${entry.refs.join(", ")}`);
  }

  const failed = resolved.issues.some((issue) => issue.level === "error") || missing.length > 0;
  process.exit(failed ? 1 : 0);
} finally {
  await rm(stage, { recursive: true, force: true });
}
