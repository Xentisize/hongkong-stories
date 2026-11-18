import { describe, expect, test } from "bun:test";

import { packFromEntries, resolveInheritance, type ContentEntity } from "@hkstories/core";

import { overlayDrafts } from "./admin";

/**
 * The draft overlay that feeds the publish gate.
 *
 * Two things are being pinned down. A draft replaces the baseline document it shares a kind and id
 * with — that is what "the pack as it would ship" means. And the overlay happens *before* `extends`
 * is resolved, so a draft can extend a baseline template (or a template can be extended by a
 * draft); resolving after the collapse into tables would be too late.
 */

const item = (id: string, extra: Record<string, unknown> = {}): ContentEntity => ({
  schema_version: 1,
  id,
  name: { zh_HK: id, zh_CN: id, en: id },
  stack_max: 1,
  category: "keepsake",
  usable: false,
  on_use: [],
  ...extra,
});

describe("overlayDrafts", () => {
  test("a draft replaces the baseline document at the same kind and id", () => {
    const entries = { "items/item_a.json": item("item_a", { stack_max: 1 }) };
    const merged = overlayDrafts(entries, [
      { kind: "items", entity: item("item_a", { stack_max: 9 }) },
    ]);

    expect(Object.keys(merged)).toEqual(["items/item_a.json"]);
    expect(merged["items/item_a.json"]?.["stack_max"]).toBe(9);
    expect(entries["items/item_a.json"]?.["stack_max"]).toBe(1); // the source is untouched
  });

  test("a draft with a new id adds a path beside the baseline", () => {
    const entries = { "items/item_a.json": item("item_a") };
    const merged = overlayDrafts(entries, [{ kind: "items", entity: item("item_new") }]);
    expect(Object.keys(merged).sort()).toEqual(["items/item_a.json", "items/item_new.json"]);
  });

  test("a draft that is not an object, or has no id, is left to the validator", () => {
    const entries = { "items/item_a.json": item("item_a") };
    expect(overlayDrafts(entries, [{ kind: "items", entity: "oops" }])).toEqual(entries);
    expect(overlayDrafts(entries, [{ kind: "items", entity: { stack_max: 2 } }])).toEqual(entries);
  });
});

describe("drafts and inheritance together", () => {
  test("a draft may extend a baseline template, and lands flat in the shipped tables", () => {
    const entries = {
      "items/_base_keepsake.json": item("_base_keepsake", { lore_ref: "lore/ch02_kln_1955.md" }),
    };
    const merged = overlayDrafts(entries, [
      { kind: "items", entity: item("item_tea_tin", { extends: "_base_keepsake" }) },
    ]);

    const resolved = resolveInheritance(merged);
    expect(resolved.ok).toBe(true);

    const pack = packFromEntries(resolved.entries);
    // The template does not ship; the draft does, and it carries the inherited field.
    expect(Object.keys(pack.tables["items"] ?? {})).toEqual(["item_tea_tin"]);
    expect(pack.tables["items"]?.["item_tea_tin"]?.["lore_ref"]).toBe("lore/ch02_kln_1955.md");
  });

  test("a draft whose parent is missing is refused rather than shipped half-formed", () => {
    const merged = overlayDrafts({}, [
      { kind: "items", entity: item("item_tea_tin", { extends: "nope" }) },
    ]);

    const resolved = resolveInheritance(merged);
    expect(resolved.ok).toBe(false);
    expect(resolved.issues[0]).toEqual({
      level: "error",
      path: "items/item_tea_tin",
      message: "unknown parent 'nope' in items",
    });
  });
});
