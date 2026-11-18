#!/usr/bin/env bun
/**
 * Wire generated sprite sheets into NPC definitions (PLAN 8).
 *
 * For every npc JSON whose id has a generated sprite at content/art/npcs/<id>.png, set
 * `sprite: {sheet, frames:{idle:[0]}}` unless one is already set. Run after the sprite generation
 * loop, then regenerate the manifest (the file list does not change, but the pack hash must).
 *
 * Usage: bun tools/wire_npc_sprites.ts
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const content = join(root, "client", "content");
const art = join(content, "art", "npcs");

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

let wired = 0;
let skipped = 0;

for (const name of (await readdir(join(content, "npcs"))).sort()) {
  if (!name.endsWith(".json")) continue;

  const path = join(content, "npcs", name);
  const npc = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const id = String(npc["id"] ?? "");
  if (!id) continue;

  if (!(await exists(join(art, `${id}.png`)))) continue;

  const existing = npc["sprite"];
  if (
    existing !== null &&
    typeof existing === "object" &&
    !Array.isArray(existing) &&
    (existing as Record<string, unknown>)["sheet"]
  ) {
    skipped += 1;
    continue;
  }

  npc["sprite"] = { sheet: `art/npcs/${id}.png`, frames: { idle: [0] } };
  await writeFile(path, JSON.stringify(npc, null, 2) + "\n", "utf8");
  wired += 1;
  console.log(`wired ${id}`);
}

console.log(`wired ${wired}, already set ${skipped}`);
