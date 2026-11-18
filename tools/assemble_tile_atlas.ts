#!/usr/bin/env bun
/**
 * Assemble the tile atlas from generated tiles (client/content/art/tiles/).
 *
 * Every location's `legend` reads four atlas coordinates: '.' [0,0] floor, ',' [1,0] alt,
 * '#' [2,0] wall, 'D' [3,0] door — so the atlas is four 24px tiles in one 96px row. The tiles come
 * from the admin art pipeline (palette-snapped, no outline); this composites them and backs up the
 * placeholder once so a rollback stays possible.
 *
 * Usage: bun tools/assemble_tile_atlas.ts [--prefix _2027] [--out p1_tiles.png]
 */

import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";

const TILE = 24;
const ORDER = ["floor", "alt", "wall", "door"];

const root = join(import.meta.dir, "..");
const tilesDir = join(root, "client", "content", "art", "tiles");
const assetsDir = join(root, "client", "assets", "tiles");

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1]! : fallback;
};

const prefix = flag("--prefix", "");
const outName = flag("--out", "p1_tiles.png");

const atlasPath = join(assetsDir, outName);
const backup = atlasPath.replace(/\.png$/, "_placeholder.png");

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Only the bare (unprefixed) atlas is the placeholder; keep one copy before it is overwritten.
if (prefix === "" && !(await exists(backup))) {
  await copyFile(atlasPath, backup);
  console.log(`backed up the placeholder atlas -> ${backup}`);
}

const composites: sharp.OverlayOptions[] = [];
for (const [index, name] of ORDER.entries()) {
  const path = join(tilesDir, `${name}${prefix}.png`);
  const source = await readFile(path);
  const meta = await sharp(source).metadata();
  const cell =
    meta.width === TILE && meta.height === TILE
      ? source
      : await sharp(source).resize(TILE, TILE, { kernel: "nearest" }).png().toBuffer();
  composites.push({ input: cell, left: index * TILE, top: 0 });
  console.log(`  [${index},0] ${name}${prefix}.png`);
}

const atlas = await sharp({
  create: {
    width: TILE * ORDER.length,
    height: TILE,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite(composites)
  .png()
  .toBuffer();

await mkdir(assetsDir, { recursive: true });
await writeFile(atlasPath, atlas);
console.log(`wrote ${atlasPath} (${TILE * ORDER.length}x${TILE})`);
