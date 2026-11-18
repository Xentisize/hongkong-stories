import { describe, expect, test } from "bun:test";

import {
  DEFAULT_ATLAS,
  DEFAULT_MAP_SIZE,
  artProblem,
  blankDecor,
  blankDoor,
  blankExit,
  blankInteractable,
  blankLocationDoc,
  formatPoint,
  formatRect,
  formatTiles,
  freeEntryId,
  parsePoint,
  parseRect,
  parseTiles,
  rectProblem,
  spawnNames,
} from "./locationDoc";

/**
 * The rules behind the location panel's text fields.
 *
 * Two of them are there because the runtime is silent about the failure: a fragment of a tile list
 * that does not parse drops out of the door rather than moving it, and an exit rect with no area or
 * one outside the map is discarded by the client without a word.
 */

describe("spawnNames", () => {
  test("puts default first and sorts the rest", () => {
    expect(spawnNames({ from_street: [1, 1], default: [2, 2], from_flat: [3, 3] })).toEqual([
      "default",
      "from_flat",
      "from_street",
    ]);
  });

  test("reads a location with no default", () => {
    expect(spawnNames({ b: [0, 0], a: [0, 0] })).toEqual(["a", "b"]);
  });

  test("reads anything that is not a spawn table as empty", () => {
    expect(spawnNames(undefined)).toEqual([]);
    expect(spawnNames([1, 2])).toEqual([]);
  });
});

describe("freeEntryId", () => {
  test("starts at 1 when nothing has taken it", () => {
    expect(freeEntryId([], "door_")).toBe("door_1");
  });

  test("counts up past the ids in use", () => {
    expect(freeEntryId([{ id: "door_1" }, { id: "door_2" }], "door_")).toBe("door_3");
  });

  test("fills a hole left by a deletion, so no surviving id is reused", () => {
    expect(freeEntryId([{ id: "door_1" }, { id: "door_3" }], "door_")).toBe("door_2");
  });

  test("is not fooled by an entry with no id", () => {
    expect(freeEntryId([{}], "exit_")).toBe("exit_1");
  });
});

describe("blankDoor / blankExit", () => {
  test("a door starts on the tile it was placed at, with no condition", () => {
    expect(blankDoor([9, 11], "shop_door")).toEqual({
      id: "shop_door",
      tiles: [[9, 11]],
      requires: null,
      prompt: {},
    });
  });

  test("an exit starts on its rect, pointing at the target, landing on default", () => {
    expect(blankExit([0, 4, 1, 3], "loc_ssp_market_street")).toEqual({
      id: "exit_1",
      rect: [0, 4, 1, 3],
      to: "loc_ssp_market_street",
      spawn: "default",
    });
  });
});

describe("parseTiles / formatTiles", () => {
  test("round-trips a list", () => {
    expect(parseTiles(formatTiles([[9, 11], [10, 11]]))).toEqual([
      [9, 11],
      [10, 11],
    ]);
    expect(formatTiles([[9, 11], [10, 11]])).toBe("9,11; 10,11");
  });

  test("drops fragments that are not a tile", () => {
    expect(parseTiles("9,11; ; oops; 10,11")).toEqual([
      [9, 11],
      [10, 11],
    ]);
  });

  test("reads junk as no tiles", () => {
    expect(parseTiles("")).toEqual([]);
    expect(formatTiles(undefined)).toBe("");
  });
});

describe("parseRect / formatRect", () => {
  test("round-trips a rect", () => {
    expect(parseRect(formatRect([0, 4, 1, 3]))).toEqual([0, 4, 1, 3]);
  });

  test("refuses anything that is not four whole numbers", () => {
    expect(parseRect("0,4,1")).toBeNull();
    expect(parseRect("0,4,1,x")).toBeNull();
    expect(parseRect("")).toBeNull();
  });
});

describe("rectProblem", () => {
  test("a rect on the map is fine", () => {
    expect(rectProblem([0, 4, 1, 3], 16, 11)).toBeNull();
  });

  test("no area can never fire", () => {
    expect(rectProblem([0, 4, 0, 3], 16, 11)).toContain("面積為零");
  });

  test("a rect hanging off the map is named with the map's size", () => {
    expect(rectProblem([15, 10, 2, 2], 16, 11)).toContain("16×11");
  });

  test("a malformed rect says what it expects", () => {
    expect(rectProblem([0, 4, 1], 16, 11)).toContain("[x, y, w, h]");
  });
});

describe("parsePoint / formatPoint", () => {
  test("round-trips a cell", () => {
    expect(parsePoint(formatPoint([6, 2]))).toEqual([6, 2]);
    expect(formatPoint([6, 2])).toBe("6,2");
  });

  test("refuses anything that is not a whole-number cell", () => {
    expect(parsePoint("6,2,1")).toBeNull();
    expect(parsePoint("6;2")).toBeNull();
    expect(parsePoint("")).toBeNull();
  });

  test("a missing tile formats as empty, which the client would skip", () => {
    expect(formatPoint(undefined)).toBe("");
    expect(formatPoint([1])).toBe("");
  });
});

describe("blankInteractable", () => {
  test("starts on the cell, once-only, with no effects", () => {
    expect(blankInteractable([6, 2], "the_box", "art/props/prop_crate.png")).toEqual({
      id: "the_box",
      tile: [6, 2],
      art: "art/props/prop_crate.png",
      scale: 1,
      once: true,
      prompt: {},
      on_interact: [],
    });
  });

  test("copies the tile instead of aliasing the caller's array", () => {
    const tile: [number, number] = [1, 1];
    const object = blankInteractable(tile);
    tile[0] = 9;
    expect(object.tile).toEqual([1, 1]);
  });
});

describe("blankDecor", () => {
  test("is an art reference on a cell", () => {
    expect(blankDecor([5, 2], "art/props/prop_tv.png")).toEqual({
      art: "art/props/prop_tv.png",
      tile: [5, 2],
    });
  });
});

describe("blankLocationDoc", () => {
  test("is an enclosed room: wall border, floor interior", () => {
    const doc = blankLocationDoc("loc_new");
    const rows = doc.tilemap ?? [];

    expect(rows).toHaveLength(DEFAULT_MAP_SIZE.height);
    expect(rows.every((row) => row.length === DEFAULT_MAP_SIZE.width)).toBe(true);
    expect(rows[0]).toBe("#".repeat(DEFAULT_MAP_SIZE.width));
    expect(rows.at(-1)).toBe("#".repeat(DEFAULT_MAP_SIZE.width));

    const middle = rows[1] ?? "";
    expect(middle.startsWith("#")).toBe(true);
    expect(middle.endsWith("#")).toBe(true);
    expect(middle.slice(1, -1)).toBe(".".repeat(DEFAULT_MAP_SIZE.width - 2));
  });

  test("opens on the atlas and legend the authored maps use", () => {
    const doc = blankLocationDoc("loc_new");
    expect(doc.atlas).toBe(DEFAULT_ATLAS);
    expect(doc.legend).toEqual({ ".": [0, 0], "#": [2, 0] });
    expect(doc.tile_size).toBe(24);
  });

  test("puts the spawn in the middle so there is somewhere to stand", () => {
    expect(blankLocationDoc("loc_new").spawn_points).toEqual({ default: [14.5, 7.5] });
  });

  test("starts with no content, and no overlays", () => {
    const doc = blankLocationDoc("loc_new");
    expect(doc.collision).toEqual([]);
    expect(doc.npcs).toEqual([]);
    expect(doc.decor).toEqual([]);
    expect(doc.interactables).toEqual([]);
    expect(doc.doors).toEqual([]);
    expect(doc.exits).toEqual([]);
    expect(doc.layers).toBeUndefined();
  });

  test("a size too small to enclose anything is clamped to 3x3", () => {
    const doc = blankLocationDoc("loc_new", { width: 1, height: 2 });
    expect(doc.tilemap).toEqual(["###", "#.#", "###"]);
  });

  test("the display name starts empty in all three locales, ready to be filled", () => {
    expect(blankLocationDoc("loc_new").display_name).toEqual({ zh_HK: "", zh_CN: "", en: "" });
  });
});

describe("artProblem", () => {
  test("a prop path is fine", () => {
    expect(artProblem("art/props/prop_tv.png", true)).toBeNull();
  });

  test("decor without art is invisible set dressing", () => {
    expect(artProblem("", true)).toContain("冇圖片");
  });

  test("an interactable may have no art — that is an invisible trigger", () => {
    expect(artProblem("", false)).toBeNull();
  });

  test("absolute, res:// and traversing paths are named", () => {
    expect(artProblem("/art/props/x.png", true)).toContain("內容相對路徑");
    expect(artProblem("res://content/art/props/x.png", true)).toContain("內容相對路徑");
    expect(artProblem("art/../../secret.png", true)).toContain("內容相對路徑");
  });
});
