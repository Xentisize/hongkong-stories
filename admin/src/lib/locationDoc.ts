/* The parts of a location the map canvas does not draw (PLAN §5.1/§9.2).
 *
 * The canvas owns tiles, the legend, collision and NPC markers. What is left is the document around
 * them: the localized name, the per-map context sheet the NPC prompts read, the ambience bed, the
 * spawn points NPCs and exits land on, and the two kinds of reference that the validator is strict
 * about — `doors` (tiles + an optional open flag) and `exits` (a rect, a target location, and a
 * spawn name that must exist on the other side).
 *
 * The helpers here are the parts of that with rules worth holding still: id allocation that cannot
 * collide, and the tile/rect text formats the form shows. Everything is pure, so the panel that
 * uses them stays a form.
 */

import type { LocalizedTable } from "./localized";
import type { CollisionRect } from "./map";

export interface DoorDoc {
  id?: string;
  /** The tiles the door occupies — a door is walked into, not clicked. */
  tiles?: Array<[number, number]>;
  requires?: unknown;
  /** Set when the door opens, so it stays open across sessions. */
  open_flag?: string;
  prompt?: LocalizedTable;
  blocked?: LocalizedTable;
  opened?: LocalizedTable;
  [field: string]: unknown;
}

export interface ExitDoc {
  id?: string;
  /** `[x, y, w, h]` in tile units. */
  rect?: CollisionRect;
  to?: string;
  spawn?: string;
  requires?: unknown;
  blocked?: LocalizedTable;
  [field: string]: unknown;
}

export interface InteractableDoc {
  id?: string;
  /** The cell it sits on — the one thing the client refuses to draw without. */
  tile?: [number, number];
  /** Content-relative prop art. Empty is legal: an invisible trigger (a sound, a cutscene cue). */
  art?: string;
  scale?: number;
  requires?: unknown;
  /** Removed after one use — a pick-up that repeats hands out its item forever. */
  once?: boolean;
  prompt?: LocalizedTable;
  on_interact?: unknown;
  [field: string]: unknown;
}

export interface DecorDoc {
  art?: string;
  tile?: [number, number];
  [field: string]: unknown;
}

const POINT = /^\s*(\d+)\s*,\s*(\d+)\s*$/;

/** Spawn names, `default` first — the order a picker should show them in. */
export function spawnNames(spawnPoints: unknown): string[] {
  const names =
    spawnPoints !== null && typeof spawnPoints === "object" && !Array.isArray(spawnPoints)
      ? Object.keys(spawnPoints as Record<string, unknown>)
      : [];

  const rest = names.filter((name) => name !== "default").sort();
  return names.includes("default") ? ["default", ...rest] : rest;
}

/**
 * `stem` + the smallest free number: `door_` → `door_1`, `door_2`, `door_3`…
 *
 * The number is chosen, never derived from the entry count — deleting the second of three doors must
 * not hand the next one an id a surviving door already answers to.
 */
export function freeEntryId(entries: Array<{ id?: unknown }>, stem: string, start = 1): string {
  const taken = new Set(entries.map((entry) => String(entry.id ?? "")));
  for (let number = start; ; number += 1) {
    const candidate = `${stem}${number}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function blankDoor(tile: [number, number], id = "door_1"): DoorDoc {
  return {
    id,
    tiles: [[tile[0], tile[1]]],
    requires: null,
    prompt: {},
  };
}

export function blankExit(rect: CollisionRect, to: string, id = "exit_1"): ExitDoc {
  return { id, rect, to, spawn: "default" };
}

/**
 * `"9,11; 10,11"` → the tile pairs. Unparseable fragments are dropped rather than guessed at, so a
 * half-typed edit leaves the door on its previous tiles instead of at the origin.
 */
export function parseTiles(text: string): Array<[number, number]> {
  const tiles: Array<[number, number]> = [];
  for (const fragment of text.split(";")) {
    const match = POINT.exec(fragment);
    if (match) tiles.push([Number(match[1]), Number(match[2])]);
  }
  return tiles;
}

export function formatTiles(tiles: unknown): string {
  if (!Array.isArray(tiles)) return "";
  return tiles
    .filter((tile): tile is [number, number] => Array.isArray(tile) && tile.length >= 2)
    .map(([x, y]) => `${x},${y}`)
    .join("; ");
}

/** `"0,4,1,3"` → `[0, 4, 1, 3]`; `null` when it is not four whole numbers. */
export function parseRect(text: string): CollisionRect | null {
  const parts = text.split(",").map((part) => part.trim());
  if (parts.length !== 4) return null;
  const values = parts.map((part) => (/^-?\d+$/.test(part) ? Number(part) : Number.NaN));
  if (values.some((value) => Number.isNaN(value))) return null;
  return values as CollisionRect;
}

export function formatRect(rect: unknown): string {
  return Array.isArray(rect) && rect.length === 4 ? rect.join(",") : "";
}

/**
 * Why an exit would never fire, in the client's own terms.
 *
 * `exitZones` in the web client drops a rect that is not four numbers or that has no area, and a
 * zone dragged off the map can never be entered. Both are silent at runtime, which is exactly the
 * kind of mistake an editor should say out loud.
 */
export function rectProblem(rect: unknown, width: number, height: number): string | null {
  if (!Array.isArray(rect) || rect.length !== 4) return "需要 [x, y, w, h] / expects [x, y, w, h]";
  const [x, y, w, h] = rect as CollisionRect;
  if (w <= 0 || h <= 0) return "面積為零，玩家行唔到入去 / zero area, the zone can never fire";
  if (x < 0 || y < 0 || x + w > width || y + h > height) {
    return `出界：地圖係 ${width}×${height} / outside the ${width}×${height} map`;
  }
  return null;
}

/** `"9,11"` → `[9, 11]`; `null` when it is not a whole-number cell. */
export function parsePoint(text: string): [number, number] | null {
  const match = POINT.exec(text);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

export function formatPoint(tile: unknown): string {
  return Array.isArray(tile) && tile.length >= 2 ? `${tile[0]},${tile[1]}` : "";
}

/**
 * A new interactable at a cell.
 *
 * `once: true` by default, because the failure mode of the other default is worse: an object whose
 * `on_interact` gives an item hands it out again on every press, and nothing in the pack says so.
 * An author who wants a repeatable switch turns it off deliberately.
 */
export function blankInteractable(
  tile: [number, number],
  id = "object_1",
  art = "",
): InteractableDoc {
  return {
    id,
    tile: [tile[0], tile[1]],
    art,
    scale: 1,
    once: true,
    prompt: {},
    on_interact: [],
  };
}

/** A new piece of set dressing at a cell. `art` is required — that is the whole entry. */
export function blankDecor(tile: [number, number], art: string): DecorDoc {
  return { art, tile: [tile[0], tile[1]] };
}

/**
 * Why an art reference will not draw.
 *
 * The client keeps only the file name (`artFileName`), so a path that climbs out of the pack or is
 * absolute is not merely unconventional — it is either dropped or the wrong file. An empty `art` is
 * fine for an interactable (an invisible trigger) and fatal for decor (the entry is then invisible
 * set dressing that does nothing at all).
 */
export function artProblem(art: unknown, required: boolean): string | null {
  const path = typeof art === "string" ? art.trim() : "";
  if (path === "") {
    return required ? "冇圖片，玩家咩都見唔到 / no art: the client draws nothing" : null;
  }
  if (path.startsWith("/") || path.startsWith("res://") || path.includes("..")) {
    return "要用內容相對路徑，例如 art/props/prop_crate.png / content-relative path required";
  }
  return null;
}

