/**
 * Content validation (§9.2, §11) — the publish gate.
 *
 * Two layers:
 *
 *  1. The real shipped pack must validate with zero errors. CI already enforces that through
 *     `tools/check_content.py`, so a failure here means this port disagrees with the gate that
 *     actually guards releases — which is exactly what we want to find out now, not at publish.
 *  2. Synthetic packs, one defect each, so every rule is pinned to a specific message. A rule
 *     that only exists in the Python source is a rule that will silently disappear.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  errorsOnly,
  isPublishable,
  packFromEntries,
  validatePack,
  type ContentEntity,
  type ContentPack,
  type Issue,
} from "../src/validate";

const CONTENT_DIR = new URL("../../../client/content/", import.meta.url).pathname;

/** Load the pack the game actually ships, through the same manifest the client uses. */
function loadRealPack(): ContentPack {
  const manifest = JSON.parse(
    readFileSync(join(CONTENT_DIR, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  const files = Array.isArray(manifest["files"]) ? manifest["files"] : [];
  const entries: Record<string, ContentEntity> = {};
  for (const entry of files) {
    const relative = String(entry);
    entries[relative] = JSON.parse(
      readFileSync(join(CONTENT_DIR, relative), "utf8"),
    ) as ContentEntity;
  }
  return packFromEntries(entries, manifest);
}

const LOCALIZED = (zhHK: string, zhCN: string, en: string) => ({
  zh_HK: zhHK,
  zh_CN: zhCN,
  en,
});

/** A minimal pack with no defects — every assertion below mutates exactly one thing. */
function baseEntries(): Record<string, ContentEntity> {
  return {
    "npcs/npc_a.json": {
      id: "npc_a",
      display_name: LOCALIZED("甲", "甲", "A"),
      persona: { role: "keeper" },
      llm: {},
      secrets: [],
      scripted_fallback: { greeting: LOCALIZED("嗨", "嗨", "Hi") },
    },
    "items/item_k.json": {
      id: "item_k",
      name: LOCALIZED("鑰匙", "钥匙", "Key"),
    },
    "locations/loc_a.json": {
      id: "loc_a",
      display_name: LOCALIZED("街", "街", "Street"),
      tilemap: ["##", "##"],
      spawn_points: { default: [1, 1] },
    },
    "quests/quest_q.json": {
      id: "quest_q",
      nodes: [{ id: "n1", next: "n2" }, { id: "n2" }],
    },
  };
}

function issuesOf(entries: Record<string, ContentEntity>): Issue[] {
  return validatePack(packFromEntries(entries));
}

function messagesFor(entries: Record<string, ContentEntity>, level: "error" | "warn"): string[] {
  return issuesOf(entries)
    .filter((issue) => issue.level === level)
    .map((issue) => issue.message);
}

describe("the real shipped pack", () => {
  const pack = loadRealPack();
  const issues = validatePack(pack);

  test("it loads through the manifest", () => {
    expect(Object.keys(pack.tables["npcs"] ?? {}).length).toBeGreaterThan(10);
    expect(Object.keys(pack.tables["locations"] ?? {}).length).toBeGreaterThan(5);
  });

  test("it validates with zero errors", () => {
    expect(errorsOnly(issues)).toEqual([]);
  });

  test("it is publishable", () => {
    expect(isPublishable(issues)).toBe(true);
  });

  test("warnings, if any, are only flag-reachability advisories", () => {
    const warns = issues.filter((issue) => issue.level === "warn");
    expect(warns.every((issue) => issue.path === "flags")).toBe(true);
  });
});

describe("locale coverage", () => {
  test("a missing locale is an error unless acknowledged in _todo", () => {
    const entries = baseEntries();
    entries["items/item_k.json"]!["name"] = { zh_HK: "鑰匙", en: "Key" };
    expect(messagesFor(entries, "error")).toContainEqual(
      expect.stringContaining("missing locales"),
    );

    entries["items/item_k.json"]!["name"] = { zh_HK: "鑰匙", en: "Key", _todo: "zh_CN later" };
    expect(errorsOnly(issuesOf(entries))).toEqual([]);
  });

  test("a present but empty locale is an error", () => {
    const entries = baseEntries();
    entries["items/item_k.json"]!["name"] = LOCALIZED("鑰匙", "  ", "Key");
    expect(messagesFor(entries, "error")).toContainEqual(
      expect.stringContaining("locale key present but empty"),
    );
  });

  test("a plain string is accepted as an already-localized field", () => {
    const entries = baseEntries();
    entries["items/item_k.json"]!["name"] = "Key";
    expect(errorsOnly(issuesOf(entries))).toEqual([]);
  });

  test("an empty required string is an error", () => {
    const entries = baseEntries();
    entries["items/item_k.json"]!["name"] = "   ";
    expect(messagesFor(entries, "error")).toContainEqual(
      expect.stringContaining("required string is empty"),
    );
  });
});

describe("referential integrity", () => {
  test("an unknown item in an effect is an error", () => {
    const entries = baseEntries();
    entries["items/item_k.json"]!["on_use"] = [{ type: "give", item: "item_nope" }];
    expect(messagesFor(entries, "error")).toContainEqual(expect.stringContaining("unknown item"));
  });

  test("an unknown location in an effect is an error", () => {
    const entries = baseEntries();
    entries["locations/loc_a.json"]!["interactables"] = [
      { id: "prop", on_interact: [{ type: "goto", location: "loc_nowhere" }] },
    ];
    expect(messagesFor(entries, "error")).toContainEqual(
      expect.stringContaining("unknown location"),
    );
  });

  test("an unknown npc placement is an error", () => {
    const entries = baseEntries();
    entries["locations/loc_a.json"]!["npcs"] = [{ npc: "npc_ghost" }];
    expect(messagesFor(entries, "error")).toContainEqual(expect.stringContaining("unknown npc"));
  });

  test("an exit to an undefined spawn is an error", () => {
    const entries = baseEntries();
    entries["locations/loc_a.json"]!["exits"] = [{ id: "e1", to: "loc_a", spawn: "roof" }];
    expect(messagesFor(entries, "error")).toContainEqual(
      expect.stringContaining("spawn 'roof' not defined"),
    );
  });

  test("an exit to a defined spawn is fine", () => {
    const entries = baseEntries();
    entries["locations/loc_a.json"]!["exits"] = [
      { id: "e1", to: "loc_a", spawn: "default" },
      { id: "e2", to: "loc_a", spawn: "roof" },
    ];
    entries["locations/loc_a.json"]!["spawn_points"] = { default: [1, 1], roof: [2, 2] };
    expect(errorsOnly(issuesOf(entries))).toEqual([]);
  });

  test("a held item that does not exist is an error", () => {
    const entries = baseEntries();
    entries["locations/loc_a.json"]!["doors"] = [
      { id: "d1", requires: { held: "item_nope" } },
    ];
    expect(messagesFor(entries, "error")).toContainEqual(
      expect.stringContaining("unknown item 'item_nope'"),
    );
  });
});

describe("quest structure", () => {
  test("a quest with no nodes is an error", () => {
    const entries = baseEntries();
    entries["quests/quest_q.json"]!["nodes"] = [];
    expect(messagesFor(entries, "error")).toContainEqual(
      expect.stringContaining("quest has no nodes"),
    );
  });

  test("duplicate node ids are an error", () => {
    const entries = baseEntries();
    entries["quests/quest_q.json"]!["nodes"] = [{ id: "n1" }, { id: "n1" }];
    expect(messagesFor(entries, "error")).toContainEqual(
      expect.stringContaining("duplicate node ids"),
    );
  });

  test("a node off the next chain is unreachable", () => {
    const entries = baseEntries();
    entries["quests/quest_q.json"]!["nodes"] = [{ id: "n1" }, { id: "orphan" }];
    expect(messagesFor(entries, "error")).toContainEqual(
      expect.stringContaining("unreachable node"),
    );
  });

  test("a next pointer to a missing node is an error", () => {
    const entries = baseEntries();
    entries["quests/quest_q.json"]!["nodes"] = [{ id: "n1", next: "n_missing" }];
    expect(messagesFor(entries, "error")).toContainEqual(
      expect.stringContaining("unknown node 'n_missing'"),
    );
  });

  test("a longer next chain is reachable", () => {
    const entries = baseEntries();
    entries["quests/quest_q.json"]!["nodes"] = [
      { id: "n1", next: "n2" },
      { id: "n2", next: "n3" },
      { id: "n3" },
    ];
    expect(errorsOnly(issuesOf(entries))).toEqual([]);
  });
});

describe("vocabulary", () => {
  test("an unknown effect type is an error", () => {
    const entries = baseEntries();
    entries["items/item_k.json"]!["on_acquire"] = [{ type: "enchant" }];
    expect(messagesFor(entries, "error")).toContainEqual(
      expect.stringContaining("unknown effect type"),
    );
  });

  test("an unknown condition verb is an error", () => {
    const entries = baseEntries();
    entries["locations/loc_a.json"]!["doors"] = [
      { id: "d1", requires: { weather: "rain" } },
    ];
    expect(messagesFor(entries, "error")).toContainEqual(
      expect.stringContaining("unknown condition verb"),
    );
  });

  test("all/any must be lists", () => {
    const entries = baseEntries();
    entries["locations/loc_a.json"]!["doors"] = [
      { id: "d1", requires: { all: { flag: "x" } } },
    ];
    expect(messagesFor(entries, "error")).toContainEqual(
      expect.stringContaining("must be a list"),
    );
  });

  test("an unknown action type in the allowlist is an error", () => {
    const entries = baseEntries();
    entries["npcs/npc_a.json"]!["llm"] = { actions_allowed: ["summon_dragon"] };
    expect(messagesFor(entries, "error")).toContainEqual(
      expect.stringContaining("unknown action type"),
    );
  });

  test("an item the NPC may give must exist", () => {
    const entries = baseEntries();
    entries["npcs/npc_a.json"]!["llm"] = { items_may_give: ["item_nope"] };
    expect(messagesFor(entries, "error")).toContainEqual(
      expect.stringContaining("unknown item 'item_nope'"),
    );
  });
});

describe("npc authoring requirements", () => {
  test("persona.role is required", () => {
    const entries = baseEntries();
    entries["npcs/npc_a.json"]!["persona"] = {};
    expect(messagesFor(entries, "error")).toContainEqual(
      expect.stringContaining("persona.role is required"),
    );
  });

  test("scripted_fallback is required, because every NPC must survive an outage (§7.4)", () => {
    const entries = baseEntries();
    delete entries["npcs/npc_a.json"]!["scripted_fallback"];
    expect(messagesFor(entries, "error")).toContainEqual(
      expect.stringContaining("scripted_fallback is required"),
    );
  });

  test("a secret without an id is an error", () => {
    const entries = baseEntries();
    entries["npcs/npc_a.json"]!["secrets"] = [{ text: LOCALIZED("秘密", "秘密", "Secret") }];
    expect(messagesFor(entries, "error")).toContainEqual(
      expect.stringContaining("secret missing id"),
    );
  });
});

describe("warnings do not block publishing", () => {
  test("a flag read but never settable warns and still publishes", () => {
    const entries = baseEntries();
    entries["locations/loc_a.json"]!["doors"] = [
      { id: "d1", requires: { flag: "never_set" } },
    ];
    const issues = issuesOf(entries);
    expect(issues.filter((i) => i.level === "warn").map((i) => i.message)).toContainEqual(
      expect.stringContaining("nothing can set it"),
    );
    expect(isPublishable(issues)).toBe(true);
  });

  test("the same flag stops warning once an effect can set it", () => {
    const entries = baseEntries();
    entries["locations/loc_a.json"]!["doors"] = [
      { id: "d1", requires: { flag: "now_set" } },
    ];
    entries["items/item_k.json"]!["on_use"] = [{ type: "set_flag", flag: "now_set" }];
    expect(messagesFor(entries, "warn")).toEqual([]);
  });

  test("differing tilemap row lengths warn but still publish", () => {
    const entries = baseEntries();
    entries["locations/loc_a.json"]!["tilemap"] = ["###", "##"];
    const issues = issuesOf(entries);
    expect(issues.map((i) => i.message)).toContainEqual(
      expect.stringContaining("rows have differing lengths"),
    );
    expect(isPublishable(issues)).toBe(true);
  });
});

describe("collision geometry", () => {
  // loc_a is a 2x2 map; each case sets exactly one collision value on it.
  const withCollision = (collision: unknown) => {
    const entries = baseEntries();
    entries["locations/loc_a.json"]!["collision"] = collision as never;
    return entries;
  };

  test("rects inside the map are accepted", () => {
    expect(messagesFor(withCollision([[0, 0, 2, 1], [0, 1, 1, 1]]), "error")).toEqual([]);
  });

  test("a rect that runs past the map is refused, and says how big the map is", () => {
    const errors = messagesFor(withCollision([[1, 1, 5, 5]]), "error");
    expect(errors.some((message) => message.includes("outside the 2x2 map"))).toBe(true);
  });

  test("a rect covering no tiles is refused", () => {
    expect(messagesFor(withCollision([[0, 0, 0, 1]]), "error").some((m) => m.includes("covers no tiles"))).toBe(
      true,
    );
  });

  test("a malformed rect is refused", () => {
    expect(messagesFor(withCollision([[0, 0, 1]]), "error")).toEqual(["each rect must be [x, y, w, h]"]);
    expect(
      messagesFor(withCollision([[0, 0, 1.5, 1]]), "error").some((m) => m.includes("whole tile coordinates")),
    ).toBe(true);
  });

  test("collision present but not an array is refused", () => {
    expect(
      messagesFor(withCollision("nope"), "error").some((m) => m.includes("must be an array")),
    ).toBe(true);
  });

  test("a location with no collision block passes", () => {
    expect(messagesFor(baseEntries(), "error")).toEqual([]);
  });
});

describe("publish gating", () => {
  test("allowlist flags count as settable", () => {
    const entries = baseEntries();
    entries["locations/loc_a.json"]!["doors"] = [
      { id: "d1", requires: { flag: "keeper_helped" } },
    ];
    entries["npcs/npc_a.json"]!["llm"] = { flags_may_set: ["keeper_helped"] };
    expect(messagesFor(entries, "warn")).toEqual([]);
  });

  test("door open_flag counts as settable", () => {
    const entries = baseEntries();
    entries["locations/loc_a.json"]!["doors"] = [
      { id: "d1", open_flag: "door_d1_open" },
      { id: "d2", requires: { flag: "door_d1_open" } },
    ];
    expect(messagesFor(entries, "warn")).toEqual([]);
  });
});
