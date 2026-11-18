/**
 * Action allowlist (§5.1, §7.3).
 *
 * These mirror `server/tests/test_actions.py` case for case, and they load the SAME real NPC
 * (`npc_p2_shopkeeper`) rather than a synthetic one — an allowlist test that does not read the
 * authored content would pass while the pack shipped a broken permission.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { MAX_ACTIONS_PER_TURN, validateActions, type NpcLike } from "../src/actions";

const NPC_PATH = new URL(
  "../../../client/content/npcs/npc_p2_shopkeeper.json",
  import.meta.url,
);
const npc = JSON.parse(readFileSync(NPC_PATH, "utf8")) as NpcLike;

/** Same state the Python suite uses: two keys held, trust at zero. */
const STATE = {
  inventory: { item_rusty_key: 2, item_other: 1 },
  vars: { trust_keeper: 0 },
};

describe("the fixture really is the authored allowlist", () => {
  test("shopkeeper may give one item, set one flag, move one bounded var", () => {
    const llm = npc.llm as Record<string, unknown>;
    expect(llm["actions_allowed"]).toEqual(["give", "set_flag", "var", "reveal_secret"]);
    expect(llm["items_may_give"]).toEqual(["item_rusty_key"]);
    expect(llm["flags_may_set"]).toEqual(["keeper_helped_player"]);
  });
});

describe("give", () => {
  test("a permitted give is accepted and forced to exactly one", () => {
    const verdict = validateActions([{ type: "give", item: "item_rusty_key", count: 7 }], npc, STATE);
    expect(verdict.rejected).toEqual([]);
    expect(verdict.accepted).toHaveLength(1);
    expect(verdict.accepted[0]!["item"]).toBe("item_rusty_key");
    // The model may not hand out quantities; give is always exactly one.
    expect(verdict.accepted[0]!["count"]).toBe(1);
  });

  test("an unlisted item is rejected", () => {
    const verdict = validateActions([{ type: "give", item: "item_treasure" }], npc, STATE);
    expect(verdict.accepted).toEqual([]);
    expect(verdict.rejected[0]!.reason).toBe("item_not_allowed");
  });
});

describe("set_flag", () => {
  test("a permitted flag is accepted", () => {
    const verdict = validateActions([{ type: "set_flag", flag: "keeper_helped_player" }], npc, STATE);
    expect(verdict.rejected).toEqual([]);
    expect(verdict.accepted).toHaveLength(1);
  });

  test("an unlisted flag is rejected", () => {
    const verdict = validateActions([{ type: "set_flag", flag: "door_open" }], npc, STATE);
    expect(verdict.accepted).toEqual([]);
    expect(verdict.rejected[0]!.reason).toBe("flag_not_allowed");
  });
});

describe("var", () => {
  test("a delta inside the declared bounds is accepted", () => {
    // trust_keeper is declared -1..2 and currently 0.
    const verdict = validateActions([{ type: "var", name: "trust_keeper", value: 2 }], npc, STATE);
    expect(verdict.rejected).toEqual([]);
    expect(verdict.accepted[0]!["value"]).toBe(2);
  });

  test("a delta that leaves the bounds is rejected", () => {
    const verdict = validateActions([{ type: "var", name: "trust_keeper", value: 5 }], npc, STATE);
    expect(verdict.accepted).toEqual([]);
    expect(verdict.rejected[0]!.reason).toBe("var_out_of_bounds");
  });

  test("an undeclared variable is rejected", () => {
    const verdict = validateActions([{ type: "var", name: "money", value: 100 }], npc, STATE);
    expect(verdict.accepted).toEqual([]);
    expect(verdict.rejected[0]!.reason).toBe("var_not_allowed");
  });
});

describe("type gating", () => {
  test("an action type the NPC does not declare is rejected", () => {
    const verdict = validateActions([{ type: "open_shop" }], npc, STATE);
    expect(verdict.accepted).toEqual([]);
    expect(verdict.rejected[0]!.reason).toBe("type_not_allowed");
  });

  test("take is rejected because this NPC never declares it", () => {
    const verdict = validateActions([{ type: "take", item: "item_rusty_key" }], npc, {
      inventory: {},
      vars: {},
    });
    expect(verdict.accepted).toEqual([]);
    expect(verdict.rejected[0]!.reason).toBe("type_not_allowed");
  });
});

describe("reveal_secret", () => {
  test("an unknown secret is rejected", () => {
    const verdict = validateActions([{ type: "reveal_secret", secret: "s_nope" }], npc, STATE);
    expect(verdict.accepted).toEqual([]);
    expect(verdict.rejected[0]!.reason).toBe("unknown_secret");
  });

  test("a declared secret is accepted", () => {
    const verdict = validateActions([{ type: "reveal_secret", secret: "s_crate" }], npc, STATE);
    expect(verdict.rejected).toEqual([]);
    expect(verdict.accepted).toHaveLength(1);
  });
});

describe("the per-turn cap", () => {
  test(`only ${MAX_ACTIONS_PER_TURN} actions survive, and the rest say why`, () => {
    const many = Array.from({ length: MAX_ACTIONS_PER_TURN + 2 }, () => ({
      type: "set_flag",
      flag: "keeper_helped_player",
    }));
    const verdict = validateActions(many, npc, STATE);
    expect(verdict.accepted).toHaveLength(MAX_ACTIONS_PER_TURN);
    expect(verdict.rejected.some((r) => r.reason === "too_many_actions")).toBe(true);
  });

  test("the cap is checked before the action is inspected", () => {
    // The third entry is garbage, but the cap is what rejects it — that is the original order.
    const verdict = validateActions(
      [
        { type: "set_flag", flag: "keeper_helped_player" },
        { type: "set_flag", flag: "keeper_helped_player" },
        "not an object",
      ],
      npc,
      STATE,
    );
    expect(verdict.rejected[0]!.reason).toBe("too_many_actions");
  });
});

describe("garbage input", () => {
  test("null yields no verdict at all", () => {
    expect(validateActions(null, npc, STATE)).toEqual({ accepted: [], rejected: [] });
  });

  test("non-objects are rejected individually", () => {
    const verdict = validateActions(["not an object", 42], npc, STATE);
    expect(verdict.accepted).toEqual([]);
    expect(verdict.rejected.map((r) => r.reason)).toEqual(["not_an_object", "not_an_object"]);
  });

  test("a missing state does not throw", () => {
    expect(() => validateActions([{ type: "var", name: "trust_keeper", value: 1 }], npc)).not.toThrow();
  });
});

describe("items_may_take defaulting", () => {
  test("an NPC with no items_may_take inherits items_may_give", () => {
    const generous: NpcLike = {
      llm: {
        actions_allowed: ["take"],
        items_may_give: ["item_rusty_key"],
      },
    };
    const allowed = validateActions([{ type: "take", item: "item_rusty_key" }], generous, {
      inventory: { item_rusty_key: 1 },
    });
    expect(allowed.accepted).toHaveLength(1);

    const denied = validateActions([{ type: "take", item: "item_treasure" }], generous, {
      inventory: { item_treasure: 1 },
    });
    expect(denied.rejected[0]!.reason).toBe("item_not_allowed");
  });

  test("an explicit empty items_may_take really does forbid taking", () => {
    const stingy: NpcLike = {
      llm: {
        actions_allowed: ["take"],
        items_may_give: ["item_rusty_key"],
        items_may_take: [],
      },
    };
    const verdict = validateActions([{ type: "take", item: "item_rusty_key" }], stingy, {
      inventory: { item_rusty_key: 1 },
    });
    expect(verdict.rejected[0]!.reason).toBe("item_not_allowed");
  });

  test("taking something not held is rejected", () => {
    const generous: NpcLike = {
      llm: { actions_allowed: ["take"], items_may_take: ["item_rusty_key"] },
    };
    const verdict = validateActions([{ type: "take", item: "item_rusty_key" }], generous, {
      inventory: {},
    });
    expect(verdict.rejected[0]!.reason).toBe("not_held");
  });
});
