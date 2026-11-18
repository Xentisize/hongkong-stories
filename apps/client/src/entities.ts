import { artFileName, tileCentre, type LocalizedText, type LocationFile } from "./content";

/**
 * The world entities a location content file defines, resolved to the geometry a renderer needs.
 *
 * All of this is pure: content in, pixels and rectangles out. `location_root.gd` builds the same
 * things in a fixed order (tiles, collision, decor, doors, interactables, NPCs, exits) and the
 * decisions that are easy to get wrong — a door's blocker spanning the union of its tiles, an exit
 * zone sitting on its rect's centre, a wander step that stays inside the radius — belong somewhere a
 * test can reach them rather than inside a scene.
 */

export interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PixelPoint {
  x: number;
  y: number;
}

export interface DecorPlacement {
  /** Bare file name, which is how the prop atlas is keyed. */
  file: string;
  art: string;
  point: PixelPoint;
}

export interface ExitZone {
  id: string;
  to: string;
  spawn: string;
  requires: unknown;
  blocked: LocalizedText | null;
  rect: TileRect;
  centre: PixelPoint;
  /** Pixel extents, for the overlap test. */
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface InteractablePlacement {
  id: string;
  file: string;
  scale: number;
  once: boolean;
  prompt: LocalizedText | null;
  requires: unknown;
  effects: unknown[];
  point: PixelPoint;
}

export interface DoorPlacement {
  id: string;
  tiles: Array<[number, number]>;
  requires: unknown;
  openFlag: string;
  prompt: LocalizedText | null;
  blocked: LocalizedText | null;
  opened: LocalizedText | null;
  /** The union of the door's tiles, which is what its blocker spans. */
  bounds: TileRect;
  centre: PixelPoint;
}

function localized(value: unknown): LocalizedText | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as LocalizedText)
    : null;
}

function tileSize(location: LocationFile): number {
  const size = Number(location.tile_size);
  return Number.isFinite(size) && size > 0 ? size : 24;
}

export function decorPlacements(location: LocationFile): DecorPlacement[] {
  const placements: DecorPlacement[] = [];

  for (const entry of location.decor ?? []) {
    const art = String(entry.art ?? "");
    if (art === "" || !Array.isArray(entry.tile)) continue;
    placements.push({ art, file: artFileName(art), point: tileCentre(location, entry.tile) });
  }

  return placements;
}

export function exitZones(location: LocationFile): ExitZone[] {
  const size = tileSize(location);
  const zones: ExitZone[] = [];

  for (const entry of location.exits ?? []) {
    const rect = entry.rect;
    if (!Array.isArray(rect) || rect.length !== 4) continue;

    const [x, y, width, height] = rect;
    if (width <= 0 || height <= 0) continue;

    const left = x * size;
    const top = y * size;
    const pixelWidth = width * size;
    const pixelHeight = height * size;

    zones.push({
      id: entry.id,
      to: entry.to,
      spawn: entry.spawn ?? "default",
      requires: entry.requires ?? null,
      blocked: localized(entry.blocked),
      rect: { x, y, width, height },
      // `exit_zone.gd` centres the area on its rect rather than anchoring it top-left.
      centre: { x: left + pixelWidth / 2, y: top + pixelHeight / 2 },
      left,
      top,
      width: pixelWidth,
      height: pixelHeight,
    });
  }

  return zones;
}

/** The exit zone containing a pixel position, if any. */
export function exitAt(zones: ExitZone[], x: number, y: number): ExitZone | null {
  for (const zone of zones) {
    if (x >= zone.left && x < zone.left + zone.width && y >= zone.top && y < zone.top + zone.height) {
      return zone;
    }
  }
  return null;
}

export function interactablePlacements(location: LocationFile): InteractablePlacement[] {
  const placements: InteractablePlacement[] = [];

  for (const entry of location.interactables ?? []) {
    if (!Array.isArray(entry.tile)) continue;

    const art = String(entry.art ?? "");
    const scale = Number(entry.scale);
    placements.push({
      id: entry.id,
      file: art === "" ? "" : artFileName(art),
      scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
      once: entry.once === true,
      prompt: localized(entry.prompt),
      requires: entry.requires ?? null,
      effects: Array.isArray(entry.on_interact) ? entry.on_interact : [],
      point: tileCentre(location, entry.tile),
    });
  }

  return placements;
}

export function doorPlacements(location: LocationFile): DoorPlacement[] {
  const size = tileSize(location);
  const placements: DoorPlacement[] = [];

  for (const entry of location.doors ?? []) {
    const tiles: Array<[number, number]> = [];
    for (const tile of entry.tiles ?? []) {
      if (Array.isArray(tile) && tile.length === 2) tiles.push([Number(tile[0]), Number(tile[1])]);
    }
    if (tiles.length === 0) continue;

    // `door.gd` derives both the blocker and the node position from the union of the tiles.
    const xs = tiles.map(([x]) => x);
    const ys = tiles.map(([, y]) => y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;

    placements.push({
      id: entry.id,
      tiles,
      requires: entry.requires ?? null,
      openFlag: String(entry.open_flag ?? ""),
      prompt: localized(entry.prompt),
      blocked: localized(entry.blocked),
      opened: localized(entry.opened),
      bounds: { x: minX, y: minY, width, height },
      centre: { x: (minX + width / 2) * size, y: (minY + height / 2) * size },
    });
  }

  return placements;
}

/**
 * Replace a door's cells with floor, which is what opening a door looks like in a char grid.
 *
 * Returns the same array when nothing changed, so re-opening an open door records no redraw.
 */
export function openDoorTiles(
  tilemap: string[],
  tiles: Array<[number, number]>,
  floor: string,
): string[] {
  let rows = tilemap;
  let changed = false;

  for (const [x, y] of tiles) {
    const row = rows[y];
    if (row === undefined || x < 0 || x >= row.length) continue;
    if (row[x] === floor) continue;

    if (!changed) {
      rows = [...tilemap];
      changed = true;
    }
    rows[y] = (rows[y] ?? "").slice(0, x) + floor + (rows[y] ?? "").slice(x + 1);
  }

  return rows;
}

/**
 * Pick a wander destination inside the placement's radius, or null if nothing walkable is close.
 *
 * `npc_body.gd` tries eight times and gives up, which keeps a fixture (radius 0, or a cornered NPC)
 * still instead of sliding it through a wall. The random source is injected so a test can pin it.
 */
export function pickWanderTarget(
  home: [number, number],
  radius: number,
  walkable: (x: number, y: number) => boolean,
  rand: () => number = Math.random,
  attempts = 8,
): [number, number] | null {
  const span = Math.trunc(Math.abs(radius));
  if (span <= 0) return null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // The inclusive range `randi_range(-span, span)`, not a scaled float.
    const dx = Math.floor(rand() * (2 * span + 1)) - span;
    const dy = Math.floor(rand() * (2 * span + 1)) - span;
    if (dx === 0 && dy === 0) continue;

    const x = home[0] + dx;
    const y = home[1] + dy;
    if (walkable(x, y)) return [x, y];
  }

  return null;
}

/**
 * Which way a walk sheet should face to travel from one point to another.
 *
 * Magnitude decides, exactly as `npc_body.gd`'s `_direction_name` does. This is *not* the player's
 * rule: the player keeps the sideways sprite whenever dx is non-zero, even on a diagonal.
 */
export function facingBetween(from: PixelPoint, to: PixelPoint): "left" | "right" | "up" | "down" {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  // A magnitude tie goes vertical, so a purely diagonal step keeps the facing it already had.
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}
