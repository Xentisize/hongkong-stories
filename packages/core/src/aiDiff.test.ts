import { describe, expect, test } from "bun:test";

import { describeDiff, diffDocuments } from "./aiDiff";

/**
 * The approval card's diff.
 *
 * The cases that matter are the ones an author would miss from a summary line: a removed key, a
 * changed array, and a value that only differs by an element — all of which must show up, while an
 * unchanged document must not pretend to have changes.
 */

describe("diffDocuments", () => {
  test("nothing changed is nothing to show", () => {
    expect(diffDocuments({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toEqual([]);
  });

  test("added, removed and changed keys are distinguished", () => {
    const diffs = diffDocuments({ keep: 1, gone: "x" }, { keep: 2, fresh: "y" });
    expect(diffs.map((diff) => `${diff.kind}:${diff.field}`)).toEqual([
      "removed:gone",
      "added:fresh",
      "changed:keep",
    ]);
  });

  test("an array is compared as a value, so a reorder is a change", () => {
    const diffs = diffDocuments({ npcs: [{ npc: "a" }] }, { npcs: [{ npc: "b" }] });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.field).toBe("npcs");
  });

  test("a missing document reads as an empty one rather than throwing", () => {
    expect(diffDocuments(undefined, { id: "x" })).toEqual([{ field: "id", kind: "added", after: '"x"' }]);
  });

  test("long values are trimmed for display", () => {
    const diffs = diffDocuments({ tilemap: [] }, { tilemap: Array.from({ length: 200 }, () => "....") });
    expect(diffs[0]?.after?.length).toBeLessThan(140);
  });
});

describe("describeDiff", () => {
  test("each kind gets a mark an author can scan", () => {
    const lines = describeDiff(diffDocuments({ gone: 1, keep: 1 }, { keep: 2, fresh: 3 }));
    expect(lines).toEqual(["− gone: 1", "+ fresh: 3", "~ keep: 1 → 2"]);
  });
});
