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
import { computeManifest, manifestDrift } from "../apps/server/src/lib/manifest";

const target = process.argv[2];
const root = target ? resolve(target) : join(import.meta.dir, "..", "client", "content");

// `loadContentFrom` reads the manifest first, so a missing or unparsable one would otherwise throw
// out of the module and lose every diagnostic below — the run would end in a stack trace instead of
// the one line telling the author what to do.
let pack: Awaited<ReturnType<typeof loadContentFrom>>["pack"];
try {
  ({ pack } = await loadContentFrom(root));
} catch (error) {
  console.error(`cannot load the pack at ${root}: ${String(error)}`);
  console.error("if the manifest is missing or stale: bun tools/gen_content_manifest.ts");
  process.exit(1);
}

const issues = validatePack(pack);

// The manifest's `content_hash` is what a booted client compares to decide whether to hot-pack. A
// stale one is a silent failure: an author edits content, the hash does not move, and every client
// keeps running the old pack. This is checked here because nothing else was checking it.
let committed: { content_hash?: unknown; files?: unknown } = {};
try {
  committed = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as typeof committed;
} catch {
  // A race with a regeneration, or a truncated write: reported as drift rather than crashing.
}

const fresh = await computeManifest(root);
const drift = manifestDrift(committed, fresh);
// A file whose entity has no `id` is now reported by `validatePack` itself (the pack records what
// it dropped), so only the filename agreement is left to check here.
for (const file of fresh.files) {
  let entity: unknown = null;
  try {
    entity = JSON.parse(await readFile(join(root, file), "utf8"));
  } catch {
    issues.push({ level: "error", path: file, message: "not valid JSON" });
    continue;
  }

  if (!isRecord(entity) || typeof entity["id"] !== "string" || entity["id"].trim() === "") {
    continue; // already reported by validatePack
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
