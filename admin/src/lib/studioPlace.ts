/* Putting something into a scene, as a pure edit.
 *
 * The Build place's palette ends in one call: "this character stands on that tile". Keeping it here
 * means the placement rules are testable without a game, an iframe or a draft: off-map tiles and
 * empty ids are refused rather than written, and a placement never mutates the document it was
 * handed — the caller decides whether to save it.
 */

import { paintTile, placeNpc, type MapNpc, type TileMap } from "./map";

export type PlacementKind = "npc" | "decor" | "tile";

export interface Placement {
  kind: PlacementKind;
  /** An NPC id for `npc`, a pack-relative art path for `decor`, a legend character for `tile`. */
  id: string;
}

export interface LocationLike {
  tilemap?: string[];
  npcs?: MapNpc[];
  decor?: Array<{ art?: string; tile?: [number, number] }>;
  legend?: Record<string, unknown>;
  [field: string]: unknown;
}

/** The map's size: the longest row decides the width, so ragged rows cannot hide their right edge. */
export function tilemapBounds(tilemap: unknown): { width: number; height: number } {
  const rows = Array.isArray(tilemap)
    ? tilemap.filter((row): row is string => typeof row === "string")
    : [];
  return {
    width: rows.reduce((max, row) => Math.max(max, row.length), 0),
    height: rows.length,
  };
}

export function inBounds(tilemap: unknown, tile: [number, number]): boolean {
  const { width, height } = tilemapBounds(tilemap);
  const [x, y] = tile;
  return (
    Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < width && y < height
  );
}

/**
 * Place a character or prop on a tile, or return null when it cannot be placed.
 *
 * One thing per cell: placing on an occupied cell replaces it, which is how a drawn map reads and
 * what the map editor already does for characters.
 */
export function placeInLocation<T extends LocationLike>(
  doc: T,
  placement: Placement,
  tile: [number, number],
): T | null {
  if (placement.id.trim() === "") return null;
  if (!inBounds(doc.tilemap, tile)) return null;

  const next = structuredClone(doc);
  const [x, y] = tile;

  if (placement.kind === "tile") {
    // A character nobody's legend defines would paint a cell no renderer can draw.
    const legend = next.legend ?? {};
    if (!(placement.id in legend)) return null;
    const painted = paintTile((next.tilemap ?? []) as TileMap, x, y, placement.id);
    if (painted === next.tilemap) return null; // a ragged row: the cell does not exist
    next.tilemap = painted;
    return next;
  }

  if (placement.kind === "npc") {
    next.npcs = placeNpc(Array.isArray(next.npcs) ? next.npcs : [], placement.id, x, y);
    return next;
  }

  const decor = Array.isArray(next.decor) ? next.decor : [];
  next.decor = [
    ...decor.filter((entry) => !(entry?.tile?.[0] === x && entry?.tile?.[1] === y)),
    { art: placement.id, tile: [x, y] },
  ];
  return next;
}
