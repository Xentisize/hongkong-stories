#!/usr/bin/env bun
/**
 * Assemble NPC walk sheets from generated frames.
 *
 * Usage: bun tools/assemble_npc_sheet.ts npc_ch01_tai npc_ch01_ken ...
 *        [--art-dir DIR]  (defaults to client/content/art/npcs)
 *
 * Frames are `<npc_id>_walk_<dir>_<pose>.png`; the sheet is `<npc_id>_walk.png`, 4 columns
 * (down, right, left, up) x 2 rows (stand, step) of 26x34 cells.
 */

import { join } from "node:path";

import { assembleWalkSheet } from "./lib/sheets";

const argv = process.argv.slice(2);
const artFlag = argv.indexOf("--art-dir");
const artDir = artFlag >= 0 && argv[artFlag + 1]
  ? argv[artFlag + 1]!
  : join(import.meta.dir, "..", "client", "content", "art", "npcs");

const ids = argv.filter((arg, index) => !arg.startsWith("--") && index !== artFlag + 1);

if (ids.length === 0) {
  console.error("usage: bun tools/assemble_npc_sheet.ts <npc_id>... [--art-dir DIR]");
  process.exit(2);
}

for (const id of ids) {
  const { path, width, height } = await assembleWalkSheet({ artDir, prefix: id });
  console.log(`wrote ${path} (${width}x${height})`);
}
