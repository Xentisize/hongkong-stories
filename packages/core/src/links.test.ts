import { describe, expect, test } from "bun:test";

import { LINK_KINDS, declaredLinks, isLinkKind } from "./links";
import { packFromEntries, validatePack } from "./validate";

/**
 * Declared narrative links.
 *
 * The point of the field is that it is *only* narrative: malformed entries are dropped rather than
 * repaired, and a target that does not exist warns — it must never block a publish, because nobody
 * wants "this photo reminds her of her grandmother" to be the reason the game cannot ship.
 */

describe("declaredLinks", () => {
  test("reads the well-formed entries", () => {
    const links = declaredLinks({
      links: [
        { to: "npc_a", kind: "about" },
        { to: "item_b", kind: "foreshadows", note: "the fire" },
      ],
    });
    expect(links).toEqual([
      { to: "npc_a", kind: "about" },
      { to: "item_b", kind: "foreshadows", note: "the fire" },
    ]);
  });

  test("drops anything that cannot mean something", () => {
    const links = declaredLinks({
      links: [{ to: "npc_a" }, { kind: "about" }, { to: "", kind: "about" }, "npc_c", null],
    });
    expect(links).toEqual([]);
  });

  test("no field, or a wrong shape, is no links rather than a throw", () => {
    expect(declaredLinks({})).toEqual([]);
    expect(declaredLinks({ links: "npc_a" })).toEqual([]);
    expect(declaredLinks(undefined)).toEqual([]);
  });
});

describe("isLinkKind", () => {
  test("recognises the vocabulary and nothing else", () => {
    for (const kind of LINK_KINDS) expect(isLinkKind(kind)).toBe(true);
    expect(isLinkKind("vibes")).toBe(false);
    expect(isLinkKind(42)).toBe(false);
  });
});

describe("validation", () => {
  // Only the link rules matter here: an item fixture without a name/icon has other errors, and
  // asserting on the whole list would make this test about the item schema instead.
  const validate = (doc: Record<string, unknown>) =>
    validatePack(packFromEntries({ "items/item_a.json": { id: "item_a", ...doc } })).filter((issue) =>
      issue.path.includes("links"),
    );

  test("a valid link is silent", () => {
    expect(validate({ links: [{ to: "item_a", kind: "related" }] })).toEqual([]);
  });

  test("a dangling target warns instead of blocking", () => {
    const issues = validate({ links: [{ to: "npc_missing", kind: "about" }] });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.level).toBe("warn");
    expect(issues[0]?.message).toContain("not in the pack");
  });

  test("an unknown kind warns, and a bad shape is an error", () => {
    expect(validate({ links: [{ to: "item_a", kind: "vibes" }] })[0]?.message).toContain("unknown link kind");
    expect(validate({ links: "nope" })[0]?.level).toBe("error");
  });
});
