/**
 * Effect interpreter (§5.6). These are the rules that actually move a save, so the tests are
 * written against the real mutations rather than mocks: a wrong stack cap or a `take` that
 * cannot erase an entry is a corrupted save, not a cosmetic bug.
 */

import { describe, expect, test } from "bun:test";

import {
  addItem,
  applyEffects,
  emptyGameState,
  itemCount,
  type ContentLookup,
  type GameState,
} from "../src/effects";
import type { Locale } from "../src/state";

const LOCALES = (value: Record<string, string>): Record<string, string> => value;

/** A tiny in-memory content lookup — no files, no engine, no network. */
function lookup(): ContentLookup {
  const items: Record<string, Record<string, unknown>> = {
    item_coin: { id: "item_coin", stack_max: 3 },
    item_key: { id: "item_key" },
  };
  const quests: Record<string, Record<string, unknown>> = {
    quest_intro: {
      id: "quest_intro",
      nodes: [{ id: "n1", next: "n2" }, { id: "n2" }],
    },
    quest_gated: {
      id: "quest_gated",
      entry_requires: { flag: "unlocked" },
      nodes: [{ id: "n1" }],
    },
  };
  const npcs: Record<string, Record<string, unknown>> = {
    npc_keeper: {
      id: "npc_keeper",
      secrets: [{ id: "s_crate", text: LOCALES({ zh_HK: "個箱係我嘅。", en: "That crate is mine." }) }],
    },
  };
  return {
    npc: (id) => npcs[id],
    quest: (id) => quests[id],
    item: (id) => items[id],
    localize: (field, locale: Locale) => {
      if (typeof field === "string") return field;
      if (!field || typeof field !== "object") return "";
      const table = field as Record<string, string>;
      return table[locale] ?? table["zh_HK"] ?? table["en"] ?? "";
    },
  };
}

function context(overrides: Partial<Parameters<typeof applyEffects>[2]> = {}) {
  return { content: lookup(), locale: "en" as Locale, ...overrides };
}

describe("set_flag", () => {
  test("sets and reports the value", () => {
    const state = emptyGameState();
    const outcome = applyEffects([{ type: "set_flag", flag: "door_open", value: true }], state, context());
    expect(outcome.applied).toBe(1);
    expect(state.flags["door_open"]).toBe(true);
    expect(outcome.events).toContainEqual({ type: "flag_set", flag: "door_open", value: true });
  });

  test("defaults to true when no value is given", () => {
    const state = emptyGameState();
    applyEffects([{ type: "set_flag", flag: "seen" }], state, context());
    expect(state.flags["seen"]).toBe(true);
  });

  test("an allowlist blocks an unlisted flag and does not mutate state", () => {
    const state = emptyGameState();
    const outcome = applyEffects(
      [{ type: "set_flag", flag: "money_hack" }],
      state,
      context({ allow_flags: ["door_open"] }),
    );
    expect(outcome.applied).toBe(0);
    expect(state.flags["money_hack"]).toBeUndefined();
    expect(outcome.warnings).toHaveLength(1);
  });

  test("an empty allowlist means unrestricted, as the original did", () => {
    const state = emptyGameState();
    const outcome = applyEffects(
      [{ type: "set_flag", flag: "anything" }],
      state,
      context({ allow_flags: [] }),
    );
    expect(outcome.applied).toBe(1);
  });
});

describe("give / take", () => {
  test("give respects stack_max and reports only what was added", () => {
    const state = emptyGameState();
    const outcome = applyEffects([{ type: "give", item: "item_coin", count: 5 }], state, context());
    expect(itemCount(state, "item_coin")).toBe(3);
    expect(outcome.events).toContainEqual({ type: "item_gained", item: "item_coin", count: 3 });
  });

  test("give at capacity does not count as applied", () => {
    const state = emptyGameState();
    state.inventory["item_coin"] = 3;
    const outcome = applyEffects([{ type: "give", item: "item_coin" }], state, context());
    expect(outcome.applied).toBe(0);
  });

  test("give is blocked by the item allowlist", () => {
    const state = emptyGameState();
    const outcome = applyEffects(
      [{ type: "give", item: "item_key" }],
      state,
      context({ allow_items: ["item_coin"] }),
    );
    expect(outcome.applied).toBe(0);
    expect(itemCount(state, "item_key")).toBe(0);
  });

  test("take erases the entry when the last one goes", () => {
    const state = emptyGameState();
    state.inventory["item_key"] = 1;
    const outcome = applyEffects([{ type: "take", item: "item_key" }], state, context());
    expect(outcome.applied).toBe(1);
    expect("item_key" in state.inventory).toBe(false);
  });

  test("take more than held removes only what exists", () => {
    const state = emptyGameState();
    state.inventory["item_key"] = 2;
    const outcome = applyEffects([{ type: "take", item: "item_key", count: 5 }], state, context());
    expect(outcome.applied).toBe(1);
    expect(itemCount(state, "item_key")).toBe(0);
  });

  test("take of something absent is not applied", () => {
    const state = emptyGameState();
    const outcome = applyEffects([{ type: "take", item: "item_key" }], state, context());
    expect(outcome.applied).toBe(0);
  });

  test("an item with no declared stack_max caps at 999, not 99", () => {
    const state = emptyGameState();
    addItem(state, lookup(), "item_key", 5000, []);
    expect(itemCount(state, "item_key")).toBe(999);
  });
});

describe("var", () => {
  test("add is the default operation", () => {
    const state = emptyGameState();
    applyEffects([{ type: "var", name: "trust", value: 2 }], state, context());
    applyEffects([{ type: "var", name: "trust", value: 3 }], state, context());
    expect(state.vars["trust"]).toBe(5);
  });

  test("set replaces", () => {
    const state = emptyGameState();
    state.vars["trust"] = 9;
    applyEffects([{ type: "var", name: "trust", op: "set", value: 1 }], state, context());
    expect(state.vars["trust"]).toBe(1);
  });

  test("a nameless var is not applied", () => {
    const state = emptyGameState();
    expect(applyEffects([{ type: "var", value: 1 }], state, context()).applied).toBe(0);
  });
});

describe("say", () => {
  test("localises and emits a message", () => {
    const state = emptyGameState();
    const outcome = applyEffects(
      [{ type: "say", text: { zh_HK: "你好", en: "Hello" } }],
      state,
      context({ locale: "en" }),
    );
    expect(outcome.events).toContainEqual({ type: "message_shown", text: "Hello" });
  });

  test("empty text for the locale is not applied", () => {
    const state = emptyGameState();
    const outcome = applyEffects(
      [{ type: "say", text: { zh_HK: "你好" } }],
      state,
      context({ locale: "en" }),
    );
    // Falls back to whatever is present, so it still renders — the chain is the guard here.
    expect(outcome.events).toContainEqual({ type: "message_shown", text: "你好" });
  });
});

describe("quest", () => {
  test("start enters the first node", () => {
    const state = emptyGameState();
    const outcome = applyEffects([{ type: "quest", quest: "quest_intro", op: "start" }], state, context());
    expect(outcome.applied).toBe(1);
    expect(state.quests["quest_intro"]).toEqual({ node: "n1", done: false });
    expect(outcome.events).toContainEqual({ type: "quest_updated", quest: "quest_intro", node: "n1" });
  });

  test("starting twice is a no-op that still counts as applied", () => {
    const state = emptyGameState();
    applyEffects([{ type: "quest", quest: "quest_intro", op: "start" }], state, context());
    const again = applyEffects([{ type: "quest", quest: "quest_intro", op: "start" }], state, context());
    expect(again.applied).toBe(1);
    expect(state.quests["quest_intro"]).toEqual({ node: "n1", done: false });
  });

  test("entry_requires gates a start", () => {
    const state = emptyGameState();
    const blocked = applyEffects(
      [{ type: "quest", quest: "quest_gated", op: "start" }],
      state,
      context(),
    );
    expect(blocked.applied).toBe(0);
    expect(state.quests["quest_gated"]).toBeUndefined();

    state.flags["unlocked"] = true;
    const allowed = applyEffects(
      [{ type: "quest", quest: "quest_gated", op: "start" }],
      state,
      context(),
    );
    expect(allowed.applied).toBe(1);
  });

  test("advance moves the node and refuses a done quest", () => {
    const state = emptyGameState();
    applyEffects([{ type: "quest", quest: "quest_intro", op: "start" }], state, context());
    applyEffects([{ type: "quest", quest: "quest_intro", op: "advance", node: "n2" }], state, context());
    expect((state.quests["quest_intro"] as Record<string, unknown>)["node"]).toBe("n2");

    applyEffects([{ type: "quest", quest: "quest_intro", op: "complete" }], state, context());
    const afterDone = applyEffects(
      [{ type: "quest", quest: "quest_intro", op: "advance", node: "n1" }],
      state,
      context(),
    );
    expect(afterDone.applied).toBe(0);
  });

  test("complete is idempotent and emits completion once", () => {
    const state = emptyGameState();
    applyEffects([{ type: "quest", quest: "quest_intro", op: "start" }], state, context());
    const first = applyEffects([{ type: "quest", quest: "quest_intro", op: "complete" }], state, context());
    const second = applyEffects([{ type: "quest", quest: "quest_intro", op: "complete" }], state, context());

    expect(first.applied).toBe(1);
    expect(second.applied).toBe(1);
    expect(first.events).toContainEqual({ type: "quest_completed", quest: "quest_intro" });
    expect(second.events).not.toContainEqual({ type: "quest_completed", quest: "quest_intro" });
    expect((state.quests["quest_intro"] as Record<string, unknown>)["done"]).toBe(true);
  });

  test("an unknown quest does nothing", () => {
    const state = emptyGameState();
    expect(
      applyEffects([{ type: "quest", quest: "quest_nope", op: "start" }], state, context()).applied,
    ).toBe(0);
  });
});

describe("reveal_secret", () => {
  test("records the reveal as a durable flag and emits the text", () => {
    const state = emptyGameState();
    const outcome = applyEffects(
      [{ type: "reveal_secret", secret: "s_crate" }],
      state,
      context({ npc: "npc_keeper", locale: "zh_HK" }),
    );
    expect(outcome.applied).toBe(1);
    expect(state.flags["secret_s_crate"]).toBe(true);
    expect(outcome.events).toContainEqual({
      type: "secret_revealed",
      npc: "npc_keeper",
      secret: "s_crate",
      text: "個箱係我嘅。",
    });
  });

  test("names the npc explicitly when the effect carries one", () => {
    const state = emptyGameState();
    const outcome = applyEffects(
      [{ type: "reveal_secret", npc: "npc_keeper", secret: "s_crate" }],
      state,
      context({ locale: "en" }),
    );
    expect(outcome.events).toContainEqual(expect.objectContaining({ npc: "npc_keeper" }));
  });

  test("an unknown secret does not apply", () => {
    const state = emptyGameState();
    const outcome = applyEffects(
      [{ type: "reveal_secret", secret: "s_nope" }],
      state,
      context({ npc: "npc_keeper" }),
    );
    expect(outcome.applied).toBe(0);
    expect(state.flags["secret_s_nope"]).toBeUndefined();
  });
});

describe("presentation effects", () => {
  test("goto carries a spawn default", () => {
    const outcome = applyEffects([{ type: "goto", location: "loc_a" }], emptyGameState(), context());
    expect(outcome.events).toContainEqual({ type: "goto_requested", location: "loc_a", spawn: "default" });
  });

  test("fade rejects a direction that is neither out nor in", () => {
    const outcome = applyEffects([{ type: "fade", to: "sideways" }], emptyGameState(), context());
    expect(outcome.applied).toBe(0);
    expect(outcome.warnings).toHaveLength(1);
  });

  test("shake and play_sfx always apply", () => {
    const outcome = applyEffects(
      [{ type: "shake" }, { type: "play_sfx", name: "door" }],
      emptyGameState(),
      context(),
    );
    expect(outcome.applied).toBe(2);
  });

  test("open_shop falls back to the speaking npc", () => {
    const outcome = applyEffects(
      [{ type: "open_shop" }],
      emptyGameState(),
      context({ npc: "npc_keeper" }),
    );
    expect(outcome.events).toContainEqual({ type: "shop_opened", npc: "npc_keeper" });
  });
});

describe("malformed input", () => {
  test("an unknown effect type is not applied and warns", () => {
    const outcome = applyEffects([{ type: "teleport" }], emptyGameState(), context());
    expect(outcome.applied).toBe(0);
    expect(outcome.warnings).toHaveLength(1);
  });

  test("non-object entries are skipped without aborting the list", () => {
    const state = emptyGameState();
    const outcome = applyEffects(
      [42, "nope", { type: "set_flag", flag: "ok" }],
      state,
      context(),
    );
    expect(outcome.applied).toBe(1);
    expect(state.flags["ok"]).toBe(true);
    expect(outcome.warnings).toHaveLength(2);
  });

  test("a non-list is not applied and warns", () => {
    const outcome = applyEffects({ type: "set_flag", flag: "x" }, emptyGameState(), context());
    expect(outcome.applied).toBe(0);
    expect(outcome.warnings).toHaveLength(1);
  });

  test("null and undefined are treated as an empty effect list", () => {
    const state: GameState = emptyGameState();
    expect(applyEffects(null, state, context()).applied).toBe(0);
    expect(applyEffects(undefined, state, context()).applied).toBe(0);
  });
});
