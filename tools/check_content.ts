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

import { join, resolve } from "node:path";

import { validatePack } from "@hkstories/core";

import { loadContentFrom } from "../apps/server/src/lib/content";

const target = process.argv[2];
const root = target ? resolve(target) : join(import.meta.dir, "..", "client", "content");

const { pack } = await loadContentFrom(root);
const issues = validatePack(pack);

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
