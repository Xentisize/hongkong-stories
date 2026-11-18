import { describe, expect, test } from "bun:test";

import { connectionsFor, flagsIn, gapsFor, labelFor, refKind, summarise, tableLabel } from "./connections";

/**
 * The connection graph.
 *
 * The claims worth pinning: an item knows who gives it, what needs it and which door it opens — all
 * derived from the fields that already carry those references — a document is never its own
 * connection, and a reference in a position we have not classified still shows up rather than
 * vanishing from the picture.
 */

const pack = {
  items: {
    item_flat_key: {
      id: "item_flat_key",
      name: { zh_HK: "鎖匙" },
      on_use: [{ type: "set_flag", flag: "door_open" }],
      use_requires: { flag: "shan_told_story" },
      lore_ref: "lore/flat.md",
    },
    item_photo_album: { id: "item_photo_album", on_acquire: [] },
  },
  npcs: {
    npc_ch01_tai: {
      id: "npc_ch01_tai",
      states: [{ when: { talked: "npc_ch01_tai", min: 1 }, effects: [{ type: "add_item", item: "item_flat_key" }] }],
    },
  },
  quests: {
    ch01: {
      id: "ch01",
      nodes: [
        { id: "n1", complete_when: { talked: "npc_ch01_tai", min: 1 } },
        { id: "n2", complete_when: { has_item: "item_flat_key" } },
      ],
    },
  },
  locations: {
    loc_ssp_market_street: {
      id: "loc_ssp_market_street",
      npcs: [{ npc: "npc_ch01_tai", tile: [3, 4] }],
      exits: [
        { id: "to_flat", to: "loc_ssp_flat", requires: { has_item: "item_flat_key" } },
      ],
    },
    loc_ssp_flat: { id: "loc_ssp_flat" },
  },
} as const;

describe("refKind", () => {
  test("follows the pack's own id conventions", () => {
    expect(refKind("item_a")).toBe("item");
    expect(refKind("npc_a")).toBe("npc");
    expect(refKind("loc_a")).toBe("location");
    expect(refKind("ch01")).toBe("chapter");
    expect(refKind("something_else")).toBe("unknown");
  });
});

describe("labelFor", () => {
  test("the relationship comes from the field that holds the reference", () => {
    expect(labelFor("nodes.1.complete_when.has_item")).toContain("需要持有");
    expect(labelFor("states.0.effects.0.add_item")).toContain("給予");
    expect(labelFor("npcs.0.npc")).toContain("出場");
  });

  test("a field we have not classified keeps its own name rather than a made-up one", () => {
    expect(labelFor("some.deep.field")).toBe("field");
    // An index is a position, not a relationship: `effects.0` is about `effects`.
    expect(labelFor("states.0.effects.0")).toBe("effects");
  });
});

describe("connectionsFor", () => {
  test("an item knows who gives it, what needs it, and which door it opens", () => {
    const connections = connectionsFor(pack as never, "items", "item_flat_key");
    const labels = connections.inbound.map((ref) => `${ref.id}:${ref.label}`);

    expect(labels.some((line) => line.startsWith("npc_ch01_tai:") && line.includes("角色"))).toBe(true);
    expect(labels.some((line) => line.startsWith("ch01:") && line.includes("需要持有"))).toBe(true);
    expect(labels.some((line) => line.startsWith("loc_ssp_market_street:") && line.includes("需要持有"))).toBe(true);
  });

  test("an NPC knows where it stands and which steps it completes", () => {
    const connections = connectionsFor(pack as never, "npcs", "npc_ch01_tai");
    const inboundIds = connections.inbound.map((ref) => ref.id);
    expect(inboundIds).toContain("ch01");
    expect(inboundIds).toContain("loc_ssp_market_street");
  });

  test("a document is never its own connection", () => {
    const connections = connectionsFor(pack as never, "npcs", "npc_ch01_tai");
    expect(connections.inbound.some((ref) => ref.id === "npc_ch01_tai")).toBe(false);
    expect(connections.outbound.some((ref) => ref.id === "npc_ch01_tai")).toBe(false);
  });

  test("what the document points at is reported separately", () => {
    const connections = connectionsFor(pack as never, "locations", "loc_ssp_market_street");
    expect(connections.outbound.map((ref) => `${ref.id}:${ref.label}`)).toEqual(
      expect.arrayContaining(["loc_ssp_flat:通往 / leads to", "npc_ch01_tai:出場 / placed in"]),
    );
  });

  test("an unknown document is not a crash, and has no connections", () => {
    const connections = connectionsFor(pack as never, "items", "item_nope");
    expect(connections).toEqual({ outbound: [], inbound: [] });
  });

  test("nothing is duplicated when a field mentions the same thing twice", () => {
    const twice = {
      items: { item_a: { id: "item_a" } },
      quests: { ch01: { id: "ch01", complete_when: { all: [{ has_item: "item_a" }, { has_item: "item_a" }] } } },
    };
    const connections = connectionsFor(twice as never, "items", "item_a");
    const ids = connections.inbound.map((ref) => `${ref.id}:${ref.path}`);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("summarise", () => {
  test("says who gives it, what needs it, and what it points at", () => {
    const lines = summarise(connectionsFor(pack as never, "items", "item_flat_key"));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("需要佢");
  });

  test("an untouched item says so instead of inventing relations", () => {
    const lonely = { items: { item_b: { id: "item_b" } } };
    const lines = summarise(connectionsFor(lonely as never, "items", "item_b"));
    expect(lines[0]).toContain("冇人畀");
    expect(lines[2]).toContain("冇指向");
  });
});

describe("tableLabel", () => {
  test("names the tables a creator knows", () => {
    expect(tableLabel("npcs")).toContain("角色");
    expect(tableLabel("locations")).toContain("場景");
    expect(tableLabel("weird")).toBe("weird");
  });
});

describe("the two ways an NPC can give an item", () => {
  const giver = {
    items: { item_flat_key: { id: "item_flat_key" } },
    npcs: {
      npc_ch01_tai: {
        id: "npc_ch01_tai",
        llm: { items_may_give: ["item_flat_key"] },
        states: [{ id: "s", actions: [{ type: "give", item: "item_flat_key", count: 1 }] }],
      },
    },
  } as const;

  test("an array index resolves to the field that owns it", () => {
    expect(labelFor("llm.items_may_give.0")).toContain("可以給予");
    expect(labelFor("states.0.actions.0.item")).toContain("給予");
  });

  test("the giver is reported as giving, never as a bare index", () => {
    const connections = connectionsFor(giver as never, "items", "item_flat_key");
    const npc = connections.inbound.find((ref) => ref.id === "npc_ch01_tai");
    expect(npc?.label).toContain("給予");
    expect(npc?.label).not.toMatch(/^0/);
  });

  test("the summary counts that giver", () => {
    const lines = summarise(connectionsFor(giver as never, "items", "item_flat_key"));
    expect(lines[0]).toContain("1 個人會畀");
  });
});

describe("flags as nodes", () => {
  const pack = {
    items: {
      item_key: { id: "item_key", on_use: [{ type: "set_flag", flag: "door_open" }] },
    },
    npcs: {
      npc_a: { id: "npc_a", secrets: [{ id: "s", reveal_if: { flag: "door_open" } }] },
    },
    locations: {
      loc_a: { id: "loc_a", exits: [{ id: "e", to: "loc_b", requires: { flag: "door_open" } }] },
    },
  } as const;

  test("the same field means opposite things depending on the effect that owns it", () => {
    expect(labelFor("on_use.0.flag", "set_flag")).toContain("設定");
    expect(labelFor("secrets.0.reveal_if.flag", "")).toContain("等緊");
  });

  test("a flag lists who sets it and who waits on it", () => {
    const connections = connectionsFor(pack as never, "flags", "door_open");
    const labels = connections.inbound.map((ref) => `${ref.id}:${ref.label}`);
    expect(labels.some((line) => line.startsWith("item_key:") && line.includes("設定"))).toBe(true);
    expect(labels.some((line) => line.startsWith("npc_a:") && line.includes("等緊"))).toBe(true);
    expect(labels.some((line) => line.startsWith("loc_a:") && line.includes("等緊"))).toBe(true);
    expect(connections.outbound).toEqual([]); // a flag is passive
  });

  test("an item points at the flag it sets", () => {
    const outbound = connectionsFor(pack as never, "items", "item_key").outbound;
    expect(outbound).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "flag", id: "door_open" })]),
    );
  });

  test("every flag the pack mentions is listed once", () => {
    expect(flagsIn(pack as never)).toEqual(["door_open"]);
  });
});

describe("gaps", () => {
  test("an item nobody gives is a gap with an instruction attached", () => {
    const lonely = { items: { item_lost: { id: "item_lost" } } };
    const gaps = gapsFor(lonely as never, "items", "item_lost");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.kind).toBe("item-no-giver");
    expect(gaps[0]?.intent).toContain("item_lost");
  });

  test("an item with a giver has no gap", () => {
    const given = {
      items: { item_a: { id: "item_a" } },
      npcs: { npc_a: { id: "npc_a", llm: { items_may_give: ["item_a"] } } },
    };
    expect(gapsFor(given as never, "items", "item_a")).toEqual([]);
  });

  test("a flag nothing sets, and a flag nothing reads, are different gaps", () => {
    const readOnly = {
      items: {},
      npcs: { npc_a: { id: "npc_a", secrets: [{ reveal_if: { flag: "orphan" } }] } },
    };
    expect(gapsFor(readOnly as never, "flags", "orphan")[0]?.kind).toBe("flag-nothing-sets");

    const writeOnly = {
      items: { item_a: { id: "item_a", on_use: [{ type: "set_flag", flag: "silent" }] } },
    };
    expect(gapsFor(writeOnly as never, "flags", "silent")[0]?.kind).toBe("flag-nothing-reads");
  });

  test("a flag that is both set and read has no gap", () => {
    const balanced = {
      items: { item_a: { id: "item_a", on_use: [{ type: "set_flag", flag: "ok" }] } },
      npcs: { npc_a: { id: "npc_a", secrets: [{ reveal_if: { flag: "ok" } }] } },
    };
    expect(gapsFor(balanced as never, "flags", "ok")).toEqual([]);
  });
});
