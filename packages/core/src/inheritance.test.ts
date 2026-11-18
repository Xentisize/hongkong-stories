import { describe, expect, test } from "bun:test";

import { canonicalJson, mergeDocuments, resolveInheritance } from "./inheritance";
import { packFromEntries, validatePack } from "./validate";

/**
 * Authoring-time inheritance, held to what it has to be able to promise.
 *
 * Every refusal here is a case a pack must not ship with, and every merge rule is one an author has
 * to be able to predict from reading two files side by side. The integration case at the end is the
 * point of the prototype: a resolved family validates as ordinary content, with no rule in the
 * validator knowing that `extends` exists.
 */

const item = (id: string, extra: Record<string, unknown> = {}) => ({
  schema_version: 1,
  id,
  name: { zh_HK: id, zh_CN: id, en: id },
  desc: { zh_HK: id, zh_CN: id, en: id },
  stack_max: 1,
  category: "keepsake",
  usable: false,
  on_use: [],
  on_acquire: [],
  ...extra,
});

const one = (entries: Record<string, Record<string, unknown>>) => {
  const result = resolveInheritance(entries);
  return { result, doc: result.entries[Object.keys(result.entries)[0]!]! };
};

describe("merge rules", () => {
  test("scalars overwrite, unmentioned keys inherit", () => {
    expect(mergeDocuments({ a: 1, b: 2 }, { b: 3 })).toEqual({ a: 1, b: 3 });
  });

  test("objects merge recursively", () => {
    const merged = mergeDocuments(
      { name: { zh_HK: "甲", en: "A" }, desc: { en: "d" } },
      { name: { en: "B" } },
    );
    expect(merged).toEqual({ name: { zh_HK: "甲", en: "B" }, desc: { en: "d" } });
  });

  test("arrays replace rather than concatenate", () => {
    expect(mergeDocuments({ nodes: [{ id: "n1" }, { id: "n2" }] }, { nodes: [{ id: "n1" }] })).toEqual({
      nodes: [{ id: "n1" }],
    });
  });

  test("null deletes an inherited key", () => {
    const merged = mergeDocuments({ lore_ref: "lore/a.md", stack_max: 1 }, { lore_ref: null });
    expect(merged).toEqual({ stack_max: 1 });
    expect("lore_ref" in merged).toBe(false);
  });

  test("the parent's identity and authoring notes are never inherited", () => {
    const merged = mergeDocuments(
      { id: "_base", _comment: "parent note", _todo: ["en"], stack_max: 1 },
      { id: "item_x", _comment: "child note" },
    );
    expect(merged).toEqual({ id: "item_x", _comment: "child note", stack_max: 1 });
  });

  test("a child's _todo does not excuse the parent's fields, it just describes the child", () => {
    const merged = mergeDocuments({ _todo: ["en"] }, { _todo: ["zh_CN"] });
    expect(merged["_todo"]).toEqual(["zh_CN"]);
  });

  test("merging does not alias the parent's nested values", () => {
    const parent = { name: { en: "A" } };
    const merged = mergeDocuments(parent, { stack_max: 2 });
    (merged["name"] as Record<string, string>)["en"] = "changed";
    expect(parent.name.en).toBe("A");
  });
});

describe("resolution", () => {
  test("a document with no parent comes back flat, without `extends`", () => {
    const { doc } = one({ "items/item_a.json": item("item_a", { extends: "" }) });
    expect(doc["extends"]).toBeUndefined();
    expect(doc["id"]).toBe("item_a");
  });

  test("a chain resolves oldest-first", () => {
    const result = resolveInheritance({
      // The leaves deliberately omit `category`/`stack_max`: a field the child states always wins,
      // so a fixture that sets them everywhere would test nothing.
      "items/_base.json": {
        schema_version: 1,
        id: "_base",
        category: "base",
        stack_max: 1,
      },
      "items/_mid.json": { id: "_mid", extends: "_base", category: "mid" },
      "items/item_leaf.json": { id: "item_leaf", extends: "_mid", name: { en: "Leaf" } },
    });

    expect(result.ok).toBe(true);
    expect(result.entries["items/item_leaf.json"]).toEqual({
      schema_version: 1,
      id: "item_leaf",
      name: { en: "Leaf" },
      stack_max: 1, // from _base, two links away
      category: "mid", // the nearest ancestor that said anything wins
    });
  });

  test("templates are resolved into children but never ship themselves", () => {
    const result = resolveInheritance({
      "items/_base.json": item("_base", { stack_max: 5 }),
      "items/item_a.json": item("item_a", { extends: "_base" }),
    });
    expect(Object.keys(result.entries)).toEqual(["items/item_a.json"]);
  });

  test("extends must name a document in the same kind", () => {
    const result = resolveInheritance({
      "npcs/_base.json": { id: "_base" },
      "items/item_a.json": item("item_a", { extends: "npcs/_base" }),
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toContain("cross-kind");
  });
});

describe("refusals", () => {
  test("a missing parent is an error, not a silent flat document", () => {
    const result = resolveInheritance({ "items/item_a.json": item("item_a", { extends: "nope" }) });
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toEqual({
      level: "error",
      path: "items/item_a",
      message: "unknown parent 'nope' in items",
    });
  });

  test("a cycle names the chain", () => {
    const result = resolveInheritance({
      "items/_a.json": item("_a", { extends: "_b" }),
      "items/_b.json": item("_b", { extends: "_a" }),
      "items/item_x.json": item("item_x", { extends: "_a" }),
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("cycle: items/_a → items/_b → items/_a"))).toBe(
      true,
    );
  });

  test("extending yourself is a cycle", () => {
    const result = resolveInheritance({ "items/_a.json": item("_a", { extends: "_a" }) });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toContain("cycle");
  });

  test("chains deeper than the cap are refused rather than truncated", () => {
    const entries: Record<string, Record<string, unknown>> = {};
    for (let index = 0; index < 8; index += 1) {
      entries[`items/_n${index}.json`] = item(`_n${index}`, {
        extends: index === 0 ? "" : `_n${index - 1}`,
      });
    }
    entries["items/item_leaf.json"] = item("item_leaf", { extends: "_n7" });

    const deep = resolveInheritance(entries);
    expect(deep.ok).toBe(false);
    expect(deep.issues.some((issue) => issue.message.includes("longer than 5"))).toBe(true);

    // The same chain is fine when the caller says so — the cap is a policy, not a limitation.
    expect(resolveInheritance(entries, { maxChain: 12 }).ok).toBe(true);
  });

  test("a duplicate id in one kind is ambiguous, so it is refused", () => {
    const result = resolveInheritance({
      "items/item_a.json": item("item_a"),
      "items/item_a_copy.json": item("item_a"),
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toContain("duplicate id 'item_a'");
  });

  test("extends must be a string", () => {
    const result = resolveInheritance({ "items/item_a.json": item("item_a", { extends: 3 }) });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toContain("extends must be a parent id");
  });

  test("a document with no id is refused, because nothing could extend it", () => {
    const result = resolveInheritance({ "items/broken.json": { schema_version: 1 } });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.path).toBe("items/broken");
  });
});

describe("identity and determinism", () => {
  test("the resolved pack is stable across runs and key order", () => {
    const entries = {
      "items/_base.json": { id: "_base", name: { en: "A", zh_HK: "甲" } },
      "items/item_a.json": item("item_a", { extends: "_base" }),
    };
    const first = resolveInheritance(entries);
    const second = resolveInheritance(entries);
    expect(canonicalJson(first.entries)).toBe(canonicalJson(second.entries));
  });

  test("canonicalJson sorts keys but keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1] } })).toBe('{"a":{"d":[3,1]},"b":1}');
    expect(canonicalJson([2, 1])).toBe("[2,1]");
    expect(canonicalJson(undefined)).toBe("null");
  });
});

describe("the resolved pack is ordinary content", () => {
  test("a resolved item family validates with no rule knowing about `extends`", () => {
    const result = resolveInheritance({
      "items/_item_base_keepsake.json": item("_item_base_keepsake", {
        category: "keepsake",
        stack_max: 1,
        lore_ref: "lore/ch02_kln_1955.md",
      }),
      "items/item_tea_tin.json": item("item_tea_tin", { extends: "_item_base_keepsake" }),
      "items/item_tram_ticket.json": item("item_tram_ticket", {
        extends: "_item_base_keepsake",
        stack_max: 3,
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);

    const pack = packFromEntries(result.entries);
    expect(Object.keys(pack.tables["items"] ?? {})).toEqual(["item_tea_tin", "item_tram_ticket"]);
    expect(validatePack(pack).filter((issue) => issue.level === "error")).toEqual([]);

    // The inherited field arrived, and the child's own value won where it spoke.
    expect(pack.tables["items"]?.["item_tram_ticket"]?.["lore_ref"]).toBe("lore/ch02_kln_1955.md");
    expect(pack.tables["items"]?.["item_tram_ticket"]?.["stack_max"]).toBe(3);
  });
});
