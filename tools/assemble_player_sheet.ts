#!/usr/bin/env bun
/**
 * Assemble the player walk sheet from generated frames.
 *
 * Usage: bun tools/assemble_player_sheet.ts [--art-dir DIR]
 *
 * The frames land in art/npcs/ as `player_walk_<dir>_<pose>.png` via the admin art pipeline; this
 * composites them into `player_walk.png`. The player reads cells by (facing, walk phase).
 */

import { join } from "node:path";

import { assembleWalkSheet } from "./lib/sheets";

const argv = process.argv.slice(2);
const artFlag = argv.indexOf("--art-dir");
const artDir = artFlag >= 0 && argv[artFlag + 1]
  ? argv[artFlag + 1]!
  : join(import.meta.dir, "..", "client", "content", "art", "npcs");

const { path, width, height } = await assembleWalkSheet({ artDir, prefix: "player" });
console.log(`wrote ${path} (${width}x${height})`);
