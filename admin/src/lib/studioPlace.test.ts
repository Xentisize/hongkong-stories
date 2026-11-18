import { describe, expect, test } from "bun:test";

import { inBounds, placeInLocation, tilemapBounds, type LocationLike } from "./studioPlace";

/**
 * Placement rules for the studio's palette.
 *
 * The refusals matter more than the happy path: a tile off the map, or an empty id, must come back
 * as null so the caller can say so instead of writing a draft the validator will reject later.
 */

const scene: LocationLike = {
  tilemap: ["....", "....", "..  "],
  npcs: [{ npc: "npc_a", tile: [1, 1], facing: "down" }],
  decor: [{ art: "art/props/crate.png", tile: [0, 0] }],
};

describe("tilemapBounds", () => {
  test("the longest row decides the width", () => {
    expect(tilemapBounds(["..", "....."])).toEqual({ width: 5, height: 2 });
  });

  test("a missing or malformed tilemap is empty, not a crash", () => {
    expect(tilemapBounds(undefined)).toEqual({ width: 0, height: 0 });
    expect(tilemapBounds("....")).toEqual({ width: 0, height: 0 });
    expect(tilemapBounds(["..", 7, ".."])).toEqual({ width: 2, height: 2 });
  });
});

describe("inBounds", () => {
  test("inside is inside, edges included", () => {
    expect(inBounds(scene.tilemap, [0, 0])).toBe(true);
    expect(inBounds(scene.tilemap, [3, 1])).toBe(true);
  });

  test("outside and non-integers are refused", () => {
    expect(inBounds(scene.tilemap, [4, 0])).toBe(false);
    expect(inBounds(scene.tilemap, [0, 3])).toBe(false); // the scene is three rows tall
    expect(inBounds(scene.tilemap, [0, 2])).toBe(true); // ragged row still belongs to the map
    expect(inBounds(scene.tilemap, [-1, 0])).toBe(false);
    expect(inBounds(scene.tilemap, [1.5, 0])).toBe(false);
  });
});

describe("placeInLocation", () => {
  test("a character is added at the tile", () => {
    const next = placeInLocation(scene, { kind: "npc", id: "npc_b" }, [2, 0]);
    expect(next?.npcs).toEqual([
      { npc: "npc_a", tile: [1, 1], facing: "down" },
      { npc: "npc_b", tile: [2, 0], facing: "down" },
    ]);
  });

  test("placing on an occupied tile replaces what was there", () => {
    const next = placeInLocation(scene, { kind: "npc", id: "npc_b" }, [1, 1]);
    expect(next?.npcs).toEqual([{ npc: "npc_b", tile: [1, 1], facing: "down" }]);
  });

  test("a prop goes to decor, replacing a prop on the same cell", () => {
    const added = placeInLocation(scene, { kind: "decor", id: "art/props/plant.png" }, [2, 2]);
    expect(added?.decor).toEqual([
      { art: "art/props/crate.png", tile: [0, 0] },
      { art: "art/props/plant.png", tile: [2, 2] },
    ]);

    const replaced = placeInLocation(scene, { kind: "decor", id: "art/props/plant.png" }, [0, 0]);
    expect(replaced?.decor).toEqual([{ art: "art/props/plant.png", tile: [0, 0] }]);
  });

  test("nothing outside the map and nothing nameless is written", () => {
    expect(placeInLocation(scene, { kind: "npc", id: "npc_b" }, [4, 0])).toBeNull();
    expect(placeInLocation(scene, { kind: "npc", id: "   " }, [0, 1])).toBeNull();
    expect(placeInLocation(scene, { kind: "decor", id: "" }, [0, 1])).toBeNull();
  });

  test("the document handed in is never mutated", () => {
    placeInLocation(scene, { kind: "npc", id: "npc_b" }, [2, 0]);
    expect(scene.npcs).toHaveLength(1);
    expect(scene.decor).toHaveLength(1);
  });

  test("a scene without npcs or decor gains them", () => {
    const bare: LocationLike = { tilemap: ["..", ".."] };
    expect(placeInLocation(bare, { kind: "npc", id: "npc_b" }, [1, 1])?.npcs).toHaveLength(1);
    expect(placeInLocation(bare, { kind: "decor", id: "art/props/x.png" }, [0, 1])?.decor).toHaveLength(1);
  });
});

describe("placing a tile", () => {
  const withLegend: LocationLike = {
    tilemap: ["....", "...."],
    legend: { ".": [0, 0], "#": [2, 0], D: [3, 0] },
  };

  test("a legend character is painted into the grid", () => {
    const next = placeInLocation(withLegend, { kind: "tile", id: "D" }, [2, 1]);
    expect(next?.tilemap).toEqual(["....", "..D."]);
  });

  test("a character no legend defines is refused, not painted blind", () => {
    expect(placeInLocation(withLegend, { kind: "tile", id: "Q" }, [0, 0])).toBeNull();
    expect(placeInLocation({ tilemap: [".."] }, { kind: "tile", id: "D" }, [0, 0])).toBeNull();
  });

  test("off the map is refused", () => {
    expect(placeInLocation(withLegend, { kind: "tile", id: "D" }, [4, 0])).toBeNull();
  });
});
