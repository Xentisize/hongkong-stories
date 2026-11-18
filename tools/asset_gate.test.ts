import { describe, expect, test } from "bun:test";

import { missingAssets } from "./asset_gate";

/**
 * The content gate's asset check.
 *
 * The case worth guarding is the one that shipped: a location pointing at a prop that was never
 * drawn. Nothing else in the pipeline notices — the validator cannot see files, and the clients
 * skip what they cannot load — so this function is the only thing standing between authoring and a
 * silently invisible object.
 */

const carried = (paths: string[]) => (path: string) => paths.includes(path);

describe("missingAssets", () => {
  test("a dangling content reference is reported with its authored spelling", () => {
    const documents = {
      "locations/loc_ssp_flat.json": {
        id: "loc_ssp_flat",
        interactables: [{ id: "the_box", art: "art/props/prop_cardboard_box.png" }],
      },
    };

    expect(missingAssets(documents, carried([]))).toEqual([
      { path: "content/art/props/prop_cardboard_box.png", ref: "art/props/prop_cardboard_box.png" },
    ]);
  });

  test("references are checked under the right root", () => {
    const documents = {
      "locations/loc_a.json": {
        id: "loc_a",
        atlas: "res://assets/tiles/p1_tiles.png",
        music: "audio/ssp_2027.wav",
        lore_ref: "lore/ch01_hk_2027.md",
      },
    };

    const seen: string[] = [];
    missingAssets(documents, (path) => {
      seen.push(path);
      return true;
    });

    expect(seen.sort()).toEqual([
      "assets/audio/ssp_2027.wav",
      "assets/tiles/p1_tiles.png",
      "content/lore/ch01_hk_2027.md",
    ]);
  });

  test("a complete pack reports nothing", () => {
    const documents = {
      "items/item_tea_tin.json": {
        id: "item_tea_tin",
        icon: "res://content/art/items/item_tea_tin.png",
        lore_ref: "lore/ch02_kln_1955.md",
      },
    };
    expect(
      missingAssets(
        documents,
        carried(["content/art/items/item_tea_tin.png", "content/lore/ch02_kln_1955.md"]),
      ),
    ).toEqual([]);
  });

  test("prose and tiles are not references", () => {
    const documents = {
      "npcs/npc_a.json": {
        id: "npc_a",
        display_name: { zh_HK: "陳太", en: "Mrs Chan" },
        persona: { role: "a shopkeeper" },
      },
    };
    expect(missingAssets(documents, carried([]))).toEqual([]);
  });
});
