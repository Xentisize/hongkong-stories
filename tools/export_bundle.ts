#!/usr/bin/env bun
/**
 * Export the whole game as one portable bundle — `game.zip` (PLAN: everything-is-data).
 *
 * Usage: bun tools/export_bundle.ts [--out build/game.zip] [--content client/content] [--assets client/assets]
 *
 * The build itself lives in `apps/server/src/lib/bundle.ts`, shared with the admin's export route,
 * so a terminal export and a button export are the same artifact and the CI round trip exercises
 * the product's path rather than a parallel one.
 *
 * Nothing here writes into the repo except the output archive.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { buildGameBundle } from "../apps/server/src/lib/bundle";

const repoRoot = join(import.meta.dir, "..");

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

// The server's roots are env-driven (`HKS_CONTENT_DIR` / `HKS_ASSETS_DIR`) and default to paths
// relative to `apps/server` — right for the server, wrong for a script run from the repo root. So
// the CLI pins them here, and the flags override that.
process.env["HKS_CONTENT_DIR"] ??= join(repoRoot, "client", "content");
process.env["HKS_ASSETS_DIR"] ??= join(repoRoot, "client", "assets");

const contentOption = option("content", "");
if (contentOption !== "") process.env["HKS_CONTENT_DIR"] = resolve(contentOption);
const assetsOption = option("assets", "");
if (assetsOption !== "") process.env["HKS_ASSETS_DIR"] = resolve(assetsOption);

const output = resolve(option("out", join(repoRoot, "build", "game.zip")));

const built = await buildGameBundle();

await mkdir(join(output, ".."), { recursive: true });
await writeFile(output, built.zip);

console.log(`bundle → ${output}`);
console.log(
  `  ${built.manifest.content.files.length} document(s), ${built.manifest.assets.length} media file(s) (${(
    built.manifest.assets.reduce((total, entry) => total + entry.bytes, 0) /
    1024 /
    1024
  ).toFixed(1)} MiB)`,
);
console.log(`  archive ${(built.zip.byteLength / 1024 / 1024).toFixed(1)} MiB`);
console.log(
  `  content v${built.manifest.content.version} · resolved ${built.manifest.content.resolved_hash} · source ${built.manifest.content.content_hash || "(none)"}`,
);

if (built.missing.length > 0) {
  console.error(`\n${built.missing.length} referenced file(s) missing — the bundle is incomplete:`);
  for (const entry of built.missing) console.error(`  ${entry.path} ← ${entry.refs.join(", ")}`);
  process.exit(1);
}
