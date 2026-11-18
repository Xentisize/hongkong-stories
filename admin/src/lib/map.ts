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

// --- layers ------------------------------------------------------------------------------

/** One overlay grid. The base grid stays in the location's own `tilemap`. */
export interface TileLayerDoc {
  id: string;
  tilemap: TileMap;
}

/** Overlays as authored, with malformed entries dropped — the same skip the clients make. */
export function overlaysOf(layers: unknown): TileLayerDoc[] {
  if (!Array.isArray(layers)) return [];

  const overlays: TileLayerDoc[] = [];
  for (const entry of layers) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Partial<TileLayerDoc>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (id === "" || !Array.isArray(record.tilemap)) continue;
    overlays.push({ id, tilemap: record.tilemap.map(String) });
  }
  return overlays;
}

/** Paint into one overlay; the same array by identity when the write changed nothing. */
export function paintLayer(
  layers: TileLayerDoc[],
  index: number,
  x: number,
  y: number,
  char: string,
): TileLayerDoc[] {
  const layer = layers[index];
  if (layer === undefined) return layers;
  const next = paintTile(layer.tilemap, x, y, char);
  if (next === layer.tilemap) return layers;
  return layers.map((entry, at) => (at === index ? { ...entry, tilemap: next } : entry));
}

/** Rect fill into one overlay, with the same identity rule. */
export function fillLayerRect(
  layers: TileLayerDoc[],
  index: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  char: string,
): TileLayerDoc[] {
  const layer = layers[index];
  if (layer === undefined) return layers;
  const next = fillRect(layer.tilemap, x0, y0, x1, y1, char);
  if (next === layer.tilemap) return layers;
  return layers.map((entry, at) => (at === index ? { ...entry, tilemap: next } : entry));
}

/** A new overlay, transparent everywhere (` ` paints nothing once it is an overlay). */
export function blankLayer(id: string, width: number, height: number): TileLayerDoc {
  return { id, tilemap: blankMap(width, height, " ") };
}

/** The first free `layer_<n>`, so adding twice never mints the same id. */
export function freeLayerId(layers: TileLayerDoc[]): string {
  const taken = new Set(layers.map((layer) => layer.id));
  for (let number = 1; ; number += 1) {
    const id = `layer_${number}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * Pad overlays to the map's size with transparency.
 *
 * The base grid defines the map, so growing it must grow the overlays too — otherwise every overlay
 * is suddenly a row short and the validator refuses the document the author just resized.
 * Already-covering layers come back by identity, so an ordinary resize records one undo step.
 */
export function resizeLayers(layers: TileLayerDoc[], width: number, height: number): TileLayerDoc[] {
  const needsPadding = layers.some((layer) => {
    const size = mapSize(layer.tilemap);
    return size.width < width || size.height < height;
  });
  if (!needsPadding) return layers;

  return layers.map((layer) => ({ ...layer, tilemap: growMap(layer.tilemap, width, height, " ") }));
}

/** Swap a layer with its neighbour in the draw order; identity when the move is out of range. */
export function moveLayer(layers: TileLayerDoc[], index: number, delta: number): TileLayerDoc[] {
  const target = index + delta;
  if (layers[index] === undefined || target < 0 || target >= layers.length) return layers;

  const next = [...layers];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  return next;
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

// --- collision ---------------------------------------------------------------------------

/**
 * Collision is authored as rectangles `[x, y, w, h]` in **tile units**, not as a per-cell grid.
 *
 * A painter works per cell, so editing goes through a rasterise/decompose round trip: rects → grid →
 * toggle one cell → decompose back to rects. That keeps `collision` (the thing the client reads) as
 * the only stored form — there is no second source of truth to drift out of step.
 *
 * The decomposition is greedy and row-major, so a given grid always compresses to the same rects.
 * It rewrites the whole list on any edit, which is why an author sees a larger diff than the one
 * cell they changed; the union of rectangles is identical either way.
 */
export type CollisionRect = [number, number, number, number];

/** Rasterise rects onto the map's grid. Rects are clipped, and malformed ones are ignored. */
export function collisionGrid(
  rects: CollisionRect[] | undefined,
  width: number,
  height: number,
): boolean[][] {
  const grid = Array.from({ length: Math.max(0, height) }, () =>
    new Array<boolean>(Math.max(0, width)).fill(false),
  );

  for (const rect of rects ?? []) {
    if (!Array.isArray(rect) || rect.length < 4) continue;
    const [rx, ry, rw, rh] = rect.map(Number) as CollisionRect;
    if (!Number.isFinite(rx) || !Number.isFinite(ry) || !Number.isFinite(rw) || !Number.isFinite(rh)) continue;
    if (rw <= 0 || rh <= 0) continue;

    for (let y = Math.max(0, ry); y < Math.min(height, ry + rh); y += 1) {
      for (let x = Math.max(0, rx); x < Math.min(width, rx + rw); x += 1) {
        grid[y]![x] = true;
      }
    }
  }

  return grid;
}

/** One-cell query, without rasterising the whole map. */
export function solidAt(rects: CollisionRect[] | undefined, x: number, y: number): boolean {
  return (rects ?? []).some(
    (rect) =>
      Array.isArray(rect) &&
      x >= Number(rect[0]) &&
      x < Number(rect[0]) + Number(rect[2]) &&
      y >= Number(rect[1]) &&
      y < Number(rect[1]) + Number(rect[3]),
  );
}

/** Compress a solid/empty grid into rectangles by greedy row-major extension. */
export function gridToRects(grid: boolean[][]): CollisionRect[] {
  const height = grid.length;
  const width = height > 0 ? (grid[0]?.length ?? 0) : 0;
  const covered = Array.from({ length: height }, () => new Array<boolean>(width).fill(false));
  const rects: CollisionRect[] = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (grid[y]![x] !== true || covered[y]![x] === true) continue;

      // Extend right along the row.
      let right = x;
      while (right + 1 < width && grid[y]![right + 1] === true && covered[y]![right + 1] !== true) {
        right += 1;
      }

      // Then grow downwards for as long as the whole run is still solid and unclaimed.
      let bottom = y;
      const rowMatches = (row: number) => {
        for (let column = x; column <= right; column += 1) {
          if (grid[row]?.[column] !== true || covered[row]?.[column] === true) return false;
        }
        return true;
      };
      while (bottom + 1 < height && rowMatches(bottom + 1)) bottom += 1;

      for (let yy = y; yy <= bottom; yy += 1) {
        for (let xx = x; xx <= right; xx += 1) covered[yy]![xx] = true;
      }

      rects.push([x, y, right - x + 1, bottom - y + 1]);
    }
  }

  return rects;
}

/**
 * Mark one cell solid or empty, returning the same array when nothing changed.
 *
 * Painting and erasing share this path: a drag decides once whether it is laying walls down or
 * taking them away, so sweeping back over a cell mid-stroke does not undo the stroke.
 */
export function paintCollision(
  rects: CollisionRect[] | undefined,
  x: number,
  y: number,
  solid: boolean,
  width: number,
  height: number,
): CollisionRect[] {
  const existing = rects ?? [];
  if (x < 0 || y < 0 || x >= width || y >= height) return existing;

  const grid = collisionGrid(existing, width, height);
  if (grid[y]![x] === solid) return existing;

  grid[y]![x] = solid;
  return gridToRects(grid);
}

/** Clamp to `[low, high]`, tolerating `high < low` by returning `low`. */
function clamp(value: number, low: number, high: number): number {
  if (high < low) return low;
  return Math.min(high, Math.max(low, value));
}

/** Normalised, clipped bounds of a drag — `null` when it misses the map entirely. */
function dragBounds(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  height: number,
): { left: number; right: number; top: number; bottom: number } | null {
  if (width <= 0 || height <= 0) return null;

  const rawLeft = Math.min(x0, x1);
  const rawRight = Math.max(x0, x1);
  const rawTop = Math.min(y0, y1);
  const rawBottom = Math.max(y0, y1);

  // A drag that never touches the map must do nothing — clamping it to the edge would silently fill
  // a row or column the author never pointed at. A drag that starts inside and runs past the edge is
  // a different case: that one is clipped below.
  if (rawRight < 0 || rawBottom < 0 || rawLeft > width - 1 || rawTop > height - 1) return null;

  return {
    left: clamp(rawLeft, 0, width - 1),
    right: clamp(rawRight, 0, width - 1),
    top: clamp(rawTop, 0, height - 1),
    bottom: clamp(rawBottom, 0, height - 1),
  };
}

/**
 * Fill a rectangular region with one character.
 *
 * The rectangle tool is what makes a 28x14 map pleasant to author: dragging a room's floor beats
 * clicking every cell. Returns the same map when nothing changed, so a drag over already-matching
 * tiles records no undo step.
 */
export function fillRect(
  map: TileMap,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  char: string,
): TileMap {
  const width = mapSize(map).width;
  const bounds = dragBounds(x0, y0, x1, y1, width, map.length);
  if (!bounds) return map;

  let changed = false;
  const next = [...map];

  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    const row = next[y] ?? "";
    const end = Math.min(bounds.right, row.length - 1);
    if (end < bounds.left) continue; // ragged row shorter than the rectangle's start

    const updated =
      row.slice(0, bounds.left) + char.repeat(end - bounds.left + 1) + row.slice(end + 1);
    if (updated !== row) {
      next[y] = updated;
      changed = true;
    }
  }

  return changed ? next : map;
}

/** Fill a rectangle solid or empty, sharing the tile tool's bounds rules. */
export function setCollisionRect(
  rects: CollisionRect[] | undefined,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  solid: boolean,
  width: number,
  height: number,
): CollisionRect[] {
  const existing = rects ?? [];
  const bounds = dragBounds(x0, y0, x1, y1, width, height);
  if (!bounds) return existing;

  const grid = collisionGrid(existing, width, height);
  let changed = false;

  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    for (let x = bounds.left; x <= bounds.right; x += 1) {
      if (grid[y]![x] !== solid) {
        grid[y]![x] = solid;
        changed = true;
      }
    }
  }

  return changed ? gridToRects(grid) : existing;
}
