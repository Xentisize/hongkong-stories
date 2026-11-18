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

/** The character an overlay uses to paint nothing. */
export const TRANSPARENT_TILE = " ";

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
