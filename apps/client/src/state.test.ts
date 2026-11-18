import { describe, expect, test } from "bun:test";

import { emptySave } from "./save";
import {
  DEFAULT_STACK_MAX,
  GameState,
  SAVE_STORAGE_KEY,
  persist,
  restore,
  type StorageLike,
} from "./state";

/**
 * The bookkeeping rules a save depends on.
 *
 * Each case mirrors a decision in `game.gd` — the stack ceiling, erasing an item key at zero, a held
 * item that is not held — because the Godot client and this one read the same save codes and must
 * agree about what those codes mean.
 */

function fakeStore(seed: Record<string, string> = {}): StorageLike {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

describe("flags and vars", () => {
  test("a flag is a boolean, and an unset one is false", () => {
    const state = new GameState();
    expect(state.flag("door_open")).toBe(false);
    state.setFlag("door_open", true);
    expect(state.flag("door_open")).toBe(true);
    expect(state.conditionState().flags).toEqual({ door_open: true });
  });

  test("vars accumulate and fall back when the value is junk", () => {
    const state = new GameState();
    expect(state.variable("trust")).toBe(0);
    state.setVar("trust", 2);
    state.addVar("trust", 1.5);
    expect(state.variable("trust")).toBe(3.5);

    state.setVar("broken", Number.NaN);
    expect(state.variable("broken", 7)).toBe(7);
  });
});

describe("inventory", () => {
  test("adds up to the stack ceiling and reports what landed", () => {
    const state = new GameState(emptySave(), { stackMax: () => 3 });
    expect(state.addItem("item_key", 2)).toBe(2);
    expect(state.addItem("item_key", 5)).toBe(1); // only one more fits
    expect(state.addItem("item_key", 1)).toBe(0); // full
    expect(state.count("item_key")).toBe(3);
  });

  test("an undefined stack_max falls back to 999, not 99", () => {
    // `_max_stack` returns 999 when a definition says nothing; a 99 here would silently cap.
    const state = new GameState();
    expect(state.stackMax("item_unknown")).toBe(DEFAULT_STACK_MAX);
    expect(state.addItem("item_unknown", 500)).toBe(500);
  });

  test("removing the last one erases the key instead of leaving a zero", () => {
    const state = new GameState();
    state.addItem("item_key", 2);
    expect(state.removeItem("item_key", 1)).toBe(1);
    expect(state.count("item_key")).toBe(1);
    expect(state.removeItem("item_key", 5)).toBe(1);
    expect("item_key" in state.save.inventory).toBe(false);
  });

  test("holding something requires having it", () => {
    const state = new GameState();
    state.setHeld("item_key");
    expect(state.save.held_item).toBe("");

    state.addItem("item_key");
    state.setHeld("item_key");
    expect(state.save.held_item).toBe("item_key");

    // Spending the last one empties the hands.
    state.removeItem("item_key");
    expect(state.save.held_item).toBe("");
  });

  test("a zero count never counts as held", () => {
    const state = new GameState({ ...emptySave(), inventory: { item_key: 0 }, held_item: "item_key" });
    // Settled on construction, the same way from_dict settles it.
    expect(state.save.held_item).toBe("");
    expect(state.hasItem("item_key")).toBe(false);
  });
});

describe("conversation and place bookkeeping", () => {
  test("every completed turn bumps the talk count", () => {
    const state = new GameState();
    expect(state.talkCount("npc_ken")).toBe(0);
    expect(state.bumpTalk("npc_ken")).toBe(1);
    expect(state.bumpTalk("npc_ken")).toBe(2);
    expect(state.conditionState().talk_counts).toEqual({ npc_ken: 2 });
  });

  test("visiting a place is idempotent, and an empty id is ignored", () => {
    const state = new GameState();
    state.markVisited("loc_a");
    state.markVisited("loc_a");
    state.markVisited("");
    expect(state.save.visited).toEqual({ loc_a: true });
  });

  test("a quest record is replaced wholesale", () => {
    const state = new GameState();
    state.setQuest("ch01", { node: "n3", done: false });
    expect(state.save.quests["ch01"]).toEqual({ node: "n3", done: false });
  });
});

describe("notifications", () => {
  test("mutations notify, reads do not", () => {
    let calls = 0;
    const state = new GameState(emptySave(), { onChange: () => void (calls += 1) });

    state.flag("x");
    state.count("y");
    expect(calls).toBe(0);

    state.setFlag("x", true);
    state.addItem("y");
    expect(calls).toBe(2);
  });
});

describe("the slot", () => {
  test("round-trips the payload", () => {
    const store = fakeStore();
    const state = new GameState();
    state.setFlag("met_ken", true);
    state.addItem("item_key");

    persist(state.save, store);
    const restored = restore(store);

    expect(restored).not.toBeNull();
    expect(restored?.flags["met_ken"]).toBe(true);
    expect(restored?.inventory["item_key"]).toBe(1);
    expect(store.getItem(SAVE_STORAGE_KEY)).toBeString();
  });

  test("an absent or unreadable slot restores nothing rather than throwing", () => {
    expect(restore(fakeStore())).toBeNull();
    expect(restore(fakeStore({ [SAVE_STORAGE_KEY]: "{not json" }))).toBeNull();
    expect(restore(fakeStore({ [SAVE_STORAGE_KEY]: "[1,2]" }))).toBeNull();
  });

  test("a partial slot is defaulted, not trusted", () => {
    const store = fakeStore({ [SAVE_STORAGE_KEY]: JSON.stringify({ flags: { met_ken: true } }) });
    const restored = restore(store);

    expect(restored?.flags).toEqual({ met_ken: true });
    expect(restored?.inventory).toEqual({});
    expect(restored?.player_position).toEqual([0, 0]);
    expect(restored?.schema_version).toBe(1);
  });

  test("a store that refuses writes does not break the session", () => {
    const hostile: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => undefined,
    };
    expect(() => persist(emptySave(), hostile)).not.toThrow();
  });
});
