#!/usr/bin/env bun
/**
 * Hand-authored NPC walk frames, drawn pixel by pixel from one body plan.
 *
 * Why code instead of generation for this character: two rounds of image generation could not hold
 * a design across eight facings. Drawing from one parametric body plan makes consistency a property
 * of the code — the head is the same width in every facing because a single table says so.
 *
 * This is authored pixel art, not a sprite editor. Every pixel is deliberately placed, flat-shaded
 * with two or three tones per material, using only `hk_palette_v1`.
 *
 * ## Proportions are the spec
 *
 * The cast is 3.5-4 heads tall. An earlier version was 2.5 heads and read as a toddler next to it,
 * so the row budget below is explicit: head 9 rows, neck 1, torso 10, belt 2, legs 8, boots 2 — 32
 * rows, 3.6 heads.
 *
 * Silhouettes are per-row spans (y, x0, x1) rather than rectangles, because a rectangle head reads
 * as a box: the taper is the whole difference between "character" and "placeholder".
 *
 * Usage: bun tools/draw_npc_frames.ts [--npc ID] [--out DIR]
 * The output is deliberately written outside the content pack by default, so a candidate can be
 * reviewed before it replaces anything.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";

import { OUTLINE_COLOR } from "../apps/server/src/lib/palette";

const INNER: readonly [number, number] = [24, 32];
const CELL: readonly [number, number] = [26, 34];
const NONE = ".";

/** Palette letters, so the body plan below reads like pixel art rather than colour tuples. */
const LETTERS: Record<string, readonly [number, number, number]> = {
  A: [26, 28, 34], // near-black: eyes (same value as the outline, deliberately)
  C: [46, 49, 56], // dark grey       — trousers, brows, hair shadow
  D: [74, 79, 88], // mid grey        — hair base, boot highlight
  E: [92, 96, 88], // shadow concrete — shirt shadow / seams / folds
  F: [110, 82, 50], // mid wood       — meter notebook
  O: [139, 142, 133], // concrete     — shirt base
  Q: [201, 163, 124], // skin shadow
  V: [232, 192, 106], // amber        — key ring
  W: [232, 201, 160], // skin
  Z: [154, 160, 168], // light grey   — hair highlight, chest highlight
};

type Span = readonly [number, number, number];
type Grid = string[][];

// --- body plan: 32 rows, 3.6 heads -----------------------------------------------------
const HEAD_FRONT: Span[] = [
  [1, 9, 14], [2, 7, 16], [3, 6, 17], [4, 5, 18], [5, 5, 18],
  [6, 6, 17], [7, 7, 16], [8, 8, 15], [9, 9, 14],
];
// Profile keeps its width: losing pixels of head width is what made generated side views read as a
// different character.
const HEAD_SIDE: Span[] = [
  [1, 9, 14], [2, 8, 16], [3, 7, 17], [4, 6, 18], [5, 6, 18],
  [6, 7, 17], [7, 7, 17], [8, 8, 16], [9, 9, 15],
];

const NECK: Span[] = [[10, 10, 13]];

const TORSO: Span[] = [
  [11, 7, 16], [12, 6, 17], [13, 5, 18], [14, 5, 18], [15, 5, 18],
  [16, 5, 18], [17, 6, 17], [18, 6, 17], [19, 7, 16], [20, 7, 16],
];
const BELT: Span[] = [[21, 7, 16], [22, 7, 16]];

const LEGS_STAND: Span[] = [
  [23, 8, 11], [24, 8, 11], [25, 8, 11], [26, 8, 11], [27, 8, 11], [28, 8, 11],
  [29, 8, 10], [30, 8, 10],
  [23, 13, 16], [24, 13, 16], [25, 13, 16], [26, 13, 16], [27, 13, 16], [28, 13, 16],
  [29, 14, 16], [30, 14, 16],
];
const BOOTS_STAND: Span[] = [[31, 7, 11], [32, 7, 11], [31, 12, 16], [32, 12, 16]];

// Mid-stride: the forward leg reaches lower and wider, the trailing leg lifts.
const LEGS_STEP: Span[] = [
  [23, 7, 10], [24, 7, 10], [25, 7, 10], [26, 7, 10], [27, 7, 10], [28, 7, 10],
  [29, 7, 9], [30, 7, 9],
  [23, 13, 16], [24, 13, 16], [25, 13, 16], [26, 13, 16],
];
const BOOTS_STEP: Span[] = [[31, 6, 10], [32, 6, 10], [27, 12, 16], [28, 12, 16]];

// --- grid primitives -------------------------------------------------------------------
function blank(): Grid {
  return Array.from({ length: INNER[1] }, () => Array<string>(INNER[0]).fill(NONE));
}

/** Fill (y, x0, x1) spans inclusively, clipped to the inner box. */
function paint(grid: Grid, spans: Span[], ch: string): void {
  for (const [y, x0, x1] of spans) {
    if (y < 0 || y >= INNER[1]) continue;
    for (let x = Math.max(0, x0); x <= Math.min(INNER[0] - 1, x1); x += 1) grid[y]![x] = ch;
  }
}

function rect(grid: Grid, x0: number, y0: number, x1: number, y1: number, ch: string): void {
  for (let y = Math.max(0, y0); y <= Math.min(INNER[1] - 1, y1); y += 1) {
    for (let x = Math.max(0, x0); x <= Math.min(INNER[0] - 1, x1); x += 1) grid[y]![x] = ch;
  }
}

function pixel(grid: Grid, x: number, y: number, ch: string): void {
  if (x < 0 || y < 0 || x >= INNER[0] || y >= INNER[1]) return;
  grid[y]![x] = ch;
}

function mirror(grid: Grid): Grid {
  return grid.map((row) => [...row].reverse());
}

// --- heads -----------------------------------------------------------------------------
function headFront(grid: Grid): void {
  paint(grid, HEAD_FRONT, "D"); // hair mass
  rect(grid, 7, 5, 16, 9, "W"); // face
  rect(grid, 7, 4, 16, 4, "D"); // fringe over the brow
  pixel(grid, 11, 4, "W");
  pixel(grid, 12, 4, "W"); // parting notch
  rect(grid, 8, 2, 11, 2, "Z"); // grey highlight
  rect(grid, 14, 3, 16, 3, "Z");
  rect(grid, 5, 8, 6, 8, "C"); // temple shadow
  rect(grid, 17, 8, 18, 8, "C");

  rect(grid, 7, 5, 16, 5, "Q"); // forehead shadow under the fringe
  rect(grid, 9, 6, 10, 6, "C"); // brows
  rect(grid, 13, 6, 14, 6, "C");
  pixel(grid, 9, 7, "A"); // eyes
  pixel(grid, 14, 7, "A");
  pixel(grid, 8, 8, "Q"); // cheeks
  pixel(grid, 15, 8, "Q");
  rect(grid, 11, 8, 12, 8, "Q"); // nose
  rect(grid, 11, 9, 12, 9, "Q"); // mouth
  pixel(grid, 4, 6, "Q"); // ears
  pixel(grid, 19, 6, "Q");
  pixel(grid, 4, 7, "W");
  pixel(grid, 19, 7, "W");
}

function headBack(grid: Grid): void {
  paint(grid, HEAD_FRONT, "D");
  rect(grid, 8, 2, 11, 2, "Z");
  rect(grid, 14, 3, 16, 3, "Z");
  rect(grid, 7, 8, 16, 8, "E"); // nape shadow
  rect(grid, 9, 9, 14, 9, "C");
}

function headSide(grid: Grid): void {
  paint(grid, HEAD_SIDE, "D"); // hair mass (back of the head)
  rect(grid, 11, 5, 18, 9, "W"); // face profile
  rect(grid, 6, 4, 11, 4, "D"); // fringe sweeping forward
  rect(grid, 8, 2, 11, 2, "Z");
  rect(grid, 7, 3, 10, 3, "Z");
  pixel(grid, 16, 7, "A"); // eye
  pixel(grid, 19, 7, "W"); // nose step-out
  pixel(grid, 19, 8, "W");
  pixel(grid, 18, 9, "Q"); // chin
  rect(grid, 12, 9, 17, 9, "Q"); // jaw
  pixel(grid, 11, 8, "C"); // sideburn
  pixel(grid, 11, 7, "Q"); // ear
  pixel(grid, 12, 7, "Q");
}

// --- body ------------------------------------------------------------------------------
function torso(grid: Grid, facing: string): void {
  paint(grid, TORSO, "O");
  rect(grid, 5, 13, 5, 18, "E"); // body shadow, left
  rect(grid, 18, 13, 18, 18, "E"); // body shadow, right
  rect(grid, 7, 12, 11, 12, "Z"); // chest highlight
  pixel(grid, 8, 16, "E"); // fold shading
  pixel(grid, 8, 17, "E");
  pixel(grid, 15, 15, "E");
  pixel(grid, 15, 16, "E");
  rect(grid, 7, 20, 16, 20, "E"); // hem shadow

  if (facing === "right") {
    rect(grid, 17, 11, 19, 13, "O"); // near sleeve
    rect(grid, 17, 14, 18, 18, "W"); // near forearm
    rect(grid, 17, 18, 18, 18, "Q");
    rect(grid, 5, 12, 6, 19, "E"); // far arm in shadow
    return;
  }

  rect(grid, 4, 11, 5, 13, "O"); // sleeves
  rect(grid, 18, 11, 19, 13, "O");
  rect(grid, 4, 14, 5, 18, "W"); // forearms
  rect(grid, 18, 14, 19, 18, "W");
  rect(grid, 4, 18, 5, 18, "Q"); // hands
  rect(grid, 18, 18, 19, 18, "Q");

  if (facing === "down") {
    rect(grid, 10, 11, 13, 11, "E"); // collar
    pixel(grid, 11, 11, "Q");
    pixel(grid, 12, 11, "Q");
    rect(grid, 11, 12, 12, 19, "E"); // placket
  } else {
    rect(grid, 11, 12, 12, 20, "E"); // back seam
  }
}

function belt(grid: Grid, facing: string): void {
  paint(grid, BELT, "C");
  rect(grid, 8, 21, 11, 21, "D");
  if (facing === "down") {
    rect(grid, 9, 21, 11, 23, "F"); // meter notebook
    pixel(grid, 14, 22, "V"); // key ring
    pixel(grid, 14, 23, "V");
    pixel(grid, 15, 24, "V");
  } else if (facing === "right") {
    rect(grid, 13, 21, 15, 23, "F");
    pixel(grid, 9, 22, "V");
    pixel(grid, 9, 23, "V");
  }
}

function legs(grid: Grid, pose: string): void {
  if (pose === "stand") {
    paint(grid, LEGS_STAND, "C");
    rect(grid, 11, 23, 11, 30, "D");
    rect(grid, 16, 23, 16, 30, "D");
    paint(grid, BOOTS_STAND, "D");
  } else {
    paint(grid, LEGS_STEP, "C");
    rect(grid, 10, 23, 10, 30, "D");
    rect(grid, 16, 23, 16, 26, "D");
    paint(grid, BOOTS_STEP, "D");
  }
}

function build(facing: string, pose: string): Grid {
  const grid = blank();
  if (facing === "down") headFront(grid);
  else if (facing === "up") headBack(grid);
  else headSide(grid);

  paint(grid, NECK, "Q");
  torso(grid, facing);
  belt(grid, facing);
  legs(grid, pose);

  return facing === "left" ? mirror(grid) : grid;
}

/** Encode one cell: draw the 24x32 subject, then stamp the 1px outline ring around it. */
async function toPng(grid: Grid): Promise<Buffer> {
  const inner = Buffer.alloc(INNER[0] * INNER[1] * 4);
  for (let y = 0; y < INNER[1]; y += 1) {
    for (let x = 0; x < INNER[0]; x += 1) {
      const ch = grid[y]![x]!;
      if (ch === NONE) continue;
      const [r, g, b] = LETTERS[ch]!;
      const at = (y * INNER[0] + x) * 4;
      inner[at] = r;
      inner[at + 1] = g;
      inner[at + 2] = b;
      inner[at + 3] = 255;
    }
  }

  const [cellW, cellH] = CELL;
  const canvas = Buffer.alloc(cellW * cellH * 4);
  const solid = new Uint8Array(cellW * cellH);

  for (let y = 0; y < INNER[1]; y += 1) {
    for (let x = 0; x < INNER[0]; x += 1) {
      const from = (y * INNER[0] + x) * 4;
      if (inner[from + 3]! < 128) continue;
      const tx = x + 1;
      const ty = y + 1;
      const to = (ty * cellW + tx) * 4;
      canvas[to] = inner[from]!;
      canvas[to + 1] = inner[from + 1]!;
      canvas[to + 2] = inner[from + 2]!;
      canvas[to + 3] = 255;
      solid[ty * cellW + tx] = 1;
    }
  }

  // 3x3 dilation minus the original alpha: the same recipe `pixelate.process` uses, so the outline
  // weight matches the cast.
  for (let y = 0; y < cellH; y += 1) {
    for (let x = 0; x < cellW; x += 1) {
      if (solid[y * cellW + x]) continue;
      let grows = false;
      for (let dy = -1; dy <= 1 && !grows; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny < 0 || nx < 0 || ny >= cellH || nx >= cellW) continue;
          if (solid[ny * cellW + nx]) {
            grows = true;
            break;
          }
        }
      }
      if (!grows) continue;
      const at = (y * cellW + x) * 4;
      canvas[at] = OUTLINE_COLOR[0];
      canvas[at + 1] = OUTLINE_COLOR[1];
      canvas[at + 2] = OUTLINE_COLOR[2];
      canvas[at + 3] = 255;
    }
  }

  return sharp(canvas, { raw: { width: cellW, height: cellH, channels: 4 } }).png().toBuffer();
}

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1]! : fallback;
};
const npc = flag("--npc", "npc_ch01_wai");
const out = flag("--out", "/tmp/hks_hand");

await mkdir(out, { recursive: true });

const FACINGS = ["down", "right", "left", "up"] as const;
const POSES = ["stand", "step"] as const;

const cells = new Map<string, Buffer>();
for (const facing of FACINGS) {
  for (const pose of POSES) {
    const png = await toPng(build(facing, pose));
    cells.set(`${facing}:${pose}`, png);
    await writeFile(join(out, `${npc}_walk_${facing}_${pose}.png`), png);
  }
}

const [cellW, cellH] = CELL;
const sheet = await sharp({
  create: {
    width: cellW * FACINGS.length,
    height: cellH * POSES.length,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite(
    FACINGS.flatMap((facing, column) =>
      POSES.map((pose, row) => ({
        input: cells.get(`${facing}:${pose}`)!,
        left: column * cellW,
        top: row * cellH,
      })),
    ),
  )
  .png()
  .toBuffer();

const sheetPath = join(out, `${npc}_walk.png`);
await writeFile(sheetPath, sheet);

await writeFile(
  join(out, "HAND_AUTHORED.txt"),
  "Drawn pixel by pixel by tools/draw_npc_frames.ts from one parametric body plan.\n" +
    `Palette: hk_palette_v1. Cell: ${cellW}x${cellH} (24x32 subject + 1px outline).\n` +
    "Proportions: 9-row head / 32 rows total = 3.6 heads, matching the cast.\n" +
    "Not a sprite editor: authored in code so the silhouette cannot drift between facings.\n",
  "utf8",
);

console.log(`wrote ${sheetPath} (${cellW * FACINGS.length}x${cellH * POSES.length})`);
