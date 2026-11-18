import type { CollisionRect, MapNpc, TileMap } from "./map";

/**
 * Editor state for one location (PLAN 9.2).
 *
 * A location document plus an undo stack of previous documents. The stack holds whole documents, not
 * individual cells, because one drag paints many cells and has to collapse into one undo step.
 *
 * `apply` treats *identity* as "nothing changed" — `paintTile` and `moveNpc` return the same array
 * when a gesture was a no-op, so a drag across already-painted tiles records no history at all.
 * Without that, a single sweep would bury the real edit under dozens of identical snapshots.
 */

export type LocationDoc = {
  id?: string;
  display_name?: Record<string, string>;
  tilemap?: TileMap;
  legend?: Record<string, [number, number]>;
  tile_size?: number;
  atlas?: string;
  npcs?: MapNpc[];
  collision?: CollisionRect[];
  spawn_points?: Record<string, [number, number]>;
  [field: string]: unknown;
};

export interface MapState {
  doc: LocationDoc | null;
  history: LocationDoc[];
  /**
   * Documents that undo moved away from, newest last.
   *
   * Optional so existing state literals stay valid, and treated as `[]` when absent. Any fresh edit
   * clears it: keeping a stale future would let a redo overwrite work the author just did.
   */
  future?: LocationDoc[];
}

export type MapAction =
  | { type: "load"; doc: LocationDoc }
  | { type: "apply"; next: LocationDoc }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "clear" };

/** How many steps each direction keeps. Deep enough for a session, bounded so it cannot grow. */
export const MAX_HISTORY = 50;

export function reducer(state: MapState, action: MapAction): MapState {
  const future = state.future ?? [];

  switch (action.type) {
    case "load":
      // Re-loading (or saving) makes this document the new origin, so both stacks empty.
      return { doc: action.doc, history: [], future: [] };
    case "clear":
      return { doc: null, history: [], future: [] };
    case "undo": {
      const previous = state.history[state.history.length - 1];
      if (!previous) return state;
      return {
        doc: previous,
        history: state.history.slice(0, -1),
        future: [...future.slice(-(MAX_HISTORY - 1)), state.doc!],
      };
    }
    case "redo": {
      const next = future[future.length - 1];
      if (!next) return state;
      return {
        doc: next,
        history: [...state.history.slice(-(MAX_HISTORY - 1)), state.doc!],
        future: future.slice(0, -1),
      };
    }
    case "apply":
      if (!state.doc || action.next === state.doc) return state;
      return {
        doc: action.next,
        history: [...state.history.slice(-(MAX_HISTORY - 1)), state.doc],
        // A fresh edit makes the redo branch unreachable.
        future: [],
      };
  }
}

/**
 * Guard against a malformed draft.
 *
 * A location whose `tilemap` is not an array, or whose `npcs` contains an entry without `tile`, would
 * otherwise crash the canvas mid-render — during authoring, on the one screen that is supposed to
 * make broken content visible.
 */
export function normalise(raw: unknown): LocationDoc {
  const doc = (raw ?? {}) as LocationDoc;
  return {
    ...doc,
    tilemap: Array.isArray(doc.tilemap) ? doc.tilemap.map(String) : [],
    npcs: Array.isArray(doc.npcs)
      ? (doc.npcs as MapNpc[]).filter(
          (entry) => entry !== null && typeof entry === "object" && Array.isArray(entry.tile),
        )
      : [],
  };
}
