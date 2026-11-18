/* Undo for the document forms (PLAN 9.2).
 *
 * The map editor has had a document-level undo stack from the start; every other view kept a bare
 * `useState`, so a mistyped field meant retyping it or discarding the whole draft. This is that
 * stack, generic over the document, with one addition the forms need and a canvas does not:
 * **coalescing**. A canvas edit is a discrete gesture; a form edit arrives once per keystroke, and a
 * history that grows one character at a time is an undo nobody would use.
 *
 * So a run of edits inside `COALESCE_MS` collapses into the step that started it: the snapshot stays
 * (undo still returns to before the run), only the document moves.
 */

import { useCallback, useEffect, useReducer } from "react";

/** Deep enough for a session, bounded so a long form does not grow without limit. */
export const MAX_HISTORY = 50;

/** How long a follow-up edit is treated as part of the same step (typing, not a new decision). */
export const COALESCE_MS = 700;

export interface UndoSnapshot<T> {
  doc: T;
  /** When the snapshot was taken, which is what makes coalescing possible. */
  at: number;
}

export interface UndoState<T> {
  doc: T | null;
  history: UndoSnapshot<T>[];
  /** Documents undo moved away from, newest last. */
  future: T[];
}

export type UndoAction<T> =
  | { type: "load"; doc: T | null }
  | { type: "set"; next: T; at: number; coalesce?: boolean }
  | { type: "undo" }
  | { type: "redo" };

export function undoReducer<T>(state: UndoState<T>, action: UndoAction<T>): UndoState<T> {
  switch (action.type) {
    case "load":
      // Loading (or saving) makes this document the new origin, so both stacks empty.
      return { doc: action.doc, history: [], future: [] };

    case "set": {
      // Identity means "this edit changed nothing" — the forms clone on edit, so a control that
      // wrote the value it already had still hands back a new object; callers avoid that, and this
      // is the guard for the ones that cannot.
      if (state.doc === action.next) return state;

      if (state.doc === null) return { doc: action.next, history: [], future: [] };

      const newest = state.history[state.history.length - 1];
      const continuing = action.coalesce === true && newest !== undefined && action.at - newest.at <= COALESCE_MS;

      if (continuing) {
        // Same step: the document moves, the snapshot (and therefore the undo target) does not.
        const history = state.history.slice(0, -1);
        return { doc: action.next, history: [...history, { doc: newest!.doc, at: action.at }], future: [] };
      }

      return {
        doc: action.next,
        history: [...state.history.slice(-(MAX_HISTORY - 1)), { doc: state.doc, at: action.at }],
        // A fresh edit makes the redo branch unreachable.
        future: [],
      };
    }

    case "undo": {
      const previous = state.history[state.history.length - 1];
      if (previous === undefined || state.doc === null) return state;
      return {
        doc: previous.doc,
        history: state.history.slice(0, -1),
        future: [...state.future.slice(-(MAX_HISTORY - 1)), state.doc],
      };
    }

    case "redo": {
      const next = state.future[state.future.length - 1];
      if (next === undefined || state.doc === null) return state;
      return {
        doc: next,
        history: [...state.history.slice(-(MAX_HISTORY - 1)), { doc: state.doc, at: Date.now() }],
        future: state.future.slice(0, -1),
      };
    }
  }
}

export interface Undoable<T> {
  doc: T | null;
  canUndo: boolean;
  canRedo: boolean;
  /**
   * What `undo` would restore, without performing it.
   *
   * A form that mutates its model in place (the NPC form does) cannot read the restored document
   * after the dispatch — by then the live object has already been changed by the same edit. Peeking
   * first lets that view copy the target into its own model and re-mount, which is the only honest
   * way to undo over an object it does not own.
   */
  nextUndo: T | null;
  nextRedo: T | null;
  load: (doc: T | null) => void;
  /** Record a new document. `coalesce` is for edits that arrive per keystroke. */
  set: (next: T, options?: { coalesce?: boolean }) => void;
  undo: () => void;
  redo: () => void;
}

/** The document `undo` would restore, or `null` when there is nothing to undo. */
export function peekUndo<T>(state: UndoState<T>): T | null {
  return state.history[state.history.length - 1]?.doc ?? null;
}

/** The document `redo` would restore, or `null` when there is nothing to redo. */
export function peekRedo<T>(state: UndoState<T>): T | null {
  return state.future[state.future.length - 1] ?? null;
}

/** The reducer as a form-friendly handle. Views stop keeping their own `useState` for the draft. */
export function useUndoable<T>(initial: T | null = null): Undoable<T> {
  const [state, dispatch] = useReducer(undoReducer<T>, { doc: initial, history: [] as UndoSnapshot<T>[], future: [] as T[] });

  const load = useCallback((doc: T | null) => dispatch({ type: "load", doc }), []);
  const set = useCallback(
    (next: T, options?: { coalesce?: boolean }) =>
      dispatch({ type: "set", next, at: Date.now(), coalesce: options?.coalesce }),
    [],
  );
  const undo = useCallback(() => dispatch({ type: "undo" }), []);
  const redo = useCallback(() => dispatch({ type: "redo" }), []);

  return {
    doc: state.doc,
    canUndo: state.history.length > 0,
    canRedo: state.future.length > 0,
    nextUndo: peekUndo(state),
    nextRedo: peekRedo(state),
    load,
    set,
    undo,
    redo,
  };
}

/**
 * ⌘Z / ⇧⌘Z for a view's draft.
 *
 * Deliberately *not* skipped inside inputs, unlike the map editor's mode keys: a form's mistake is
 * usually the last thing typed, and a controlled textarea has no native undo to fall back on. The
 * coalescing in the reducer is what makes that reasonable — one ⌘Z takes back a typing run, not a
 * single character.
 */
export function useUndoKeys(undo: () => void, redo: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, redo]);
}
