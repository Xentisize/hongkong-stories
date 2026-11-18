import { describe, expect, test } from "bun:test";

import { COALESCE_MS, MAX_HISTORY, peekRedo, peekUndo, undoReducer, type UndoState } from "./undo";

/**
 * The form views' undo stack.
 *
 * Three rules decide whether undo is usable rather than merely present: an edit that changed nothing
 * records nothing, a run of keystrokes collapses into one step, and a fresh edit makes the redo
 * branch unreachable instead of letting it overwrite the work the author just did.
 */

const doc = (n: number) => ({ name: `n${n}` });
const empty: UndoState<{ name: string }> = { doc: doc(0), history: [], future: [] };

describe("load and set", () => {
  test("load sets the document and clears both stacks", () => {
    const state = undoReducer(
      { doc: doc(1), history: [{ doc: doc(0), at: 1 }], future: [doc(9)] },
      { type: "load", doc: doc(2) },
    );
    expect(state.doc).toEqual(doc(2));
    expect(state.history).toEqual([]);
    expect(state.future).toEqual([]);
  });

  test("set records the previous document", () => {
    const first = doc(0);
    const state = undoReducer({ doc: first, history: [], future: [] }, { type: "set", next: doc(1), at: 10 });
    expect(state.doc).toEqual(doc(1));
    expect(state.history).toHaveLength(1);
    expect(state.history[0]?.doc).toBe(first);
  });

  test("an identity set is a no-op by reference", () => {
    const current = doc(0);
    const state: UndoState<typeof current> = { doc: current, history: [], future: [] };
    expect(undoReducer(state, { type: "set", next: current, at: 10 })).toBe(state);
  });

  test("the first edit of an empty form starts no history", () => {
    const state = undoReducer({ doc: null, history: [], future: [] }, { type: "set", next: doc(1), at: 10 });
    expect(state.doc).toEqual(doc(1));
    expect(state.history).toEqual([]);
  });

  test("history is capped, dropping the oldest step", () => {
    let state: UndoState<{ name: string }> = { doc: doc(0), history: [], future: [] };
    for (let step = 1; step <= MAX_HISTORY + 10; step += 1) {
      state = undoReducer(state, { type: "set", next: doc(step), at: step });
    }
    expect(state.history).toHaveLength(MAX_HISTORY);
    // The oldest survivor is the step just before the window, not the document's origin.
    expect(state.history[0]?.doc).toEqual(doc(10));
  });
});

describe("coalescing", () => {
  test("a run of keystrokes inside the window stays one step", () => {
    let state: UndoState<{ name: string }> = { doc: doc(0), history: [], future: [] };
    state = undoReducer(state, { type: "set", next: doc(1), at: 1000, coalesce: true });
    state = undoReducer(state, { type: "set", next: doc(2), at: 1000 + 200, coalesce: true });
    state = undoReducer(state, { type: "set", next: doc(3), at: 1000 + 400, coalesce: true });

    expect(state.doc).toEqual(doc(3));
    expect(state.history).toHaveLength(1);
    // Undo still returns to before the whole run.
    expect(undoReducer(state, { type: "undo" }).doc).toEqual(doc(0));
  });

  test("a pause starts a new step", () => {
    let state: UndoState<{ name: string }> = { doc: doc(0), history: [], future: [] };
    state = undoReducer(state, { type: "set", next: doc(1), at: 1000, coalesce: true });
    state = undoReducer(state, { type: "set", next: doc(2), at: 1000 + COALESCE_MS + 1, coalesce: true });
    expect(state.history).toHaveLength(2);
  });

  test("an edit that is not marked coalescing always starts a new step", () => {
    let state: UndoState<{ name: string }> = { doc: doc(0), history: [], future: [] };
    state = undoReducer(state, { type: "set", next: doc(1), at: 1000 });
    state = undoReducer(state, { type: "set", next: doc(2), at: 1010 });
    expect(state.history).toHaveLength(2);
  });
});

describe("peeking without dispatching", () => {
  test("nothing to undo or redo peeks as null", () => {
    expect(peekUndo(empty)).toBeNull();
    expect(peekRedo(empty)).toBeNull();
  });

  test("peekUndo names the document undo would restore, and does not consume it", () => {
    const applied = undoReducer(empty, { type: "set", next: doc(1), at: 10 });
    expect(peekUndo(applied)).toEqual(doc(0));
    expect((applied.history ?? []).length).toBe(1);
  });

  test("after undo, peekRedo names the document redo would restore", () => {
    const applied = undoReducer(empty, { type: "set", next: doc(1), at: 10 });
    const undone = undoReducer(applied, { type: "undo" });
    expect(peekRedo(undone)).toEqual(doc(1));
    expect(peekUndo(undone)).toBeNull();
  });

  test("a coerced run still peeks the state before the whole run", () => {
    let state = undoReducer(empty, { type: "set", next: doc(1), at: 1000, coalesce: true });
    state = undoReducer(state, { type: "set", next: doc(2), at: 1100, coalesce: true });
    expect(peekUndo(state)).toEqual(doc(0));
  });
});

describe("undo and redo", () => {
  test("undo restores the previous document", () => {
    const applied = undoReducer(empty, { type: "set", next: doc(1), at: 10 });
    expect(undoReducer(applied, { type: "undo" }).doc).toEqual(doc(0));
  });

  test("redo returns to where undo left off", () => {
    const applied = undoReducer(empty, { type: "set", next: doc(1), at: 10 });
    const undone = undoReducer(applied, { type: "undo" });
    expect(undoReducer(undone, { type: "redo" }).doc).toEqual(doc(1));
  });

  test("undo on an empty stack changes nothing", () => {
    expect(undoReducer(empty, { type: "undo" })).toBe(empty);
  });

  test("redo on an empty stack changes nothing", () => {
    expect(undoReducer(empty, { type: "redo" })).toBe(empty);
  });

  test("a fresh edit after undo discards the redo branch", () => {
    const applied = undoReducer(empty, { type: "set", next: doc(1), at: 10 });
    const undone = undoReducer(applied, { type: "undo" });
    const diverged = undoReducer(undone, { type: "set", next: doc(2), at: 20 });
    expect(diverged.future).toEqual([]);
  });

  test("undo and redo both survive repetitive use", () => {
    let state = empty;
    for (let step = 1; step <= 5; step += 1) state = undoReducer(state, { type: "set", next: doc(step), at: step });
    for (let times = 0; times < 5; times += 1) state = undoReducer(state, { type: "undo" });
    expect(state.doc).toEqual(doc(0));
    for (let times = 0; times < 5; times += 1) state = undoReducer(state, { type: "redo" });
    expect(state.doc).toEqual(doc(5));
  });
});
