import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import sharp from "sharp";

/**
 * Walk-sheet assembly (PLAN 6.3): 4 direction columns x 2 pose rows of 26x34 cells.
 *
 * `npc_body` and the player read cells by (facing, walk phase), so the layout is a wire format in
 * exactly the same sense the manifest is — off by one cell and every character animates wrong.
 * Shared by the NPC and player assemblers so the two cannot drift.
 */

export const CELL_WIDTH = 26;
export const CELL_HEIGHT = 34;
export const COLUMNS = ["down", "right", "left", "up"] as const;
export const ROWS = ["stand", "step"] as const;

export interface AssembleOptions {
  /** Directory holding `<prefix>_walk_<dir>_<pose>.png`; the sheet is written here too. */
  artDir: string;
  /** `npc_ch01_ken` or `player`. */
  prefix: string;
}

export async function assembleWalkSheet(options: AssembleOptions): Promise<{ path: string; width: number; height: number }> {
  const width = CELL_WIDTH * COLUMNS.length;
  const height = CELL_HEIGHT * ROWS.length;

  const composites: sharp.OverlayOptions[] = [];

  for (const [column, direction] of COLUMNS.entries()) {
    for (const [row, pose] of ROWS.entries()) {
      const path = join(options.artDir, `${options.prefix}_walk_${direction}_${pose}.png`);
      const source = await readFile(path);

      // Frames are authored at exactly one cell; anything else is resized the same way the Python
      // tool did, so an off-size frame degrades identically rather than silently misaligning.
      const meta = await sharp(source).metadata();
      const cell =
        meta.width === CELL_WIDTH && meta.height === CELL_HEIGHT
          ? source
          : await sharp(source).resize(CELL_WIDTH, CELL_HEIGHT, { kernel: "nearest" }).png().toBuffer();

      composites.push({ input: cell, left: column * CELL_WIDTH, top: row * CELL_HEIGHT });
    }
  }

  const sheet = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();

  const out = join(options.artDir, `${options.prefix}_walk.png`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, sheet);

  return { path: out, width, height };
}
