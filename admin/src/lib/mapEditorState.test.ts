import { describe, expect, test } from "bun:test";

import { MAX_HISTORY, normalise, reducer, type LocationDoc, type MapState } from "./mapEditorState";

/**
 * Editor state and undo.
 *
 * The invariant that keeps undo honest: a gesture that changed nothing must not record history.
 * `paintTile`/`moveNpc` return the same array by identity in that case, so `apply` has to treat
 * identity as a no-op — otherwise dragging across already-painted tiles would push a snapshot per
 * pointer event and the actual edit would be unrecoverable.
 */

const doc = (tilemap: string[], extra: Partial<LocationDoc> = {}): LocationDoc => ({
  id: "loc_test",
  tilemap,
  legend: { ".": [0, 0], "#": [2, 0] },
  tile_size: 24,
  npcs: [],
  ...extra,
});

const empty: MapState = { doc: null, history: [] };

describe("reducer", () => {
  test("load sets the document and clears the stack", () => {
    const state = reducer({ doc: doc(["#"]), history: [doc(["."])] }, { type: "load", doc: doc([".."]) });
    expect(state.doc?.tilemap).toEqual([".."]);
    expect(state.history).toEqual([]);
  });

  test("apply records the previous document", () => {
    const first = doc(["##"]);
    const state = reducer({ doc: first, history: [] }, { type: "apply", next: doc(["#."]) });
    expect(state.doc?.tilemap).toEqual(["#."]);
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toBe(first);
  });

  test("an identity apply is a no-op by reference", () => {
    const current = doc(["##"]);
    const state: MapState = { doc: current, history: [] };
    expect(reducer(state, { type: "apply", next: current })).toBe(state);
  });

  test("apply without a document does nothing", () => {
    expect(reducer(empty, { type: "apply", next: doc(["#"]) })).toBe(empty);
  });

  test("undo restores the previous document and pops the stack", () => {
    const original = doc(["##"]);
    const applied = reducer({ doc: original, history: [] }, { type: "apply", next: doc(["#."]) });
    const undone = reducer(applied, { type: "undo" });
    expect(undone.doc).toBe(original);
    expect(undone.history).toEqual([]);
  });

  test("undo on an empty stack changes nothing", () => {
    const state: MapState = { doc: doc(["#"]), history: [] };
    expect(reducer(state, { type: "undo" })).toBe(state);
  });

  test("history is bounded so a long session cannot grow it without limit", () => {
    let state: MapState = { doc: doc(["."]), history: [] };
    for (let step = 0; step < MAX_HISTORY + 20; step += 1) {
      state = reducer(state, { type: "apply", next: doc([".".repeat(2 + step)]) });
    }
    expect(state.history).toHaveLength(MAX_HISTORY);
    // The newest document is still what is open, and the oldest steps were dropped from the tail.
    expect(state.doc?.tilemap?.[0]).toHaveLength(2 + MAX_HISTORY + 19);
  });

  test("clear drops the document", () => {
    expect(reducer({ doc: doc(["#"]), history: [doc(["."])] }, { type: "clear" }).doc).toBeNull();
  });
});

describe("normalise", () => {
  test("keeps a well-formed document intact", () => {
    const source = doc(["##", "#."], { npcs: [{ npc: "npc_a", tile: [1, 1] }] });
    const next = normalise(source);
    expect(next.tilemap).toEqual(["##", "#."]);
    expect(next.npcs).toHaveLength(1);
    // Everything else survives the round trip — the editor must not drop fields it does not edit.
    expect(next.legend).toEqual(source.legend);
    expect(next.tile_size).toBe(24);
  });

  test("a missing or non-array tilemap becomes empty rather than throwing", () => {
    expect(normalise({}).tilemap).toEqual([]);
    expect(normalise({ tilemap: "##" }).tilemap).toEqual([]);
  });

  test("placements without a tile are dropped", () => {
    const next = normalise({
      npcs: [{ npc: "npc_a", tile: [1, 1] }, { npc: "npc_b" }, null, { npc: "npc_c", tile: "1,1" }],
    });
    expect(next.npcs).toHaveLength(1);
    expect(next.npcs?.[0]?.npc).toBe("npc_a");
  });

  test("a null document still yields a usable skeleton", () => {
    const next = normalise(null);
    expect(next.tilemap).toEqual([]);
    expect(next.npcs).toEqual([]);
  });
});
