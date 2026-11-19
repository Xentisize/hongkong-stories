import {
  TILE_TRANSFORM_FLIPS,
  TILE_TRANSFORM_QUARTER_TURNS,
  legendFrame,
  type TileTransform,
} from "@hkstories/core";

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
  /**
   * The offline ladder (§7.8): authored lines the client falls back to when the API cannot answer.
   * `greeting` is what an unreachable backend shows; `lines` and `exit` cover the rest of the
   * conversation.
   */
  scripted_fallback?: {
    greeting?: LocalizedText;
    lines?: LocalizedText[];
    exit?: LocalizedText;
  };
  /** Model overrides the server honours — carried here so a client never invents its own defaults. */
  llm?: Record<string, unknown>;
}

export interface LocationFile {
  id: string;
  display_name: LocalizedText;
  tile_size: number;
  /** Godot-project path, e.g. `res://assets/tiles/p1_tiles_2027.png`. */
  atlas: string;
  legend: Record<string, [number, number] | [number, number, TileTransform]>;
  tilemap: string[];
  /** Overlays drawn above `tilemap`, in order. A space means "paint nothing here". */
  layers?: Array<{ id?: string; tilemap?: string[] }>;
  collision: Array<[number, number, number, number]>;
  spawn_points: Record<string, [number, number]>;
  /** Ambience bed, e.g. `audio/kln_1963.wav`. Absent or empty means "keep the current bed". */
  music?: string;
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
    /** Removed after one use — a sign you pick up is not a sign you can pick up twice. */
    once?: boolean;
    prompt?: LocalizedText;
    on_interact?: unknown[];
  }>;
  doors?: Array<{
    id: string;
    tiles: Array<[number, number]>;
    requires?: unknown;
    /** Set when the door opens, so it stays open across sessions. */
    open_flag?: string;
    prompt?: LocalizedText;
    blocked?: LocalizedText;
    opened?: LocalizedText;
  }>;
  exits?: Array<{
    id: string;
    rect: [number, number, number, number];
    to: string;
    spawn?: string;
    requires?: unknown;
    blocked?: LocalizedText;
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

/** The transform a character's legend entry asks for, or `null` for a plain frame. */
export function legendTransform(
  legend: LocationFile["legend"],
  char: string | undefined,
): TileTransform | null {
  if (char === undefined) return null;
  return legendFrame(legend[char])?.transform ?? null;
}

/**
 * Apply a legend transform to one tile.
 *
 * Kept out of the renderer so the mapping is testable: `rotation` is in radians and the two flips
 * are the engine's own flags. A rotated variant shares its *index* with the tile it was made from,
 * which is why the transform is looked up by **character**, never by index.
 */
export function applyTileTransform(
  tile: { rotation: number; flipX: boolean; flipY: boolean },
  transform: TileTransform,
): void {
  // The tables live in core so the Godot client can mirror them exactly; see
  // `TILE_TRANSFORM_TRANSPOSE` there for the desktop build's vocabulary.
  tile.rotation = (Math.PI / 2) * TILE_TRANSFORM_QUARTER_TURNS[transform];
  if (TILE_TRANSFORM_FLIPS[transform].x) tile.flipX = true;
  if (TILE_TRANSFORM_FLIPS[transform].y) tile.flipY = true;
}

/**
 * Resolve every layer into tile indices for a row-major atlas, base grid first.
 *
 * An unknown character becomes `-1` (an empty tile) instead of silently becoming tile 0, so a typo
 * paints a visible hole rather than plausible-looking floor — and in an overlay, so does a space,
 * which is how transparency is spelled.
 */
export function tileIndexGrids(location: LocationFile): number[][][] {
  const columns = legendColumns(location);

  const resolve = (rows: readonly string[], overlay: boolean): number[][] =>
    rows.map((row) =>
      [...row].map((character) => {
        if (overlay && character === " ") return -1;
        const coords = location.legend[character];
        if (!coords) return -1;
        return coords[1] * columns + coords[0];
      }),
    );

  const grids = [resolve(location.tilemap, false)];
  for (const layer of Array.isArray(location.layers) ? location.layers : []) {
    if (!layer || !Array.isArray(layer.tilemap)) continue;
    grids.push(resolve(layer.tilemap.map(String), true));
  }
  return grids;
}

/** The base grid alone — the map's floor, which is what doors swap cells on. */
export function tileIndexGrid(location: LocationFile): number[][] {
  return tileIndexGrids(location)[0] ?? [];
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
