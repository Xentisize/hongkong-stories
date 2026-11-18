#!/usr/bin/env bun
/**
 * Regenerate `client/content/manifest.json` — the content hot-pack index (PLAN 5.7).
 *
 * Usage: bun tools/gen_content_manifest.ts [--bump] [content_dir]
 *
 * `--bump` increments the existing version (the publish path bumps it so booted clients hot-pack);
 * the bare form keeps version 1 for a fresh checkout. An optional content_dir lets tests publish
 * into an isolated copy.
 *
 * The hashing lives in `apps/server/src/lib/manifest.ts` because it is a **wire contract** — the
 * client decides whether to hot-pack from `content_hash` — so there is one implementation, and this
 * CLI is only the argument parsing around it.
 */

import { join, resolve } from "node:path";

import { regenerateManifest } from "../apps/server/src/lib/manifest";

const args = process.argv.slice(2);
const bump = args.includes("--bump");
const positional = args.filter((arg) => !arg.startsWith("--"));
const root = positional[0]
  ? resolve(positional[0])
  : join(import.meta.dir, "..", "client", "content");

const manifest = await regenerateManifest(root, { bump });

console.log(
  `wrote ${join(root, "manifest.json")} (v${manifest.version}, ${manifest.files.length} files, ` +
    `hash ${manifest.content_hash})`,
);
for (const entry of manifest.files) console.log("  " + entry);
