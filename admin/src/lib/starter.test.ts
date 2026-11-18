import { describe, expect, test } from "bun:test";

import { buildStarter, describeStarter, standingTile, starterQuest, starterScene, type StarterChoice } from "./starter";

/**
 * The deterministic starter.
 *
 * It exists so the beginner path works with no model reachable, which means the guarantees are
 * mechanical: the original scene is never mutated, the character lands somewhere walkable, and the
 * generated quest names the item and the character it was built from.
 */

const choice: StarterChoice = {
  sceneId: "loc_ssp_market_street",
  scene: {
    schema_version: 1,
    id: "loc_ssp_market_street",
    title: { zh_HK: "北河街街市", en: "Pei Ho Street Market" },
    tilemap: ["#####", "#...#", "#.#.#", "#####"],
    npcs: [{ npc: "npc_old", tile: [1, 1], facing: "down" }],
  },
  npcId: "npc_ch01_tai",
  itemId: "item_flat_key",
  names: { scene: "北河街街市", npc: "陳太", item: "鎖匙" },
};

describe("standingTile", () => {
  test("a walkable tile, never a wall", () => {
    const tilemap = choice.scene["tilemap"] as string[];
    const [x, y] = standingTile(tilemap);
    expect(tilemap[y]?.[x]).not.toBe("#");
  });

  test("an empty or malformed tilemap still yields a tile", () => {
    expect(standingTile(undefined)).toEqual([0, 0]);
    expect(standingTile([])).toEqual([0, 0]);
  });
});

describe("starterQuest", () => {
  test("three steps, chained, ending in a cutscene", () => {
    const quest = starterQuest(choice);
    expect(quest.nodes?.map((node) => node.id)).toEqual(["n1", "n2", "n3"]);
    expect(quest.nodes?.map((node) => node.next)).toEqual(["n2", "n3", null]);
    expect(quest.nodes?.[2]?.type).toBe("cutscene");
  });

  test("the objectives name the character and the item it was built from", () => {
    const quest = starterQuest(choice);
    expect(JSON.stringify(quest.nodes?.[0]?.complete_when)).toContain("npc_ch01_tai");
    expect(JSON.stringify(quest.nodes?.[1]?.complete_when)).toContain("item_flat_key");
    expect(JSON.stringify(quest.nodes?.[0]?.text)).toContain("陳太");
  });

  test("the quest's id is derived from the scene, so two starts cannot collide", () => {
    expect(starterQuest(choice).id).toBe("ssp_market_street_intro");
    expect(starterQuest({ ...choice, sceneId: "loc_kln_lane_1963" }).id).toBe("kln_lane_1963_intro");
  });
});

describe("starterScene", () => {
  test("a new scene id, and the original is untouched", () => {
    const made = starterScene(choice);
    expect(made.id).toBe("loc_ssp_market_street_intro");
    expect(made.doc["id"]).toBe("loc_ssp_market_street_intro");
    expect(choice.scene["id"]).toBe("loc_ssp_market_street");
    expect(choice.scene["npcs"]).toHaveLength(1);
  });

  test("the character is placed, next to whoever was already there", () => {
    const made = starterScene(choice);
    const npcs = made.doc["npcs"] as Array<{ npc: string; tile: [number, number] }>;
    expect(npcs.some((entry) => entry.npc === "npc_ch01_tai")).toBe(true);
    expect(npcs.some((entry) => entry.npc === "npc_old")).toBe(true);
  });

  test("the title keeps its original name and says it is a starter", () => {
    const made = starterScene(choice);
    expect((made.doc["title"] as Record<string, string>)["zh_HK"]).toContain("北河街街市");
    expect((made.doc["title"] as Record<string, string>)["zh_HK"]).toContain("起步");
  });
});

describe("buildStarter", () => {
  test("a whole starter, described in two lines", () => {
    const starter = buildStarter(choice);
    expect(starter.quest.id).toBe("ssp_market_street_intro");
    expect(describeStarter(starter)).toHaveLength(2);
    expect(describeStarter(starter)[1]).toContain("3 步");
  });
});
