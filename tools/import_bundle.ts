#!/usr/bin/env bun
/**
 * Import a game bundle — verify it, then resolve and validate its content (PLAN: everything-is-data).
 *
 * Usage: bun tools/import_bundle.ts [game.zip] [--into <dir>]
 *
 * Dry-run by default: it verifies every hash, resolves `extends`, validates the pack against the
 * same rules publish uses, and prints what it found. Nothing is written unless `--into` names the
 * directory to unpack the pack and media into.
 *
 * The gate is the point. A bundle from someone else — or from a model — is untrusted input: an
 * unknown schema version, a missing document, one changed byte of art or a pack that does not
 * validate is a refusal with a path and a reason, not a half-imported game.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  canonicalJson,
  isPublishable,
  packFromEntries,
  resolveInheritance,
  validatePack,
  type ContentEntity,
} from "@hkstories/core";

import { isGameManifest, verifyBundle, verifyContentAssets, type GameManifest } from "./bundle";
import { readDirectoryIndex, sha256Hex, stageFiles, unzipInto } from "./bundle_io";

const repoRoot = join(import.meta.dir, "..");

function option(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1]! : null;
}

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const archive = resolve(positional[0] ?? join(repoRoot, "build", "game.zip"));
const into = option("into");

const unpacked = await mkdtemp(join(tmpdir(), "hks-import-"));
try {
  try {
    await unzipInto(archive, unpacked);
  } catch (error) {
    console.error(`cannot unpack ${archive}: ${String(error)}`);
    process.exit(1);
  }

  const index = await readDirectoryIndex(unpacked);

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(index.read("game.json") ?? new Uint8Array()));
  } catch (error) {
    console.error(`game.json is not valid JSON: ${String(error)}`);
    process.exit(1);
  }

  if (!isGameManifest(parsed)) {
    console.error("game.json is not a game bundle (no bundle_schema)");
    process.exit(1);
  }
  const manifest: GameManifest = parsed;

  const issues = verifyBundle(manifest, index);
  if (issues.length > 0) {
    console.error(`bundle verification failed — ${issues.length} problem(s), nothing imported:`);
    for (const issue of issues) console.error(`  [E] ${issue.path}: ${issue.message}`);
    process.exit(1);
  }

  // --- content ------------------------------------------------------------------------

  const entries: Record<string, ContentEntity> = {};
  for (const path of manifest.content.files) {
    const bytes = index.read(path);
    if (bytes === null) continue; // verify already refused this; kept for type narrowing
    entries[path.replace(/^content\//, "")] = JSON.parse(new TextDecoder().decode(bytes)) as ContentEntity;
  }

  const resolved = resolveInheritance(entries);
  const resolvedHash = sha256Hex(new TextEncoder().encode(canonicalJson(resolved.entries))).slice(0, 12);
  const identityMatches = resolvedHash === manifest.content.resolved_hash;

  // The index is only self-consistent: an export that could not find a referenced file leaves it
  // out of the index, so the reference has to be re-derived from the content to be seen.
  const missingRefs = verifyContentAssets(entries, index.has);

  const pack = packFromEntries(resolved.entries);
  const packIssues = validatePack(pack);
  const validateErrors = packIssues.filter((issue) => issue.level === "error");

  const resolveErrors = resolved.issues.filter((issue) => issue.level === "error");

  console.log(`bundle ${archive}`);
  console.log(`  game ${manifest.game.id} · content v${manifest.content.version}`);
  console.log(
    `  ${manifest.content.files.length} document(s) · ${manifest.assets.length} media file(s) · verified`,
  );
  console.log(
    `  resolved ${resolvedHash} ${identityMatches ? "(matches the bundle)" : `(bundle says ${manifest.content.resolved_hash})`}`,
  );
  console.log(
    `  pack: ${validateErrors.length} error(s), ${packIssues.length - validateErrors.length} warning(s)`,
  );

  for (const issue of resolveErrors) console.error(`  [E] ${issue.path}: ${issue.message}`);
  for (const issue of missingRefs) console.error(`  [E] ${issue.path}: ${issue.message}`);
  for (const issue of validateErrors.slice(0, 20)) console.error(`  [E] ${issue.path}: ${issue.message}`);
  if (validateErrors.length > 20) console.error(`  … ${validateErrors.length - 20} more error(s)`);

  const trusted =
    identityMatches && resolveErrors.length === 0 && missingRefs.length === 0 && isPublishable(packIssues);
  if (!identityMatches) {
    console.error(
      "  the resolved content does not hash to what the bundle recorded — it was edited after export",
    );
  }

  if (into !== null) {
    if (!trusted) {
      console.error("\nrefusing to write: the bundle did not pass the gate");
      process.exit(1);
    }
    const target = resolve(into);
    const files = [
      ...manifest.content.files.map((path) => ({ path, bytes: index.read(path)! })),
      ...manifest.assets.map((asset) => ({ path: asset.path, bytes: index.read(asset.path)! })),
    ];
    await stageFiles(target, files);
    console.log(`\nwrote ${files.length} file(s) → ${target}`);
  } else if (trusted) {
    console.log("\ndry run — nothing written. Pass --into <dir> to unpack the pack and media.");
  }

  process.exit(trusted ? 0 : 1);
} finally {
  await rm(unpacked, { recursive: true, force: true });
}
