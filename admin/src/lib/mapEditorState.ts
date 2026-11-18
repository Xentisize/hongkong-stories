import type { MapNpc, TileMap } from "./map";

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
  spawn_points?: Record<string, [number, number]>;
  [field: string]: unknown;
};

export interface MapState {
  doc: LocationDoc | null;
  history: LocationDoc[];
}

export type MapAction =
  | { type: "load"; doc: LocationDoc }
  | { type: "apply"; next: LocationDoc }
  | { type: "undo" }
  | { type: "clear" };

/** How many undo steps are kept. Deep enough to recover a session's work, bounded so it cannot grow. */
export const MAX_HISTORY = 50;

export function reducer(state: MapState, action: MapAction): MapState {
  switch (action.type) {
    case "load":
      // Re-loading (or saving) makes this document the new origin, so the undo stack empties.
      return { doc: action.doc, history: [] };
    case "clear":
      return { doc: null, history: [] };
    case "undo": {
      const previous = state.history[state.history.length - 1];
      if (!previous) return state;
      return { doc: previous, history: state.history.slice(0, -1) };
    }
    case "apply":
      if (!state.doc || action.next === state.doc) return state;
      return { doc: action.next, history: [...state.history.slice(-(MAX_HISTORY - 1)), state.doc] };
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
