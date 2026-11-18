import { describe, expect, test } from "bun:test";

import type { ConditionState } from "@hkstories/core";

import { heldLabel, inventoryRows, planUse, type ItemDef } from "./inventory";

/**
 * The inventory view.
 *
 * What is asserted here is what a player would see and be able to do — order, counts, the refusal
 * line for an unmet requirement, and what "Use" would actually apply — because those are the parts a
 * DOM layer should not have to decide.
 */

const ITEMS: Record<string, ItemDef> = {
  item_flat_key: {
    id: "item_flat_key",
    name: { zh_HK: "屋企鎖匙", zh_CN: "家里钥匙", en: "Flat key" },
    desc: { en: "A single brass key." },
    category: "key",
    usable: false,
    stack_max: 1,
  },
  item_cassette: {
    id: "item_cassette",
    name: { zh_HK: "錄音帶", zh_CN: "录音带", en: "Cassette tape" },
    desc: { en: "Mother's voice, half erased." },
    category: "keepsake",
    usable: true,
    use_requires: { flag: "radio_working" },
    use_locked: { zh_HK: "仲未有嘢播", zh_CN: "还没有东西可播", en: "Nothing to play it on yet" },
    on_use: [{ type: "set_flag", flag: "tape_played" }],
  },
  item_album: {
    id: "item_album",
    name: { zh_HK: "相簿", zh_CN: "相簿", en: "Photo album" },
    category: "keepsake",
    usable: true,
    on_use: [{ type: "set_flag", flag: "album_opened" }],
  },
};

const state = (overrides: Partial<ConditionState> = {}): ConditionState => ({
  flags: {},
  vars: {},
  inventory: {},
  talk_counts: {},
  quests: {},
  ...overrides,
});

const flags = (...set: string[]) => (condition: unknown): boolean => {
  const flag = (condition as { flag?: string } | null)?.flag ?? "";
  return set.includes(flag);
};

describe("rows", () => {
  test("only carried items appear, with their counts", () => {
    const rows = inventoryRows(
      ITEMS,
      state({ inventory: { item_flat_key: 1, item_album: 2 } }),
      "en",
      flags(),
    );

    expect(rows.map((row) => [row.id, row.count])).toEqual([
      ["item_album", 2],
      ["item_flat_key", 1],
    ]);
  });

  test("ordering is stable: category, then name, then id", () => {
    const rows = inventoryRows(
      ITEMS,
      state({ inventory: { item_cassette: 1, item_flat_key: 1, item_album: 1 } }),
      "en",
      flags(),
    );

    // "keepsake" before "key", and within keepsake "Cassette tape" before "Photo album".
    expect(rows.map((row) => row.id)).toEqual(["item_cassette", "item_album", "item_flat_key"]);
  });

  test("a carried item the pack no longer defines is shown by its id", () => {
    // A save can hold something a later edit deleted; hiding it would make the bag disagree with it.
    const rows = inventoryRows(ITEMS, state({ inventory: { item_ghost: 1 } }), "en", flags());

    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("item_ghost");
    expect(rows[0]!.description).toBe("");
  });

  test("a zero or junk count is not a row", () => {
    const rows = inventoryRows(
      ITEMS,
      state({ inventory: { item_album: 0, item_cassette: "many" as unknown as number } }),
      "en",
      flags(),
    );
    expect(rows).toEqual([]);
  });

  test("the held item is marked, and only that one", () => {
    const rows = inventoryRows(
      ITEMS,
      state({ inventory: { item_flat_key: 1, item_album: 1 }, held_item: "item_flat_key" }),
      "en",
      flags(),
    );

    expect(rows.find((row) => row.id === "item_flat_key")?.held).toBe(true);
    expect(rows.find((row) => row.id === "item_album")?.held).toBe(false);
  });
});

describe("usability", () => {
  test("an item whose requirement passes is usable", () => {
    const rows = inventoryRows(
      ITEMS,
      state({ inventory: { item_cassette: 1 } }),
      "en",
      flags("radio_working"),
    );
    expect(rows[0]!.usable).toBe(true);
    expect(rows[0]!.locked).toBe("");
  });

  test("an unmet requirement explains itself in the content's words", () => {
    const rows = inventoryRows(ITEMS, state({ inventory: { item_cassette: 1 } }), "en", flags());

    expect(rows[0]!.usable).toBe(false);
    expect(rows[0]!.locked).toBe("Nothing to play it on yet");
  });

  test("an item that is not usable at all gets no refusal line", () => {
    // A key has no line because it is not refused — it simply has no use.
    const rows = inventoryRows(ITEMS, state({ inventory: { item_flat_key: 1 } }), "en", flags());
    expect(rows[0]!.usable).toBe(false);
    expect(rows[0]!.locked).toBe("");
  });
});

describe("localization", () => {
  test("names and descriptions follow the locale", () => {
    const cantonese = inventoryRows(ITEMS, state({ inventory: { item_album: 1 } }), "zh_HK", flags());
    expect(cantonese[0]!.name).toBe("相簿");

    const english = inventoryRows(ITEMS, state({ inventory: { item_cassette: 1 } }), "en", flags());
    expect(english[0]!.description).toBe("Mother's voice, half erased.");
  });
});

describe("using an item", () => {
  test("a usable item hands over its effects", () => {
    const plan = planUse(ITEMS, "item_album", "en", flags());
    expect(plan).toEqual({ ok: true, effects: [{ type: "set_flag", flag: "album_opened" }] });
  });

  test("the three refusals do not look alike", () => {
    expect(planUse(ITEMS, "item_ghost", "en", flags())).toEqual({ ok: false, reason: "unknown" });
    expect(planUse(ITEMS, "item_flat_key", "en", flags())).toEqual({ ok: false, reason: "not-usable" });
    expect(planUse(ITEMS, "item_cassette", "en", flags())).toEqual({
      ok: false,
      reason: "locked",
      locked: "Nothing to play it on yet",
    });
  });
});

describe("the held line", () => {
  test("names what is in hand", () => {
    expect(heldLabel(ITEMS, state({ held_item: "item_album" }), "en")).toBe("Photo album");
  });

  test("an undefined item still says what is held", () => {
    expect(heldLabel(ITEMS, state({ held_item: "item_ghost" }), "en")).toBe("item_ghost");
  });

  test("empty hands are an empty line, not a label", () => {
    expect(heldLabel(ITEMS, state(), "en")).toBe("");
    expect(heldLabel(ITEMS, state({ held_item: "" }), "en")).toBe("");
  });
});
