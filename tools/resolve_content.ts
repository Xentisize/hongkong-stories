#!/usr/bin/env bun
/**
 * Resolve `extends` across the content pack — the prototype's evidence run.
 *
 * Usage: bun tools/resolve_content.ts [content_dir]
 *
 * Read-only: nothing here is wired into publish. It answers the three questions the design rests
 * on, on the real pack rather than a fixture:
 *
 *   - does every chain resolve, and what does the resolver refuse;
 *   - how long does an authoring-time resolve cost at this size;
 *   - what identity would a resolved pack have (it exists only in memory, so the manifest's byte
 *     hash cannot describe it — `canonicalJson` can).
 *
 * Exits 0 when every document resolves, 1 otherwise, so it can become the publish gate unchanged.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { canonicalJson, packFromEntries, resolveInheritance, validatePack } from "@hkstories/core";

const target = process.argv[2];
const root = target ? resolve(target) : join(import.meta.dir, "..", "client", "content");

let manifest: { files?: unknown; content_hash?: unknown };
try {
  manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as typeof manifest;
} catch (error) {
  console.error(`cannot read the manifest at ${root}: ${String(error)}`);
  console.error("if it is missing or stale: bun tools/gen_content_manifest.ts");
  process.exit(1);
}

const files = Array.isArray(manifest.files) ? (manifest.files as string[]) : [];

const readStart = performance.now();
const entries: Record<string, Record<string, unknown>> = {};
let bytes = 0;
for (const relative of files) {
  const text = await readFile(join(root, relative), "utf8");
  bytes += text.length;
  entries[relative] = JSON.parse(text) as Record<string, unknown>;
}
const readEnd = performance.now();

const resolved = resolveInheritance(entries);
const resolveEnd = performance.now();

const pack = packFromEntries(resolved.entries);
const issues = validatePack(pack);
const validateEnd = performance.now();

const hashStart = performance.now();
const hash = createHash("sha256")
  .update(canonicalJson(resolved.entries))
  .digest("hex")
  .slice(0, 12);
const hashEnd = performance.now();

const errors = resolved.issues.filter((issue) => issue.level === "error");
const withParent = Object.values(entries).filter(
  (doc) => typeof doc["extends"] === "string" && doc["extends"] !== "",
).length;
const templates = files.length - Object.keys(resolved.entries).length;

const ms = (value: number) => `${value.toFixed(1)} ms`;

console.log(`resolved ${files.length} files (${(bytes / 1024).toFixed(0)} KiB)`);
console.log(`  ${withParent} use \`extends\` · ${templates} template(s) held back from the pack`);
console.log(`  read+parse ${ms(readEnd - readStart)} · resolve ${ms(resolveEnd - readEnd)}`);
console.log(`  validate ${ms(validateEnd - resolveEnd)} · hash ${ms(hashEnd - hashStart)}`);
console.log(
  `  resolved hash ${hash} · manifest content_hash ${String(manifest.content_hash ?? "(none)")}`,
);
console.log(
  `  pack issues: ${issues.filter((issue) => issue.level === "error").length} error(s), ` +
    `${issues.filter((issue) => issue.level === "warning").length} warning(s)`,
);

if (resolved.issues.length > 0) {
  console.log("\nresolve issues:");
  for (const issue of resolved.issues) {
    console.log(`  [${issue.level === "error" ? "E" : "W"}] ${issue.path}: ${issue.message}`);
  }
}

process.exit(errors.length === 0 ? 0 : 1);
