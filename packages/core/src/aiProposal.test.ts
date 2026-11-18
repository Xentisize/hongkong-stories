import { describe, expect, test } from "bun:test";

import { describeProposal, parseProposal } from "./aiProposal";

/**
 * The co-pilot's contract.
 *
 * The model is untrusted input. What must hold: a well-formed proposal survives, a malformed change
 * is dropped rather than repaired into something that writes an unknown kind or an empty id, and a
 * proposal with nothing left to apply reads as "nothing to do" instead of an empty approval card.
 */

const valid = {
  plan: ["Pick a street", "Add the tea shop owner"],
  changes: [
    {
      kind: "locations",
      id: "loc_ssp_tea",
      op: "create",
      summary: "a small tea shop street",
      doc: { id: "loc_ssp_tea", tilemap: ["....", "...."] },
    },
  ],
};

describe("parseProposal", () => {
  test("a well-formed proposal survives with its plan and change", () => {
    const proposal = parseProposal(valid);
    expect(proposal?.plan).toHaveLength(2);
    expect(proposal?.changes[0]).toMatchObject({ kind: "locations", id: "loc_ssp_tea", op: "create" });
  });

  test("JSON text is accepted, because that is what models often return", () => {
    expect(parseProposal(JSON.stringify(valid))?.changes[0]?.id).toBe("loc_ssp_tea");
  });

  test("an unparsable string is nothing", () => {
    expect(parseProposal("{not json")).toBeNull();
    expect(parseProposal("[1,2,3]")).toBeNull();
    expect(parseProposal(null)).toBeNull();
    expect(parseProposal(42)).toBeNull();
  });

  test("a change with an unknown kind, a missing id or no document is dropped", () => {
    const proposal = parseProposal({
      plan: ["x"],
      changes: [
        { kind: "dinosaurs", id: "d1", doc: {} },
        { kind: "npcs", id: "", doc: {} },
        { kind: "items", id: "item_a" },
        { kind: "items", id: "item_b", doc: { id: "item_b" } },
      ],
    });
    expect(proposal?.changes).toHaveLength(1);
    expect(proposal?.changes[0]?.id).toBe("item_b");
  });

  test("nothing applicable is nothing, not an empty card", () => {
    expect(parseProposal({ plan: ["only a plan"], changes: [] })).toBeNull();
    expect(parseProposal({ changes: [{ kind: "npcs", id: "x" }] })).toBeNull();
  });

  test("a missing plan still yields a change, with a stated gap", () => {
    const proposal = parseProposal({ changes: [{ kind: "npcs", id: "npc_a", doc: { id: "npc_a" } }] });
    expect(proposal?.changes).toHaveLength(1);
    expect(proposal?.plan[0]).toContain("no steps");
  });
});

describe("describeProposal", () => {
  test("one line per change, so two cannot hide behind one heading", () => {
    const proposal = parseProposal({
      plan: ["x"],
      changes: [
        { kind: "npcs", id: "npc_a", op: "create", summary: "a hawker", doc: {} },
        { kind: "items", id: "item_a", op: "update", doc: {} },
      ],
    });
    expect(describeProposal(proposal!)).toEqual(["＋ npcs/npc_a — a hawker", "✎ items/item_a — update items/item_a"]);
  });
});
