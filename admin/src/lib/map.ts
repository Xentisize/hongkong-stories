/**
 * Map editing primitives (PLAN 6.3, 9.2).
 *
 * A location's geometry is a **character grid plus a legend** — `tilemap: string[]` where each
 * character indexes a tile in the atlas:
 *
 *   legend:   { ".": [0,0], ",": [1,0], "#": [2,0], "D": [3,0] }
 *   tilemap:  ["####...####", "#....D....#", …]
 *
 * That makes painting a text edit rather than an image operation, which is why these helpers are
 * pure string functions and why the editor needs no engine, no binary format and no converter.
 *
 * Everything here is immutable: `paintTile` returns a new grid or the *same* array when nothing
 * changed, so the undo stack does not fill with no-ops from merely dragging over a painted tile.
 */

export type TileMap = string[];

/** A placement as authored: tile coordinates, not pixels. */
export interface MapNpc {
  npc: string;
  tile: [number, number];
  facing?: string;
  wander?: number;
  requires?: unknown;
  [field: string]: unknown;
}

export const FACINGS = ["down", "right", "left", "up"] as const;

/**
 * `res://assets/...` is a Godot resource path. The browser needs the route that serves
 * `client/assets`, so the mapping lives in one place instead of in every component that shows art.
 */
export function atlasUrl(atlas: string | undefined): string {
  if (!atlas) return "";
  if (/^https?:\/\//i.test(atlas) || atlas.startsWith("/") || atlas.startsWith("data:")) return atlas;
  const prefix = "res://assets/";
  if (atlas.startsWith(prefix)) return `/v1/assets/file/${atlas.slice(prefix.length)}`;
  // Some other res:// path we do not serve; return it untouched so the failure is visible as a
  // broken image rather than a silently wrong URL.
  return atlas;
}

export function mapSize(map: TileMap): { width: number; height: number } {
  return {
    width: map.reduce((widest, row) => Math.max(widest, row.length), 0),
    height: map.length,
  };
}

export interface LegendEntry {
  char: string;
  col: number;
  row: number;
}

/** Legend entries in a stable order, so the palette does not jump around between renders. */
export function legendEntries(legend: Record<string, [number, number]> | undefined): LegendEntry[] {
  if (!legend) return [];
  return Object.entries(legend)
    .map(([char, position]) => ({ char, col: position[0], row: position[1] }))
    .sort((a, b) => a.row - b.row || a.col - b.col);
}

/** The character at a cell, or undefined outside the map (ragged rows included). */
export function tileAt(map: TileMap, x: number, y: number): string | undefined {
  if (y < 0 || y >= map.length) return undefined;
  return map[y]?.[x];
}

/**
 * Write one character. Out-of-bounds and no-op writes return the original array by identity, which
 * is what keeps a drag gesture from pushing dozens of identical snapshots onto the undo stack.
 */
export function paintTile(map: TileMap, x: number, y: number, char: string): TileMap {
  const row = map[y];
  if (row === undefined || x < 0 || x >= row.length) return map;
  if (row[x] === char) return map;
  const next = [...map];
  next[y] = row.slice(0, x) + char + row.slice(x + 1);
  return next;
}

/** A fresh rectangular map filled with one character. */
export function blankMap(width: number, height: number, char = "#"): TileMap {
  return Array.from({ length: height }, () => char.repeat(width));
}

/** Grow a map to at least the requested size, padding new cells with `char`. */
export function growMap(map: TileMap, width: number, height: number, char = "#"): TileMap {
  const current = mapSize(map);
  const targetWidth = Math.max(width, current.width);
  const targetHeight = Math.max(height, current.height);

  return Array.from({ length: targetHeight }, (_, y) => {
    const row = map[y] ?? "";
    return row.length >= targetWidth ? row : row + char.repeat(targetWidth - row.length);
  });
}

// --- NPC placements ----------------------------------------------------------------------

export function npcIndexAt(npcs: MapNpc[], x: number, y: number): number {
  return npcs.findIndex((entry) => entry.tile[0] === x && entry.tile[1] === y);
}

/** Move a placement. Rejects a move onto another placement, which would stack two markers. */
export function moveNpc(npcs: MapNpc[], index: number, x: number, y: number): MapNpc[] {
  const target = npcs[index];
  if (!target) return npcs;
  if (target.tile[0] === x && target.tile[1] === y) return npcs;
  if (npcs.some((entry, at) => at !== index && entry.tile[0] === x && entry.tile[1] === y)) return npcs;

  return npcs.map((entry, at) => (at === index ? { ...entry, tile: [x, y] as [number, number] } : entry));
}

export function placeNpc(
  npcs: MapNpc[],
  npcId: string,
  x: number,
  y: number,
  facing = "down",
): MapNpc[] {
  if (!npcId) return npcs;
  // One marker per cell: placing on an occupied cell replaces, matching how a drawn map reads.
  const without = npcs.filter((entry) => !(entry.tile[0] === x && entry.tile[1] === y));
  return [...without, { npc: npcId, tile: [x, y], facing }];
}

export function removeNpcAt(npcs: MapNpc[], x: number, y: number): MapNpc[] {
  return npcs.filter((entry) => !(entry.tile[0] === x && entry.tile[1] === y));
}

/** Split `npcs` into the placement under a cell and whether one exists. */
export function selectedNpc(npcs: MapNpc[], x: number, y: number): MapNpc | undefined {
  const index = npcIndexAt(npcs, x, y);
  return index >= 0 ? npcs[index] : undefined;
}

// --- drag and drop -----------------------------------------------------------------------

/**
 * What is being dragged.
 *
 * A discriminated union rather than a loose payload: dropping a tile and dropping a marker are
 * different operations on different parts of the document, and the compiler should refuse to confuse
 * them.
 */
export type DragPayload =
  | { kind: "tile"; char: string }
  | { kind: "npc"; npcId: string }
  | { kind: "marker"; index: number };

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Which cell a client point falls on, or `null` when it is outside the canvas.
 *
 * Kept separate from the DOM so the arithmetic — the part that silently paints the wrong tile at the
 * wrong zoom — can be tested without a browser.
 */
export function cellFromPoint(
  rect: Rect,
  clientX: number,
  clientY: number,
  tilePx: number,
): [number, number] | null {
  if (tilePx <= 0) return null;

  const x = Math.floor((clientX - rect.left) / tilePx);
  const y = Math.floor((clientY - rect.top) / tilePx);

  // Compare against the rect rather than the map: the canvas is exactly map-size × tile-size, and
  // the map itself may be ragged.
  if (x < 0 || y < 0) return null;
  if ((x + 1) * tilePx > rect.width || (y + 1) * tilePx > rect.height) return null;

  return [x, y];
}

/** The document shape a drop operates on — the subset of a location that this module understands. */
export interface DropTarget {
  tilemap?: TileMap;
  npcs?: MapNpc[];
  [field: string]: unknown;
}

/**
 * Apply a drop to a document.
 *
 * Returns the **same object** when the drop changed nothing, which is what lets the editor treat a
 * drop as one undo step and skip recording no-ops at all.
 */
export function applyDrop<T extends DropTarget>(doc: T, payload: DragPayload, x: number, y: number): T {
  const tilemap = doc.tilemap ?? [];
  const npcs = doc.npcs ?? [];

  if (payload.kind === "tile") {
    const next = paintTile(tilemap, x, y, payload.char);
    return next === tilemap ? doc : { ...doc, tilemap: next };
  }

  if (payload.kind === "npc") {
    const existing = npcIndexAt(npcs, x, y);
    // Dropping a character back on its own cell must not strip its facing, wander count and
    // condition by replacing it with a bare placement.
    if (existing >= 0 && npcs[existing]?.npc === payload.npcId) return doc;

    const next = placeNpc(npcs, payload.npcId, x, y);
    return next === npcs ? doc : { ...doc, npcs: next };
  }

  const next = moveNpc(npcs, payload.index, x, y);
  return next === npcs ? doc : { ...doc, npcs: next };
}
