import { describe, expect, test } from "bun:test";

import { collectAssetRefs, isAssetReference, locateAsset } from "./assets";

/**
 * Reference classification, held to the two things a bundle depends on.
 *
 * Finding the bytes: every spelling the content actually uses has to resolve to one place. And not
 * copying the wrong bytes: an absolute or traversing path must resolve to nothing at all, because a
 * bundle writer that accepts them would ship a file from outside the project.
 */

describe("locateAsset", () => {
  test("a Godot content path is inside the pack", () => {
    expect(locateAsset("res://content/art/items/item_tea_tin.png")).toEqual({
      root: "content",
      path: "art/items/item_tea_tin.png",
    });
  });

  test("a Godot asset path is beside the pack", () => {
    expect(locateAsset("res://assets/tiles/p1_tiles.png")).toEqual({
      root: "assets",
      path: "tiles/p1_tiles.png",
    });
  });

  test("content-relative and asset-relative spellings resolve too", () => {
    expect(locateAsset("art/props/prop_tv.png")).toEqual({ root: "content", path: "art/props/prop_tv.png" });
    expect(locateAsset("lore/ch02_kln_1955.md")).toEqual({ root: "content", path: "lore/ch02_kln_1955.md" });
    expect(locateAsset("audio/ssp_flat_2027.wav")).toEqual({ root: "assets", path: "audio/ssp_flat_2027.wav" });
    expect(locateAsset("sprites/item_rusty_key.png")).toEqual({
      root: "assets",
      path: "sprites/item_rusty_key.png",
    });
  });

  test("absolute and traversing paths resolve to nothing", () => {
    expect(locateAsset("/etc/passwd")).toBeNull();
    expect(locateAsset("art/../../secret.png")).toBeNull();
    expect(locateAsset("../outside.png")).toBeNull();
  });

  test("a res:// path outside content and assets is not ours to carry", () => {
    expect(locateAsset("res://engine/icon.svg")).toBeNull();
  });

  test("prose and non-strings are not references", () => {
    expect(locateAsset("zh_HK")).toBeNull();
    expect(locateAsset("A small flat above the family's shop")).toBeNull();
    expect(locateAsset("")).toBeNull();
    expect(locateAsset(undefined)).toBeNull();
    expect(locateAsset(42)).toBeNull();
  });
});

describe("isAssetReference", () => {
  test("a resolvable path with a media extension is a file", () => {
    expect(isAssetReference("art/props/prop_tv.png")).toBe(true);
    expect(isAssetReference("audio/kln_1955.wav")).toBe(true);
    expect(isAssetReference("lore/ch01_hk_2027.md")).toBe(true);
  });

  test("a directory, an unknown extension or prose is not", () => {
    expect(isAssetReference("art/props")).toBe(false);
    expect(isAssetReference("art/props/readme.txt")).toBe(false);
    expect(isAssetReference("zh_HK")).toBe(false);
  });
});

describe("collectAssetRefs", () => {
  test("finds references at any depth, deduplicated and sorted", () => {
    const document = {
      id: "loc_ssp_flat",
      atlas: "res://assets/tiles/p1_tiles_2027.png",
      music: "audio/ssp_flat_2027.wav",
      decor: [
        { art: "art/props/prop_tv.png", tile: [5, 2] },
        { art: "art/props/prop_plant.png", tile: [11, 2] },
      ],
      interactables: [{ art: "art/props/prop_tv.png", prompt: { zh_HK: "挪開收音機" } }],
    };

    expect(collectAssetRefs(document)).toEqual([
      { root: "assets", path: "audio/ssp_flat_2027.wav", ref: "audio/ssp_flat_2027.wav" },
      { root: "assets", path: "tiles/p1_tiles_2027.png", ref: "res://assets/tiles/p1_tiles_2027.png" },
      { root: "content", path: "art/props/prop_plant.png", ref: "art/props/prop_plant.png" },
      { root: "content", path: "art/props/prop_tv.png", ref: "art/props/prop_tv.png" },
    ]);
  });

  test("two spellings of one file collapse to one asset", () => {
    const refs = collectAssetRefs({
      icon: "res://content/art/items/item_tea_tin.png",
      portrait: "art/items/item_tea_tin.png",
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]?.path).toBe("art/items/item_tea_tin.png");
  });

  test("localized prose and numbers are left alone", () => {
    const refs = collectAssetRefs({
      name: { zh_HK: "鐵皮茶葉罐", en: "Tin of Tea Leaves" },
      stack_max: 1,
      desc: { en: "A tin of tea from A-choi; the print on the lid is worn soft." },
    });
    expect(refs).toEqual([]);
  });

  test("lore references count as assets, because a bundle carries those pages", () => {
    expect(collectAssetRefs({ lore_ref: "lore/ch02_kln_1955.md" })).toEqual([
      { root: "content", path: "lore/ch02_kln_1955.md", ref: "lore/ch02_kln_1955.md" },
    ]);
  });
});
