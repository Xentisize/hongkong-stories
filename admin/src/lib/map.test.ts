import { describe, expect, test } from "bun:test";

import {
  applyDrop,
  atlasUrl,
  blankMap,
  cellFromPoint,
  growMap,
  legendEntries,
  mapSize,
  moveNpc,
  npcIndexAt,
  paintTile,
  placeNpc,
  removeNpcAt,
  selectedNpc,
  tileAt,
  type MapNpc,
} from "./map";

/**
 * Map primitives.
 *
 * These matter more than they look: the editor's undo stack, its drag-painting and its NPC markers
 * all rest on `paintTile`/`moveNpc` returning the *same* array when nothing changed. If a no-op
 * started returning a new array, a single drag across already-painted tiles would bury the real
 * history under dozens of identical snapshots.
 */

const legend = { ".": [0, 0], ",": [1, 0], "#": [2, 0], D: [3, 0] } as Record<string, [number, number]>;

describe("atlasUrl", () => {
  test("maps a Godot resource path onto the assets route", () => {
    expect(atlasUrl("res://assets/tiles/p1_tiles_2027.png")).toBe(
      "/v1/assets/file/tiles/p1_tiles_2027.png",
    );
  });

  test("leaves a web URL or absolute path alone", () => {
    expect(atlasUrl("https://example.test/a.png")).toBe("https://example.test/a.png");
    expect(atlasUrl("/v1/assets/file/tiles/a.png")).toBe("/v1/assets/file/tiles/a.png");
    expect(atlasUrl("data:image/png;base64,AAA")).toBe("data:image/png;base64,AAA");
  });

  test("an unservable res:// path is passed through unchanged, not silently rewritten", () => {
    // A wrong URL should show as a broken image; quietly pointing it somewhere else would hide the
    // mistake until someone noticed the wrong tiles.
    expect(atlasUrl("res://scenes/main.tscn")).toBe("res://scenes/main.tscn");
  });

  test("empty input yields an empty string", () => {
    expect(atlasUrl(undefined)).toBe("");
    expect(atlasUrl("")).toBe("");
  });
});

describe("grid geometry", () => {
  test("size reports the widest row, so a ragged map cannot under-report", () => {
    expect(mapSize(["####", "##", "######"])).toEqual({ width: 6, height: 3 });
    expect(mapSize([])).toEqual({ width: 0, height: 0 });
  });

  test("legend entries come back in a stable order", () => {
    const entries = legendEntries(legend);
    expect(entries.map((entry) => entry.char)).toEqual([".", ",", "#", "D"]);
    expect(entries[3]).toEqual({ char: "D", col: 3, row: 0 });
    expect(legendEntries(undefined)).toEqual([]);
  });

  test("tileAt reads within bounds and returns undefined outside them", () => {
    const map = ["###", "#.#"];
    expect(tileAt(map, 0, 0)).toBe("#");
    expect(tileAt(map, 1, 1)).toBe(".");
    expect(tileAt(map, 5, 0)).toBeUndefined();
    expect(tileAt(map, 0, -1)).toBeUndefined();
    expect(tileAt(map, 0, 9)).toBeUndefined();
  });
});

describe("paintTile", () => {
  test("writes one character without touching the rest of the row", () => {
    const map = ["#####", "#####"];
    const painted = paintTile(map, 2, 1, ".");
    expect(painted).toEqual(["#####", "##.##"]);
    // Immutability: the original array is untouched.
    expect(map).toEqual(["#####", "#####"]);
  });

  test("a no-op write returns the same array by identity", () => {
    const map = ["#####"];
    expect(paintTile(map, 2, 0, "#")).toBe(map);
  });

  test("out-of-bounds writes are ignored by identity", () => {
    const map = ["###", "##"];
    expect(paintTile(map, -1, 0, ".")).toBe(map);
    expect(paintTile(map, 3, 0, ".")).toBe(map);
    expect(paintTile(map, 0, 2, ".")).toBe(map);
    // Ragged row: x=2 exists on row 0 but not on row 1.
    expect(paintTile(map, 2, 1, ".")).toBe(map);
  });
});

describe("blankMap and growMap", () => {
  test("blankMap builds a rectangle of the requested character", () => {
    expect(blankMap(4, 2, ".")).toEqual(["....", "...."]);
  });

  test("growMap pads right and down, never shrinks", () => {
    expect(growMap(["##"], 4, 2, ".")).toEqual(["##..", "...."]);
    expect(growMap(["####", "####"], 2, 1, ".")).toEqual(["####", "####"]);
  });
});

describe("NPC placements", () => {
  const npcs: MapNpc[] = [
    { npc: "npc_ken", tile: [2, 3], facing: "down" },
    { npc: "npc_wai", tile: [5, 1], facing: "left", wander: 2 },
  ];

  test("finds a placement by tile", () => {
    expect(npcIndexAt(npcs, 5, 1)).toBe(1);
    expect(npcIndexAt(npcs, 4, 1)).toBe(-1);
    expect(selectedNpc(npcs, 2, 3)?.npc).toBe("npc_ken");
    expect(selectedNpc(npcs, 0, 0)).toBeUndefined();
  });

  test("moving keeps every other field and leaves the original array alone", () => {
    const moved = moveNpc(npcs, 1, 6, 2);
    expect(moved[1]).toEqual({ npc: "npc_wai", tile: [6, 2], facing: "left", wander: 2 });
    expect(npcs[1]!.tile).toEqual([5, 1]);
  });

  test("moving nowhere, or onto another marker, changes nothing", () => {
    expect(moveNpc(npcs, 0, 2, 3)).toBe(npcs);
    // Two markers on one cell would be unreadable on the canvas and ambiguous to click.
    expect(moveNpc(npcs, 0, 5, 1)).toBe(npcs);
    expect(moveNpc(npcs, 9, 0, 0)).toBe(npcs);
  });

  test("placing on an occupied cell replaces the marker there", () => {
    const placed = placeNpc(npcs, "npc_tai", 2, 3);
    expect(placed).toHaveLength(2);
    expect(selectedNpc(placed, 2, 3)?.npc).toBe("npc_tai");
    expect(placed.find((entry) => entry.npc === "npc_ken")).toBeUndefined();
  });

  test("placing with no npc selected is refused", () => {
    expect(placeNpc(npcs, "", 0, 0)).toBe(npcs);
  });

  test("removing a marker drops only that one", () => {
    const remaining = removeNpcAt(npcs, 5, 1);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.npc).toBe("npc_ken");
  });
});

describe("cellFromPoint", () => {
  // 4x3 cells of 48px, offset from the viewport origin the way a real canvas sits in a panel.
  const rect = { left: 10, top: 20, width: 192, height: 144 };

  test("maps a point inside a cell to that cell", () => {
    expect(cellFromPoint(rect, 10, 20, 48)).toEqual([0, 0]);
    expect(cellFromPoint(rect, 58, 68, 48)).toEqual([1, 1]);
    expect(cellFromPoint(rect, 105, 68, 48)).toEqual([1, 1]);
  });

  test("a point on the boundary belongs to the next cell", () => {
    expect(cellFromPoint(rect, 10 + 48, 20, 48)).toEqual([1, 0]);
    expect(cellFromPoint(rect, 10, 20 + 48, 48)).toEqual([0, 1]);
  });

  test("points outside the canvas are rejected, including just past the last pixel", () => {
    expect(cellFromPoint(rect, 9, 20, 48)).toBeNull();
    expect(cellFromPoint(rect, 10, 19, 48)).toBeNull();
    // One pixel past the right edge and the bottom edge: still inside the rect arithmetic only if
    // the comparison used < instead of <=.
    expect(cellFromPoint(rect, 10 + 192, 20, 48)).toBeNull();
    expect(cellFromPoint(rect, 10, 20 + 144, 48)).toBeNull();
  });

  test("a nonsense tile size is refused rather than dividing by zero", () => {
    expect(cellFromPoint(rect, 50, 50, 0)).toBeNull();
    expect(cellFromPoint(rect, 50, 50, -48)).toBeNull();
  });
});

describe("applyDrop", () => {
  const base = {
    id: "loc_test",
    tilemap: ["#####", "#...#"],
    npcs: [
      { npc: "npc_ken", tile: [1, 1] as [number, number], facing: "left", wander: 3, requires: { flag: "a" } },
      { npc: "npc_wai", tile: [4, 0] as [number, number] },
    ],
  };

  test("dropping a tile paints that cell", () => {
    const next = applyDrop(base, { kind: "tile", char: "#" }, 2, 1);
    expect(next.tilemap).toEqual(["#####", "#.#.#"]);
    expect(next.npcs).toBe(base.npcs); // untouched arrays are shared, not copied
  });

  test("dropping the same tile returns the document by identity", () => {
    expect(applyDrop(base, { kind: "tile", char: "#" }, 0, 0)).toBe(base);
  });

  test("dropping an NPC on an empty cell adds a placement", () => {
    const next = applyDrop(base, { kind: "npc", npcId: "npc_tai" }, 3, 1);
    expect(selectedNpc(next.npcs!, 3, 1)?.npc).toBe("npc_tai");
  });

  test("dropping an NPC onto its own cell keeps its authored fields", () => {
    // Replacing it with a bare placement would silently wipe facing, wander and the condition.
    expect(applyDrop(base, { kind: "npc", npcId: "npc_ken" }, 1, 1)).toBe(base);
  });

  test("dropping a different NPC on an occupied cell replaces it", () => {
    const next = applyDrop(base, { kind: "npc", npcId: "npc_tai" }, 1, 1);
    expect(selectedNpc(next.npcs!, 1, 1)?.npc).toBe("npc_tai");
    expect(next.npcs).toHaveLength(2);
  });

  test("dragging a marker moves it and keeps its fields", () => {
    const next = applyDrop(base, { kind: "marker", index: 0 }, 2, 1);
    expect(selectedNpc(next.npcs!, 2, 1)).toMatchObject({ npc: "npc_ken", facing: "left", wander: 3 });
    expect(selectedNpc(next.npcs!, 1, 1)).toBeUndefined();
  });

  test("dragging a marker nowhere, or onto another marker, changes nothing", () => {
    expect(applyDrop(base, { kind: "marker", index: 0 }, 1, 1)).toBe(base);
    expect(applyDrop(base, { kind: "marker", index: 0 }, 4, 0)).toBe(base);
    expect(applyDrop(base, { kind: "marker", index: 9 }, 2, 1)).toBe(base);
  });

  test("a drop outside the grid is ignored", () => {
    expect(applyDrop(base, { kind: "tile", char: "." }, 9, 0)).toBe(base);
    expect(applyDrop(base, { kind: "tile", char: "." }, 0, 9)).toBe(base);
  });
});
