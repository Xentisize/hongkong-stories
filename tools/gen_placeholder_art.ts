#!/usr/bin/env bun
/**
 * Generate the P1 placeholder pixel art (docs/PLAN.md §8 groundwork).
 *
 * Why a generator instead of PNGs checked in from an editor: the image pipeline also emits assets
 * programmatically, and this proves the same loop — deterministic input, committed tool,
 * reproducible output, reviewable diff. These are placeholders and honest about it: no fake texture
 * noise, just clean readable shapes at the project's 24px tile scale, fixed palette.
 *
 * Usage:  bun tools/gen_placeholder_art.ts [--root DIR]
 * Output: client/assets/tiles/p1_tiles.png        (96x24 atlas: floor_a, floor_b, wall, door)
 *         client/assets/sprites/item_rusty_key.png (16x16)
 *
 * `--root` exists so a verification run can write into a temporary tree instead of overwriting
 * committed assets.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import sharp from "sharp";

const TILE = 24;

const FLOOR: RGB = [122, 92, 66];
const FLOOR_DARK: RGB = [92, 68, 48];
const FLOOR_LIGHT: RGB = [138, 106, 78];
const WALL: RGB = [74, 66, 62];
const WALL_MORTAR: RGB = [56, 50, 47];
const WALL_LIGHT: RGB = [92, 83, 77];
const DOOR_FRAME: RGB = [96, 60, 38];
const DOOR_DARK: RGB = [44, 32, 26];
const DOOR_PANEL: RGB = [58, 42, 33];
const DOOR_HANDLE: RGB = [214, 176, 84];
const BRASS: RGB = [196, 164, 92];
const BRASS_DARK: RGB = [110, 88, 44];

type RGB = [number, number, number];
type RGBA = [number, number, number, number];

const TRANSPARENT: RGBA = [0, 0, 0, 0];

class Canvas {
  readonly pixels: RGBA[];

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.pixels = new Array<RGBA>(width * height).fill(TRANSPARENT);
  }

  rect(x: number, y: number, w: number, h: number, color: RGB | RGBA): void {
    const value: RGBA = color.length === 4 ? (color as RGBA) : [...(color as RGB), 255];
    for (let yy = y; yy < y + h; yy += 1) {
      for (let xx = x; xx < x + w; xx += 1) {
        if (xx < 0 || yy < 0 || xx >= this.width || yy >= this.height) continue;
        this.pixels[yy * this.width + xx] = value;
      }
    }
  }

  dot(x: number, y: number, color: RGB | RGBA): void {
    this.rect(x, y, 1, 1, color);
  }

  hline(x: number, y: number, w: number, color: RGB | RGBA): void {
    this.rect(x, y, w, 1, color);
  }

  vline(x: number, y: number, h: number, color: RGB | RGBA): void {
    this.rect(x, y, 1, h, color);
  }

  /** Alpha-blit: transparent source pixels leave the destination alone. */
  blit(other: Canvas, ox: number, oy: number): void {
    for (let yy = 0; yy < other.height; yy += 1) {
      for (let xx = 0; xx < other.width; xx += 1) {
        const pixel = other.pixels[yy * other.width + xx]!;
        if (pixel[3] === 0) continue;
        const tx = ox + xx;
        const ty = oy + yy;
        if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) continue;
        this.pixels[ty * this.width + tx] = pixel;
      }
    }
  }

  toBuffer(): Buffer {
    const raw = Buffer.alloc(this.width * this.height * 4);
    for (let index = 0; index < this.pixels.length; index += 1) {
      const [r, g, b, a] = this.pixels[index]!;
      raw[index * 4] = r;
      raw[index * 4 + 1] = g;
      raw[index * 4 + 2] = b;
      raw[index * 4 + 3] = a;
    }
    return raw;
  }
}

async function writePng(path: string, canvas: Canvas): Promise<void> {
  const png = await sharp(canvas.toBuffer(), {
    raw: { width: canvas.width, height: canvas.height, channels: 4 },
  })
    .png()
    .toBuffer();

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, png);
  console.log(`wrote ${path} (${canvas.width}x${canvas.height}, ${png.length} bytes)`);
}

function floorTile(scuffed = false): Canvas {
  const tile = new Canvas(TILE, TILE);
  tile.rect(0, 0, TILE, TILE, FLOOR);

  // Three planks with a dark seam and a light upper edge on each.
  for (const seamY of [7, 15, 23]) {
    tile.hline(0, seamY, TILE, FLOOR_DARK);
    tile.hline(0, seamY - 7, TILE, FLOOR_LIGHT);
  }

  // Staggered board ends, which is what stops a tile grid reading as a grid.
  tile.vline(11, 0, 7, FLOOR_DARK);
  tile.vline(19, 8, 7, FLOOR_DARK);
  tile.vline(5, 16, 7, FLOOR_DARK);

  if (scuffed) {
    for (const [x, y] of [[15, 4], [16, 5], [17, 4], [16, 3], [3, 12], [4, 13], [2, 13]] as const) {
      tile.dot(x, y, FLOOR_DARK);
    }
  }
  return tile;
}

function wallTile(): Canvas {
  const tile = new Canvas(TILE, TILE);
  tile.rect(0, 0, TILE, TILE, WALL);

  // Two brick courses with offset vertical mortar, plus a 1px lit top edge per brick.
  for (let course = 0; course < 2; course += 1) {
    const top = course * 12;
    tile.hline(0, top + 11, TILE, WALL_MORTAR);
    tile.hline(0, top, TILE, WALL_LIGHT);
    const offset = course % 2 === 0 ? 0 : 12;
    tile.vline((offset + 11) % TILE, top, 11, WALL_MORTAR);
    tile.vline((offset + 23) % TILE, top, 11, WALL_MORTAR);
  }
  return tile;
}

function doorTile(): Canvas {
  const tile = new Canvas(TILE, TILE);
  tile.rect(0, 0, TILE, TILE, DOOR_FRAME);
  tile.rect(3, 2, 18, 22, DOOR_DARK);

  // Two inset panels and a brass handle — readable at 1x and at 5x.
  tile.rect(6, 5, 12, 7, DOOR_FRAME);
  tile.rect(7, 6, 10, 5, DOOR_PANEL);
  tile.rect(6, 15, 12, 7, DOOR_FRAME);
  tile.rect(7, 16, 10, 5, DOOR_PANEL);
  tile.rect(17, 12, 2, 2, DOOR_HANDLE);
  return tile;
}

function keyIcon(): Canvas {
  const tile = new Canvas(16, 16);

  // Ring (8x8 hollow square, cheap approximation of a bow).
  tile.rect(1, 4, 8, 8, BRASS_DARK);
  tile.rect(2, 5, 6, 6, TRANSPARENT);
  tile.rect(2, 5, 6, 2, BRASS);
  tile.rect(2, 9, 6, 2, BRASS);

  // Shaft + two teeth.
  tile.rect(8, 6, 7, 4, BRASS);
  tile.rect(8, 6, 7, 1, BRASS_DARK);
  tile.rect(12, 9, 1, 3, BRASS);
  tile.rect(14, 9, 1, 2, BRASS);
  tile.rect(13, 9, 1, 2, BRASS_DARK);
  return tile;
}

const rootFlag = process.argv.indexOf("--root");
const root =
  rootFlag >= 0 && process.argv[rootFlag + 1]
    ? process.argv[rootFlag + 1]!
    : join(import.meta.dir, "..");

const atlas = new Canvas(TILE * 4, TILE);
atlas.blit(floorTile(false), 0, 0);
atlas.blit(floorTile(true), TILE, 0);
atlas.blit(wallTile(), TILE * 2, 0);
atlas.blit(doorTile(), TILE * 3, 0);

await writePng(join(root, "client/assets/tiles/p1_tiles.png"), atlas);
await writePng(join(root, "client/assets/sprites/item_rusty_key.png"), keyIcon());
