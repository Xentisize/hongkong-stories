/**
 * Content geometry, independent of the engine.
 *
 * Everything here is pure: it takes the location JSON the Godot client also reads and turns it
 * into pixel geometry. No Phaser import, so the rules can be unit-tested and — later — shared
 * with the server for things like reachability checks.
 *
 * ## The units, which are easy to get wrong
 *
 * The location file mixes three of them and they are not interchangeable:
 *
 *   - `tilemap` is a grid of single characters, resolved through `legend` to `[column, row]`
 *     inside the tileset atlas;
 *   - `collision` rects and `exits[].rect` are `[x, y, w, h]` in **tile units**, top-left
 *     anchored;
 *   - `spawn_points` are `[x, y]` in **tile units but already carrying a half-tile offset**
 *     (`13.5, 6.5` is the centre of tile 13,6), so multiplying by `tile_size` lands on the
 *     pixel centre with no extra `+ 0.5`;
 *   - `decor[].tile` and `npcs[].tile` are whole tile indices, so they *do* need the `+ 0.5`.
 */

export type LocalizedText = Record<string, string>;

export interface CollisionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The parts of an NPC record the renderer reads. */
export interface NpcFile {
  id: string;
  display_name: LocalizedText;
  sprite?: {
    /** Idle sheet: a single 26x34 frame. */
    sheet?: string;
    /** Walk sheet: 4 direction columns x 2 pose rows of 26x34. */
    sheet_walk?: string;
    portrait?: string;
    frames?: unknown;
  };
}

export interface LocationFile {
  id: string;
  display_name: LocalizedText;
  tile_size: number;
  /** Godot-project path, e.g. `res://assets/tiles/p1_tiles_2027.png`. */
  atlas: string;
  legend: Record<string, [number, number]>;
  tilemap: string[];
  collision: Array<[number, number, number, number]>;
  spawn_points: Record<string, [number, number]>;
  decor?: Array<{ art: string; tile: [number, number] }>;
  npcs?: Array<{
    npc: string;
    tile: [number, number];
    facing?: string;
    wander?: number;
    requires?: unknown;
  }>;
  interactables?: Array<{
    id: string;
    tile: [number, number];
    art?: string;
    scale?: number;
    requires?: unknown;
  }>;
  exits?: Array<{
    id: string;
    rect: [number, number, number, number];
    to: string;
    spawn?: string;
    requires?: unknown;
  }>;
}

/** Columns in the atlas, derived from the legend rather than assumed to be four. */
export function legendColumns(location: LocationFile): number {
  let maxColumn = 0;
  for (const [, coords] of Object.entries(location.legend)) {
    if (coords[0] > maxColumn) maxColumn = coords[0];
  }
  return maxColumn + 1;
}

/**
 * Resolve the character grid into tile indices for a row-major atlas.
 *
 * An unknown character becomes `-1` (an empty tile) instead of silently becoming tile 0, so a
 * typo paints a visible hole rather than plausible-looking floor.
 */
export function tileIndexGrid(location: LocationFile): number[][] {
  const columns = legendColumns(location);
  return location.tilemap.map((row) =>
    [...row].map((character) => {
      const coords = location.legend[character];
      if (!coords) return -1;
      return coords[1] * columns + coords[0];
    }),
  );
}

export function mapPixelSize(location: LocationFile): { width: number; height: number } {
  const rows = location.tilemap.length;
  const columns = location.tilemap[0]?.length ?? 0;
  return { width: columns * location.tile_size, height: rows * location.tile_size };
}

/** Tile-unit rect → pixel rect, top-left anchored (what a static body wants). */
export function rectToPixels(location: LocationFile, rect: [number, number, number, number]): CollisionRect {
  const size = location.tile_size;
  const [x, y, width, height] = rect;
  return { x: x * size, y: y * size, width: width * size, height: height * size };
}

/** A whole tile index → the pixel centre of that tile. */
export function tileCentre(location: LocationFile, tile: [number, number]): { x: number; y: number } {
  const size = location.tile_size;
  return { x: (tile[0] + 0.5) * size, y: (tile[1] + 0.5) * size };
}

/** A named spawn point → pixel centre (the half-tile offset is already in the data). */
export function spawnPixel(
  location: LocationFile,
  name = "default",
): { x: number; y: number } {
  const point = location.spawn_points[name] ?? location.spawn_points["default"] ?? [0, 0];
  const size = location.tile_size;
  return { x: point[0] * size, y: point[1] * size };
}

/**
 * Reduce a content art reference to a bare file name.
 *
 * Content refers to art two different ways — `res://assets/tiles/x.png` for tilesets (a Godot
 * project path) and `art/props/x.png` for everything else (content-relative) — because the
 * paths were authored for the Godot loader. Matching on the file name bridges both without
 * editing content; the durable fix is to make these paths repo-relative in the data model.
 */
export function artFileName(reference: string): string {
  const withoutScheme = reference.replace(/^res:\/\//, "");
  const segments = withoutScheme.split("/");
  return segments[segments.length - 1] ?? withoutScheme;
}
