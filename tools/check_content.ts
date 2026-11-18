#!/usr/bin/env bun
/**
 * Validate the content pack — the CI gate over the publish pipeline (PLAN 9.2, 11).
 *
 * Usage: bun tools/check_content.ts [content_dir]
 *
 * Exits 0 when there are no error-level issues; warnings are reported but do not fail. The rules
 * live in `@hkstories/core`, so this gate, the admin's inline checks and the publish refusal are
 * the same implementation rather than three that must be kept in agreement.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { isRecord, validatePack } from "@hkstories/core";

import { loadContentFrom } from "../apps/server/src/lib/content";
import { computeManifest } from "../apps/server/src/lib/manifest";

const target = process.argv[2];
const root = target ? resolve(target) : join(import.meta.dir, "..", "client", "content");

const { pack } = await loadContentFrom(root);
const issues = validatePack(pack);

// The manifest's `content_hash` is what a booted client compares to decide whether to hot-pack. A
// stale one is a silent failure: an author edits content, the hash does not move, and every client
// keeps running the old pack. This is checked here because nothing else was checking it.
const committed = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as {
  content_hash?: unknown;
  files?: unknown;
};
const fresh = await computeManifest(root);
const drift: string[] = [];
if (committed.content_hash !== fresh.content_hash) {
  drift.push(`content_hash ${String(committed.content_hash)} ≠ ${fresh.content_hash}`);
}
if (JSON.stringify(committed.files) !== JSON.stringify(fresh.files)) {
  drift.push(`the file list differs (${fresh.files.length} files hashed)`);
}
// A file that loses its `id` is dropped by `packFromEntries` with no trace: the entity stops
// existing and every rule that would have validated it simply does not run. That is how the settings
// document vanished on its first run, so the entries are checked directly.
for (const file of fresh.files) {
  let entity: unknown = null;
  try {
    entity = JSON.parse(await readFile(join(root, file), "utf8"));
  } catch {
    issues.push({ level: "error", path: file, message: "not valid JSON" });
    continue;
  }

  if (!isRecord(entity) || typeof entity["id"] !== "string" || entity["id"].trim() === "") {
    issues.push({
      level: "error",
      path: file,
      message: "entity has no 'id' — the loader drops it silently",
    });
    continue;
  }

  // The loader keys a table by `id` while publish writes to the filename. When they disagree the
  // entity is stored under one name and shipped under another, so the next regeneration reports a
  // phantom change and a draft can reference an id nothing loads.
  const filename = (file.split("/").pop() ?? file).replace(/\.json$/, "");
  if (entity["id"] !== filename) {
    issues.push({
      level: "error",
      path: file,
      message: `id '${entity["id"]}' does not match the filename '${filename}'`,
    });
  }
}

if (drift.length > 0) {
  issues.push({
    level: "error",
    path: "manifest.json",
    message: `stale manifest: ${drift.join("; ")} — run bun tools/gen_content_manifest.ts`,
  });
}

const errors = issues.filter((issue) => issue.level === "error");
const warnings = issues.filter((issue) => issue.level === "warn");
const entities = Object.values(pack.tables).reduce(
  (total, rows) => total + Object.keys(rows).length,
  0,
);

console.log(
  `validated ${entities} entities (${errors.length} errors, ${warnings.length} warnings)`,
);
for (const issue of issues) {
  console.log(`  [${issue.level === "error" ? "E" : "W"}] ${issue.path}: ${issue.message}`);
}

process.exit(errors.length > 0 ? 1 : 0);
