/* Tile layers: a location's base grid plus the overlays stacked on it (PLAN §5.1).
 *
 * The format is additive on purpose. `tilemap` stays exactly what it always was — the base grid, and
 * the thing that defines the map's size — and `layers` adds grids drawn on top of it in order. That
 * means every document authored before layers existed keeps loading in both clients and in the
 * editor with no migration, and an author only meets the new field when they want it.
 *
 * In an overlay, a space means "draw nothing here". Rendering a whole-map overlay requires most
 * cells to be empty, and a character cannot be both a tile and an absence, so the space is reserved.
 * A base grid has no transparency: a space in the base is a hole in the floor, which the validator
 * reports as an unknown character rather than hiding.
 */

import { isRecord } from "./state";

/** The layer id that names the document's own `tilemap`. Authored ids may not use it. */
export const BASE_LAYER_ID = "base";

/**
 * How each transform is expressed by the two renderers.
 *
 * The web client draws with a rotation plus flips; Godot draws with `transpose` plus flips. Both are
 * renderings of the same six transforms, so they are written down here once and mirrored in
 * `client/scripts/world/location_root.gd` (GDScript shares no runtime with this file) — a mismatch
 * would show as a tile rotated one way on the web and another on the desktop build.
 */
export const TILE_TRANSFORM_QUARTER_TURNS: Record<TileTransform, 0 | 1 | 2 | 3> = {
  rot90: 1,
  rot180: 2,
  rot270: 3,
  flipX: 0,
  flipY: 0,
  flipXY: 0,
};

export const TILE_TRANSFORM_FLIPS: Record<TileTransform, { x: boolean; y: boolean }> = {
  rot90: { x: false, y: false },
  rot180: { x: false, y: false },
  rot270: { x: false, y: false },
  flipX: { x: true, y: false },
  flipY: { x: false, y: true },
  flipXY: { x: true, y: true },
};

/** The same mapping in Godot's vocabulary: `transpose` swaps the axes, then the flips apply. */
export const TILE_TRANSFORM_TRANSPOSE: Record<TileTransform, { transpose: boolean; flipX: boolean; flipY: boolean }> = {
  rot90: { transpose: true, flipX: true, flipY: false },
  rot180: { transpose: false, flipX: true, flipY: true },
  rot270: { transpose: true, flipX: false, flipY: true },
  flipX: { transpose: false, flipX: true, flipY: false },
  flipY: { transpose: false, flipX: false, flipY: true },
  flipXY: { transpose: false, flipX: true, flipY: true },
};

/** The character an overlay uses to paint nothing. */
export const TRANSPARENT_TILE = " ";

/**
 * How many pixels one atlas cell occupies, derived from the image and the legend's column count.
 *
 * The atlas is self-describing on purpose: a redraw at 2× detail changes only the PNG, and every
 * renderer slices by `width / columns` instead of assuming the world's `tile_size`. That is what
 * lets the art resolution rise without touching a single location document.
 */
export function atlasCellSize(atlasWidth: number, columns: number): number {
  if (!Number.isFinite(atlasWidth) || atlasWidth <= 0) return 0;
  if (!Number.isFinite(columns) || columns <= 0) return 0;
  return Math.round(atlasWidth / columns);
}

/**
 * How a legend frame is drawn, when it is not drawn straight from the atlas.
 *
 * A rotated or flipped tile cannot be spelled by the *cell* — the cell holds a character — so the
 * transform rides on the legend entry: `"r": [2, 0, "rot90"]`. That keeps the tilemap a plain grid
 * of characters (the format every client and the validator already read) while letting the palette
 * offer rotated and mirrored variants.
 */
export const TILE_TRANSFORMS = ["rot90", "rot180", "rot270", "flipX", "flipY", "flipXY"] as const;

export type TileTransform = (typeof TILE_TRANSFORMS)[number];

export function isTileTransform(value: unknown): value is TileTransform {
  return typeof value === "string" && (TILE_TRANSFORMS as readonly string[]).includes(value);
}

export interface LegendFrame {
  col: number;
  row: number;
  /** `null` for a plain `[col, row]` frame. */
  transform: TileTransform | null;
}

/** One legend entry as a frame, or `null` when it is not a frame at all. */
export function legendFrame(entry: unknown): LegendFrame | null {
  if (!Array.isArray(entry) || entry.length < 2) return null;
  const [col, row, transform] = entry;
  if (!Number.isInteger(col) || !Number.isInteger(row)) return null;
  return {
    col: col as number,
    row: row as number,
    transform: isTileTransform(transform) ? transform : null,
  };
}

export interface TileLayer {
  id: string;
  tilemap: string[];
  /** False for the base grid, true for every `layers[]` entry. */
  overlay: boolean;
}

/** Characters a layer paints at a cell, or `undefined` when the overlay leaves it alone. */
export function layerTileAt(layer: TileLayer, x: number, y: number): string | undefined {
  const row = layer.tilemap[y];
  if (row === undefined) return undefined;
  const char = row[x];
  if (char === undefined) return undefined;
  return layer.overlay && char === TRANSPARENT_TILE ? undefined : char;
}

/**
 * Every layer of a location, in draw order (base first), normalised.
 *
 * Malformed entries are skipped rather than half-read: the validator is where they are reported, and
 * a renderer that guesses at a broken overlay would draw something the author never wrote.
 */
export function tileLayers(location: unknown): TileLayer[] {
  if (!isRecord(location)) return [];

  const base = Array.isArray(location["tilemap"]) ? (location["tilemap"] as unknown[]).map(String) : [];
  const layers: TileLayer[] = [{ id: BASE_LAYER_ID, tilemap: base, overlay: false }];

  const authored = Array.isArray(location["layers"]) ? (location["layers"] as unknown[]) : [];
  for (const entry of authored) {
    if (!isRecord(entry)) continue;
    const id = typeof entry["id"] === "string" ? entry["id"].trim() : "";
    const tilemap = Array.isArray(entry["tilemap"]) ? (entry["tilemap"] as unknown[]).map(String) : [];
    if (id === "" || tilemap.length === 0) continue;
    layers.push({ id, tilemap, overlay: true });
  }

  return layers;
}
