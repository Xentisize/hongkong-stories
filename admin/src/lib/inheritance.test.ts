import { describe, expect, test } from "bun:test";

import { inheritancePreview, parentCandidates, resolvedDocument } from "./inheritance";

/**
 * The inheritance UI's two questions.
 *
 * `parentCandidates` decides what the picker offers, and `inheritancePreview` explains the result in
 * the same four terms the resolver uses. The preview deliberately reads differently from the merge
 * only in *presentation* — it answers "who said this", never "what value won", because a second
 * merge implementation is how a preview starts lying about what ships.
 */

describe("parentCandidates", () => {
  test("offers same-kind ids, never the document itself", () => {
    expect(parentCandidates(["item_a", "item_b"], "item_a")).toEqual(["item_b"]);
  });

  test("templates lead, the rest are alphabetical", () => {
    expect(parentCandidates(["item_z", "_item_base", "item_a", "_item_extra"], "item_self")).toEqual([
      "_item_base",
      "_item_extra",
      "item_a",
      "item_z",
    ]);
  });

  test("a document with no id yet sees every candidate", () => {
    expect(parentCandidates(["item_a"], null)).toEqual(["item_a"]);
    expect(parentCandidates(["item_a"], undefined)).toEqual(["item_a"]);
  });
});

describe("inheritancePreview", () => {
  const parent = {
    id: "_base",
    _comment: "notes are not inherited",
    name: { zh_HK: "甲" },
    stack_max: 1,
    lore_ref: "lore/a.md",
    on_use: [],
  };

  test("names what only the parent says", () => {
    expect(inheritancePreview(parent, { id: "item_a" })).toEqual([
      { key: "lore_ref", state: "inherited" },
      { key: "name", state: "inherited" },
      { key: "on_use", state: "inherited" },
      { key: "stack_max", state: "inherited" },
    ]);
  });

  test("names what the child overrides, including arrays (which replace rather than merge)", () => {
    const preview = inheritancePreview(parent, { id: "item_a", stack_max: 5, on_use: [{ type: "say" }] });
    expect(preview.filter((entry) => entry.state === "overridden").map((entry) => entry.key)).toEqual([
      "on_use",
      "stack_max",
    ]);
  });

  test("null means the child removed an inherited key", () => {
    expect(inheritancePreview(parent, { id: "item_a", lore_ref: null })).toContainEqual({
      key: "lore_ref",
      state: "removed",
    });
  });

  test("child-only keys are its own", () => {
    expect(inheritancePreview(parent, { id: "item_a", icon: "art/x.png" })).toContainEqual({
      key: "icon",
      state: "own",
    });
  });

  test("identity and authoring notes never appear", () => {
    const preview = inheritancePreview(parent, { id: "item_a", extends: "_base", _comment: "mine" });
    const keys = preview.map((entry) => entry.key);
    expect(keys).not.toContain("id");
    expect(keys).not.toContain("extends");
    expect(keys).not.toContain("_comment");
  });

  test("nonsense in either side reads as nothing to say", () => {
    expect(inheritancePreview(null, { id: "item_a" })).toEqual([]);
    expect(inheritancePreview(parent, "oops")).toEqual([]);
  });
});

describe("resolvedDocument", () => {
  test("is the merge publish performs, so the preview and the result cannot disagree", () => {
    const resolved = resolvedDocument(
      { id: "_base", stack_max: 1, name: { zh_HK: "甲", en: "A" } },
      { id: "item_a", extends: "_base", stack_max: 5 },
    );
    expect(resolved).toEqual({ id: "item_a", stack_max: 5, name: { zh_HK: "甲", en: "A" } });
  });

  test("nonsense resolves to nothing rather than a half-document", () => {
    expect(resolvedDocument(null, {})).toBeNull();
  });
});
