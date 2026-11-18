#!/usr/bin/env bun
/**
 * Generate the tile atlas deterministically — "higher pixel quality" as *more pixels per tile*.
 *
 * The legacy atlas was four 24px cells cut from stale art. This draws the same four frames (plus a
 * small series of extras) at **48px**, so the game's 24px world tile gets twice the detail, and the
 * file is self-describing: a renderer slices by `image width / columns`, which is why no location
 * JSON changes and every existing map keeps rendering.
 *
 * Every pixel is written from `HK_PALETTE_V1` — the same immutable palette the Seedream pipeline
 * snaps to — so procedural tiles and generated art read as one world. The grain comes from a
 * seeded PRNG: the same command always produces the same bytes, which keeps the PNG reviewable and
 * diffs meaningful.
 *
 * Usage: bun tools/gen_tile_atlas.ts [--cell 48] [--out p1_tiles_2027.png]
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";

import { HK_PALETTE_V1, PALETTE_NAME } from "../apps/server/src/lib/palette";

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1]! : fallback;
};

const CELL = Number(flag("--cell", "48"));
const OUT = flag("--out", "p1_tiles_2027.png");
const root = join(import.meta.dir, "..");
const outPath = join(root, "client", "assets", "tiles", OUT);

/** Palette entries by name, so the drawing code reads as materials rather than numbers. */
const C = {
  black: HK_PALETTE_V1[0]!,
  warmBlack: HK_PALETTE_V1[1]!,
  darkGrey: HK_PALETTE_V1[2]!,
  midGrey: HK_PALETTE_V1[3]!,
  concreteShadow: HK_PALETTE_V1[4]!,
  darkWood: HK_PALETTE_V1[5]!,
  darkBrick: HK_PALETTE_V1[6]!,
  navy: HK_PALETTE_V1[7]!,
  greenDark: HK_PALETTE_V1[8]!,
  teal: HK_PALETTE_V1[9]!,
  rust: HK_PALETTE_V1[10]!,
  brick: HK_PALETTE_V1[11]!,
  awningGreen: HK_PALETTE_V1[13]!,
  concrete: HK_PALETTE_V1[14]!,
  midWood: HK_PALETTE_V1[15]!,
  signageRed: HK_PALETTE_V1[17]!,
  signageYellow: HK_PALETTE_V1[19]!,
  sky: HK_PALETTE_V1[20]!,
  amber: HK_PALETTE_V1[21]!,
  lightWood: HK_PALETTE_V1[23]!,
  paleSky: HK_PALETTE_V1[24]!,
  lightGrey: HK_PALETTE_V1[25]!,
  paper: HK_PALETTE_V1[26]!,
  offWhite: HK_PALETTE_V1[27]!,
  white: HK_PALETTE_V1[28]!,
} as const;

type RGB = readonly [number, number, number];

/** mulberry32: tiny, deterministic, and good enough for grain. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A single cell's canvas, painting only palette colours. */
class Cell {
  readonly data: Buffer;

  constructor(readonly size: number) {
    this.data = Buffer.alloc(size * size * 4);
  }

  paint(x: number, y: number, colour: RGB): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const offset = (y * this.size + x) * 4;
    this.data[offset] = colour[0];
    this.data[offset + 1] = colour[1];
    this.data[offset + 2] = colour[2];
    this.data[offset + 3] = 255;
  }

  fill(colour: RGB): void {
    for (let y = 0; y < this.size; y += 1) for (let x = 0; x < this.size; x += 1) this.paint(x, y, colour);
  }

  rect(x: number, y: number, w: number, h: number, colour: RGB): void {
    for (let yy = y; yy < y + h; yy += 1) for (let xx = x; xx < x + w; xx += 1) this.paint(xx, yy, colour);
  }

  /** Speckle: a deterministic fraction of cells repainted, for grain rather than noise. */
  speckle(seed: number, chance: number, colours: RGB[]): void {
    const next = rng(seed);
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        if (next() > chance) continue;
        this.paint(x, y, colours[Math.floor(next() * colours.length)]!);
      }
    }
  }
}

/* ---------- the tiles ---------- */

/** Concrete pavement: slabs with joints, worn edges, a little grain. */
function floor(size: number): Cell {
  const cell = new Cell(size);
  cell.fill(C.concrete);
  const slab = size / 2;

  for (let i = 0; i <= 2; i += 1) {
    const at = Math.min(i * slab, size - 2);
    cell.rect(0, at, size, 2, C.concreteShadow); // horizontal joints
    cell.rect(at, 0, 2, size, C.concreteShadow); // vertical joints
  }
  // Chipped highlights along the top-left of each slab, shadow along the bottom-right.
  for (let i = 0; i < 2; i += 1) {
    const x = i * slab + 2;
    const y = i * slab + 2;
    cell.rect(x, y, slab - 4, 1, C.lightGrey);
    cell.rect(x, y, 1, slab - 4, C.lightGrey);
    cell.rect(x, y + slab - 4, slab - 4, 1, C.midGrey);
  }
  cell.speckle(11, 0.08, [C.lightGrey, C.concreteShadow, C.midGrey]);
  return cell;
}

/** Chipped shop tiles: quarter grid of glazed tiles with grout and a teal accent course. */
function alt(size: number): Cell {
  const cell = new Cell(size);
  cell.fill(C.concreteShadow);
  const tile = size / 4;

  for (let ty = 0; ty < 4; ty += 1) {
    for (let tx = 0; tx < 4; tx += 1) {
      const base = (tx + ty) % 3 === 0 ? C.paper : C.offWhite;
      cell.rect(tx * tile + 1, ty * tile + 1, tile - 2, tile - 2, base);
      cell.rect(tx * tile + 1, ty * tile + 1, tile - 2, 1, C.white); // glaze highlight
      if (ty === 1 && tx % 2 === 0) cell.rect(tx * tile + 1, ty * tile + 1, tile - 2, tile - 2, C.teal);
    }
  }
  cell.speckle(23, 0.04, [C.lightGrey, C.paper]);
  return cell;
}

/** Brick wall: offset courses, mortar, cap highlight on top and shadow at the foot. */
function wall(size: number): Cell {
  const cell = new Cell(size);
  cell.fill(C.paper); // mortar
  const course = size / 4;
  const brick = size / 2;

  for (let row = 0; row < 4; row += 1) {
    const offset = row % 2 === 0 ? 0 : brick / 2;
    for (let col = -1; col < 3; col += 1) {
      const x = col * brick + offset;
      cell.rect(x + 1, row * course + 1, brick - 2, course - 2, row % 2 === 0 ? C.brick : C.brick);
      cell.rect(x + 1, row * course + 1, brick - 2, 1, C.signageRed); // lit top edge
      cell.rect(x + 1, row * course + course - 2, brick - 2, 1, C.darkBrick); // shaded foot
    }
  }
  cell.rect(0, 0, size, 2, C.lightGrey); // cap
  cell.rect(0, size - 3, size, 3, C.darkGrey); // skirting shadow
  cell.speckle(37, 0.05, [C.darkBrick, C.rust]);
  return cell;
}

/** Shop door: timber frame, glazed upper panel, brass knob, threshold. */
function door(size: number): Cell {
  const cell = new Cell(size);
  cell.fill(C.midWood);
  const frame = 4;

  cell.rect(0, 0, size, frame, C.darkWood); // lintel
  cell.rect(0, 0, frame, size, C.darkWood); // jambs
  cell.rect(size - frame, 0, frame, size, C.darkWood);
  cell.rect(frame, frame, size - frame * 2, size - frame * 2, C.lightWood);

  // Glass: sky with a soft diagonal highlight.
  const glass = { x: frame + 4, y: frame + 4, w: size - (frame + 4) * 2, h: size / 2 };
  cell.rect(glass.x, glass.y, glass.w, glass.h, C.sky);
  for (let i = 0; i < glass.h; i += 1) cell.rect(glass.x + i, glass.y + i, 2, 1, C.paleSky);
  cell.rect(glass.x + glass.w / 2 - 1, glass.y, 2, glass.h, C.midWood); // mullion

  // Lower panel with an inset shadow, and the knob on the hinged side.
  cell.rect(frame + 4, glass.y + glass.h + 4, size - (frame + 4) * 2, size / 2 - 12, C.midWood);
  cell.rect(frame + 4, glass.y + glass.h + 4, size - (frame + 4) * 2, 2, C.darkWood);
  cell.rect(size - frame - 10, size / 2 + 2, 3, 3, C.amber);
  cell.rect(size - frame - 10, size / 2 + 2, 1, 1, C.white); // glint

  cell.rect(0, size - 3, size, 3, C.concreteShadow); // threshold
  return cell;
}

/** Weedy verge: green base, dark clumps, pale tips. */
function grass(size: number): Cell {
  const cell = new Cell(size);
  cell.fill(C.awningGreen);
  cell.speckle(41, 0.35, [C.greenDark, C.lightGrey, C.greenDark]);
  const next = rng(43);
  for (let i = 0; i < size; i += 1) {
    const x = Math.floor(next() * size);
    const y = Math.floor(next() * size);
    cell.rect(x, y, 1, 3, C.greenDark);
    cell.paint(x, y - 1, C.lightGrey);
  }
  return cell;
}

/** Standing water: teal base with navy ripples and pale glints. */
function water(size: number): Cell {
  const cell = new Cell(size);
  cell.fill(C.teal);
  const next = rng(47);
  for (let i = 0; i < 6; i += 1) {
    const y = Math.floor(next() * size);
    const x = Math.floor(next() * (size / 2));
    const w = Math.floor(size / 3) + 2;
    cell.rect(x, y, w, 1, C.paleSky);
    cell.rect(x + 2, y + 1, w - 4, 1, C.navy);
  }
  cell.speckle(53, 0.03, [C.paleSky, C.navy]);
  return cell;
}

/** Pitched roof: overlapping clay rows. */
function roof(size: number): Cell {
  const cell = new Cell(size);
  cell.fill(C.darkBrick);
  const row = size / 4;
  const pan = size / 3;

  for (let r = 0; r < 4; r += 1) {
    const offset = r % 2 === 0 ? 0 : pan / 2;
    for (let p = -1; p < 4; p += 1) {
      const x = p * pan + offset;
      cell.rect(x + 1, r * row + 1, pan - 2, row - 2, r % 2 === 0 ? C.brick : C.signageRed);
      cell.rect(x + 1, r * row + row - 2, pan - 2, 1, C.darkBrick);
    }
  }
  return cell;
}

/** Shopfront window in a concrete wall: timber frame, glazing, sill. */
function windowTile(size: number): Cell {
  const cell = new Cell(size);
  cell.fill(C.concrete);
  cell.rect(0, 0, size, 2, C.lightGrey);
  cell.rect(0, size - 3, size, 3, C.concreteShadow);

  const frame = 6;
  cell.rect(frame, frame, size - frame * 2, size - frame * 2, C.midWood);
  cell.rect(frame + 2, frame + 2, size - (frame + 2) * 2, size - (frame + 2) * 2, C.sky);
  for (let i = 0; i < size / 2; i += 1) {
    cell.rect(frame + 2 + i, frame + 2 + i, 2, 1, C.paleSky); // reflection
  }
  cell.rect(size / 2 - 1, frame + 2, 2, size - (frame + 2) * 2, C.midWood); // mullion
  cell.rect(frame - 1, size - frame, size - (frame - 1) * 2, 3, C.lightWood); // sill
  return cell;
}

const TILES: Array<{ name: string; draw: (size: number) => Cell }> = [
  { name: "floor", draw: floor },
  { name: "alt", draw: alt },
  { name: "wall", draw: wall },
  { name: "door", draw: door },
  { name: "grass", draw: grass },
  { name: "water", draw: water },
  { name: "roof", draw: roof },
  { name: "window", draw: windowTile },
];

/** The four frames every location's legend references, in legend order. */
const CORE: Array<{ name: string; draw: (size: number) => Cell }> = [
  { name: "floor", draw: floor },
  { name: "alt", draw: alt },
  { name: "wall", draw: wall },
  { name: "door", draw: door },
];

/**
 * The extra series: a library for future content, kept out of the atlas itself.
 *
 * This is not cosmetic. Renderers derive the cell as `image width ÷ legend columns`, so an atlas
 * carrying more columns than any legend names would be sliced wrong — which is exactly how the
 * first 8-column draft produced 96px cells out of a 48px atlas.
 */
const EXTRA: Array<{ name: string; draw: (size: number) => Cell }> = [
  { name: "grass", draw: grass },
  { name: "water", draw: water },
  { name: "roof", draw: roof },
  { name: "window", draw: windowTile },
];

/* ---------- compose ---------- */

async function writeAtlas(path: string, tiles: typeof CORE, note: string): Promise<void> {
  const width = CELL * tiles.length;
  const buffer = Buffer.alloc(width * CELL * 4);

  for (const [index, tile] of tiles.entries()) {
    const cell = tile.draw(CELL);
    for (let y = 0; y < CELL; y += 1) {
      for (let x = 0; x < CELL; x += 1) {
        const from = (y * CELL + x) * 4;
        const to = (y * width + index * CELL + x) * 4;
        cell.data.copy(buffer, to, from, from + 4);
      }
    }
    console.log(`  [${index},0] ${tile.name}`);
  }

  const png = await sharp(buffer, { raw: { width, height: CELL, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(path, png);
  await writeFile(
    path.replace(/\.png$/, ".gen.json"),
    JSON.stringify(
      { generator: "tools/gen_tile_atlas.ts", palette: PALETTE_NAME, cell: CELL, columns: tiles.length, tiles: tiles.map((tile) => tile.name), note },
      null,
      2,
    ) + "\n",
  );
  console.log(`wrote ${path} (${width}x${CELL}, ${tiles.length} tiles at ${CELL}px)`);
}

await writeAtlas(
  outPath,
  CORE,
  "Deterministic: the same script and cell size always produce these bytes. Four columns, matching every legend ([0,0] floor, [1,0] alt, [2,0] wall, [3,0] door) — a renderer derives the cell as width / columns.",
);
await writeAtlas(
  outPath.replace(/\.png$/, "_extra.png"),
  EXTRA,
  "Extra tiles, not referenced by any legend yet: to use one, add a legend entry pointing at its column in an atlas whose columns match the document's legend.",
);
