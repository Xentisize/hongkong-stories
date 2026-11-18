import { describe, expect, test } from "bun:test";

import {
  COMPARISONS,
  EFFECT_TYPES,
  appendAt,
  describeEffect,
  effectType,
  fieldSpecs,
  freshEffect,
  freshLeaf,
  groupKey,
  isRule,
  leafFields,
  leafVerb,
  removeAt,
  replaceAt,
  rootMode,
  valueAt,
  withMode,
} from "./rules";

/**
 * The shared rule vocabulary.
 *
 * The tests that matter are the ones about *not losing work*: switching a condition to a group has to
 * carry the leaf across, and an effect type the interpreter does not know yet must stay editable
 * rather than be flattened by the editor.
 */

describe("leafVerb", () => {
  test("reads the verb of a leaf", () => {
    expect(leafVerb({ flag: "door_open" })).toBe("flag");
    expect(leafVerb({ quest_state: "ch01", node: "n2" })).toBe("quest_state");
  });

  test("a group is not a leaf", () => {
    expect(leafVerb({ all: [{ flag: "a" }] })).toBeNull();
    expect(leafVerb({ any: [] })).toBeNull();
    expect(leafVerb({ not: { flag: "a" } })).toBeNull();
  });

  test("an unknown verb is not silently treated as one", () => {
    expect(leafVerb({ something_new: "x" })).toBeNull();
    expect(leafVerb(null)).toBeNull();
  });
});

describe("groupKey / rootMode", () => {
  test("names the structural condition", () => {
    expect(groupKey({ all: [] })).toBe("all");
    expect(groupKey({ not: {} })).toBe("not");
    expect(groupKey({ flag: "a" })).toBeNull();
  });

  test("derives the root mode the selector shows", () => {
    expect(rootMode({})).toBe("empty");
    expect(rootMode({ flag: "a" })).toBe("single");
    expect(rootMode({ any: [{ flag: "a" }] })).toBe("any");
    expect(rootMode({ surprise: 1 })).toBe("empty");
  });
});

describe("withMode", () => {
  test("keeps the leaf when wrapping it in a group", () => {
    expect(withMode({ flag: "door_open" }, "all")).toEqual({ all: [{ flag: "door_open" }] });
    expect(withMode({ flag: "door_open" }, "not")).toEqual({ not: { flag: "door_open" } });
  });

  test("unwrapping a group keeps its first leaf rather than starting blank", () => {
    expect(withMode({ all: [{ has_item: "item_tea_tin", count: 1 }] }, "single")).toEqual({
      has_item: "item_tea_tin",
      count: 1,
    });
  });

  test("empty mode is the always-true condition", () => {
    expect(withMode({ flag: "a" }, "empty")).toEqual({});
  });

  test("each mode produces something the validator knows", () => {
    for (const [mode] of [["empty"], ["single"], ["all"], ["any"], ["not"]] as const) {
      const shaped = withMode({ flag: "a" }, mode);
      const known = isRule(shaped) && (Object.keys(shaped).length === 0 || rootMode(shaped) === mode);
      expect(known).toBe(true);
    }
  });
});

describe("freshLeaf", () => {
  test("carries the parameters its verb reads", () => {
    expect(freshLeaf("has_item")).toEqual({ has_item: "", count: 1 });
    expect(freshLeaf("var")).toEqual({ var: "", op: ">=", value: 0 });
    expect(freshLeaf("quest_state")).toEqual({ quest_state: "", node: "" });
  });

  test("the var comparison is one the evaluator accepts", () => {
    expect(COMPARISONS).toContain((freshLeaf("var")["op"] as string) ?? "");
  });
});

describe("path edits", () => {
  const tree = { all: [{ flag: "a" }, { has_item: "item_tea_tin", count: 1 }] };

  test("replaceAt writes an array element and shares the untouched branches", () => {
    const next = replaceAt(tree, ["all", 1, "count"], 3);
    expect(valueAt(next, ["all", 1, "count"])).toBe(3);
    const untouched = valueAt(next, ["all", 0]);
    expect(untouched).toBe(tree.all[0]); // identity, not a copy
    expect(tree.all[1]!.count).toBe(1); // the source is untouched
  });

  test("replaceAt replaces a whole list", () => {
    const next = replaceAt(tree, ["all"], [{ not: { flag: "b" } }]);
    expect(valueAt(next, ["all", 0, "not", "flag"])).toBe("b");
  });

  test("removeAt drops one array entry", () => {
    const next = removeAt(tree, ["all", 0]);
    expect((next.all as unknown[]).length).toBe(1);
    expect(valueAt(next, ["all", 0, "has_item"])).toBe("item_tea_tin");
  });

  test("removeAt deletes a key", () => {
    expect(removeAt({ var: "x", op: ">=", value: 1 }, ["op"])).toEqual({ var: "x", value: 1 });
  });

  test("removeAt reaches into a nested group", () => {
    const nested = { all: [{ any: [{ flag: "a" }, { flag: "b" }] }] };
    const next = removeAt(nested, ["all", 0, "any", 0]);
    expect(valueAt(next, ["all", 0, "any"])).toEqual([{ flag: "b" }]);
  });

  test("appendAt grows the list in place of the old one", () => {
    const next = appendAt({ any: [{ flag: "a" }] }, ["any"], { flag: "b" });
    expect(valueAt(next, ["any", 1])).toEqual({ flag: "b" });
  });

  test("appendAt on a missing list creates it", () => {
    expect(appendAt({}, ["all"], { flag: "a" })).toEqual({ all: [{ flag: "a" }] });
  });

  test("a path through the wrong shape reads as undefined, never throws", () => {
    expect(valueAt(tree, ["all", 0, "flag", 9])).toBeUndefined();
    expect(valueAt(tree, ["nope"])).toBeUndefined();
  });
});

describe("leafFields", () => {
  test("names the parameters each verb runs on", () => {
    expect(leafFields("has_item").map((field) => field.key)).toEqual(["has_item", "count"]);
    expect(leafFields("quest_state").map((field) => field.key)).toEqual(["quest_state", "node"]);
  });

  test("the time-of-day options are the values the evaluator knows", () => {
    expect(leafFields("time_of_day")[0]?.options).toEqual(["day", "dusk", "night"]);
  });

  test("an unknown verb has no rows, so the editor must offer raw JSON", () => {
    expect(leafFields("something_new")).toEqual([]);
  });
});

describe("effects", () => {  test("exposes the interpreter's types", () => {
    expect(EFFECT_TYPES).toContain("give");
    expect(EFFECT_TYPES).toContain("goto");
    expect(EFFECT_TYPES).toContain("fade");
  });

  test("fresh effects use the interpreter's absent-field defaults", () => {
    expect(freshEffect("give")).toEqual({ type: "give", item: "", count: 1 });
    expect(freshEffect("fade")).toEqual({ type: "fade", to: "out", time: 0.4 });
    expect(freshEffect("say")).toEqual({ type: "say", text: {} });
  });

  test("a type the interpreter does not know yet keeps its own fields", () => {
    const unknown = { type: "teleport", to: "loc_a" };
    expect(effectType(unknown)).toBe("teleport");
    expect(fieldSpecs(effectType(unknown))).toEqual([]);
    // And the editor is told it cannot render rows, so it must fall back to raw JSON.
    expect(describeEffect(unknown)).toBe("teleport");
  });

  test("describes an effect by its primary parameter", () => {
    expect(describeEffect({ type: "set_flag", flag: "ch01_met_tai" })).toBe("set_flag · ch01_met_tai");
    expect(describeEffect({ type: "say", text: { zh_HK: "木箱入面有嘢。", en: "Something." } })).toBe(
      "say · 木箱入面有嘢。",
    );
    expect(describeEffect(null)).toContain("無效");
  });
});
