import { describe, expect, test } from "bun:test";

import {
  applyDrop,
  atlasUrl,
  blankLayer,
  blankMap,
  cellFromPoint,
  collisionGrid,
  fillLayerRect,
  fillRect,
  freeLayerId,
  gridToRects,
  growMap,
  legendEntries,
  mapSize,
  moveLayer,
  moveNpc,
  npcIndexAt,
  overlaysOf,
  paintCollision,
  paintLayer,
  paintTile,
  placeNpc,
  removeNpcAt,
  resizeLayers,
  selectedNpc,
  setCollisionRect,
  solidAt,
  tileAt,
  transformVariant,
  type CollisionRect,
  type MapNpc,
  type TileLayerDoc,
  type TileLegend,
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
    expect(entries[3]).toEqual({ char: "D", col: 3, row: 0, transform: null });
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

/** Solid cells as a comparable string, so coverage assertions read clearly. */
const solidCells = (grid: boolean[][]): string =>
  grid
    .flatMap((row, y) => row.map((solid, x) => (solid ? `${x},${y}` : "")))
    .filter(Boolean)
    .join(" ");

describe("collision", () => {

  test("rects rasterise into the grid", () => {
    // The border walls real locations use: a full top row plus a left column.
    const grid = collisionGrid([[0, 0, 4, 1], [0, 1, 1, 2]], 4, 3);
    expect(grid).toEqual([
      [true, true, true, true],
      [true, false, false, false],
      [true, false, false, false],
    ]);
  });

  test("out-of-bounds rects are clipped and malformed ones ignored", () => {
    const grid = collisionGrid(
      [
        [3, 2, 5, 5], // runs past the right and bottom edges → clipped to (3,2) and (3,3)
        [-1, -1, 2, 2], // straddles the origin → clipped to (0,0)
        [1, 1, 0, 1], // zero width → ignored
        null as unknown as CollisionRect, // not a rect → ignored
      ],
      4,
      4,
    );
    expect(solidCells(grid)).toBe("0,0 3,2 3,3");
  });

  test("a rect entirely in negative space covers nothing", () => {
    // [-2,-2,2,2] spans x from -2 to 0 exclusive, so no cell of the map is inside it.
    expect(solidCells(collisionGrid([[-2, -2, 2, 2]], 4, 4))).toBe("");
  });

  test("solidAt answers for a single cell, including overlaps", () => {
    const rects: CollisionRect[] = [[0, 0, 2, 1], [1, 0, 2, 2]];
    expect(solidAt(rects, 0, 0)).toBe(true);
    expect(solidAt(rects, 2, 1)).toBe(true); // only the second rect covers this
    expect(solidAt(rects, 3, 1)).toBe(false);
    expect(solidAt(undefined, 0, 0)).toBe(false);
  });

  test("decomposition keeps simple shapes whole", () => {
    expect(gridToRects([[true]])).toEqual([[0, 0, 1, 1]]);
    expect(gridToRects([[true, true, true]])).toEqual([[0, 0, 3, 1]]);
    expect(
      gridToRects([
        [true, true],
        [true, true],
      ]),
    ).toEqual([[0, 0, 2, 2]]);
    expect(gridToRects([[false, false]])).toEqual([]);
    expect(gridToRects([])).toEqual([]);
  });

  test("an L shape becomes two rects", () => {
    const rects = gridToRects([
      [true, true, false],
      [true, false, false],
      [false, false, false],
    ]);
    expect(rects).toEqual([[0, 0, 2, 1], [0, 1, 1, 1]]);
  });

  test("a ring with a hole covers exactly the solid cells", () => {
    const grid = [
      [true, true, true],
      [true, false, true],
      [true, true, true],
    ];
    const rects = gridToRects(grid);
    // Rebuilding from the rects must reproduce the same cells — the rect list itself is an
    // implementation detail, the coverage is the contract.
    expect(solidCells(collisionGrid(rects, 3, 3))).toBe(solidCells(grid));
    expect(rects.length).toBeLessThanOrEqual(4);
  });

  test("painting a cell adds it, and painting it again changes nothing", () => {
    const added = paintCollision([], 2, 1, true, 4, 3);
    expect(added).toEqual([[2, 1, 1, 1]]);
    expect(paintCollision(added, 2, 1, true, 4, 3)).toBe(added);
  });

  test("erasing splits a run and leaves the neighbours solid", () => {
    const wall: CollisionRect[] = [[0, 0, 5, 1]];
    const holed = paintCollision(wall, 2, 0, false, 5, 1);
    expect(solidCells(collisionGrid(holed, 5, 1))).toBe("0,0 1,0 3,0 4,0");
    // The middle cell is now walkable — this is the whole point of the feature.
    expect(solidAt(holed, 2, 0)).toBe(false);
  });

  test("painting then erasing a cell restores the same coverage", () => {
    const original: CollisionRect[] = [[0, 0, 4, 1], [0, 1, 1, 3]];
    const painted = paintCollision(original, 2, 2, true, 4, 4);
    const erased = paintCollision(painted, 2, 2, false, 4, 4);
    expect(solidCells(collisionGrid(erased, 4, 4))).toBe(solidCells(collisionGrid(original, 4, 4)));
  });

  test("edits outside the map are ignored by identity", () => {
    const rects: CollisionRect[] = [[0, 0, 1, 1]];
    expect(paintCollision(rects, -1, 0, true, 4, 4)).toBe(rects);
    expect(paintCollision(rects, 4, 0, true, 4, 4)).toBe(rects);
    expect(paintCollision(rects, 0, 4, true, 4, 4)).toBe(rects);
  });
});

describe("rectangle tools", () => {
  const map = ["....", "....", "...."];

  test("fillRect fills the dragged rectangle and nothing else", () => {
    expect(fillRect(map, 1, 0, 2, 1, "#")).toEqual([".##.", ".##.", "...."]);
  });

  test("dragging backwards fills the same rectangle", () => {
    expect(fillRect(map, 2, 1, 1, 0, "#")).toEqual(fillRect(map, 1, 0, 2, 1, "#"));
  });

  test("a rectangle already filled returns the map by identity", () => {
    const filled = ["####", "####", "...."];
    expect(fillRect(filled, 0, 0, 3, 1, "#")).toBe(filled);
  });

  test("a rectangle that runs past the edge is clipped, not extended", () => {
    expect(fillRect(map, 3, 2, 9, 9, "#")).toEqual(["....", "....", "...#"]);
  });

  test("a drag entirely off the map changes nothing", () => {
    // Clamping this to the edge would silently fill a column the author never pointed at.
    expect(fillRect(map, -5, -5, -1, -1, "#")).toBe(map);
    expect(fillRect(map, 10, 0, 20, 2, "#")).toBe(map);
  });

  test("ragged rows are not extended past their own length", () => {
    const ragged = ["....", ".."];
    expect(fillRect(ragged, 0, 0, 3, 1, "#")).toEqual(["####", "##"]);
  });

  test("setCollisionRect marks a block solid and keeps it rectangular", () => {
    const rects = setCollisionRect([], 1, 1, 2, 2, true, 4, 4);
    expect(rects).toEqual([[1, 1, 2, 2]]);
  });

  test("setCollisionRect erases and the neighbours stay solid", () => {
    const wall: CollisionRect[] = [[0, 0, 4, 1]];
    const holed = setCollisionRect(wall, 1, 0, 2, 0, false, 4, 1);
    expect(solidCells(collisionGrid(holed, 4, 1))).toBe("0,0 3,0");
  });

  test("a collision rectangle that changes nothing returns the input by identity", () => {
    const wall: CollisionRect[] = [[0, 0, 4, 1]];
    expect(setCollisionRect(wall, 0, 0, 3, 0, true, 4, 4)).toBe(wall);
    expect(setCollisionRect(wall, 8, 8, 9, 9, true, 4, 4)).toBe(wall);
  });
});

describe("legend transforms", () => {
  const legend: TileLegend = { ".": [0, 0], "#": [2, 0] };

  test("entries read the transform when the frame has one", () => {
    expect(legendEntries({ ".": [0, 0], r: [2, 0, "rot90"] })).toEqual([
      { char: ".", col: 0, row: 0, transform: null },
      { char: "r", col: 2, row: 0, transform: "rot90" },
    ]);
  });

  test("a malformed frame is skipped rather than painted as tile zero", () => {
    expect(legendEntries({ ".": [0, 0], bad: [1] as never })).toEqual([
      { char: ".", col: 0, row: 0, transform: null },
    ]);
  });

  test("the first variant mints a new character and keeps the frame", () => {
    const next = transformVariant(legend, "#", "rot90");
    expect(next).not.toBeNull();
    expect(next!.char).toBe("a");
    expect(next!.legend["a"]).toEqual([2, 0, "rot90"]);
    expect(next!.legend["#"]).toEqual([2, 0]);
  });

  test("a second request for the same variant reuses it instead of growing the legend", () => {
    const first = transformVariant(legend, "#", "rot90")!;
    const second = transformVariant(first.legend, "#", "rot90")!;
    expect(second.char).toBe(first.char);
    expect(second.legend).toBe(first.legend); // same object: nothing was minted
  });

  test("a different transform mints a different character", () => {
    const rotated = transformVariant(legend, "#", "rot90")!;
    const flipped = transformVariant(rotated.legend, "#", "flipX")!;
    expect(flipped.char).not.toBe(rotated.char);
    expect(flipped.legend[flipped.char]).toEqual([2, 0, "flipX"]);
  });

  test("an unknown character has no variant to make", () => {
    expect(transformVariant(legend, "?", "rot90")).toBeNull();
  });
});

describe("layers", () => {
  const layer = (id: string, tilemap: string[]): TileLayerDoc => ({ id, tilemap });

  test("overlays are read as authored, malformed entries dropped", () => {
    expect(
      overlaysOf([
        { id: "props", tilemap: ["x "] },
        { id: "", tilemap: ["x"] },
        { id: "no-grid" },
        null,
        { id: "roof", tilemap: [" #"] },
      ]),
    ).toEqual([layer("props", ["x "]), layer("roof", [" #"])]);
    expect(overlaysOf(undefined)).toEqual([]);
  });

  test("painting writes into the active overlay and leaves the others shared", () => {
    const layers = [layer("props", ["  "]), layer("roof", ["  "])];
    const next = paintLayer(layers, 1, 0, 0, "#");
    expect(next[1]?.tilemap).toEqual(["# "]);
    expect(next[0]).toBe(layers[0]);
    expect(layers[1]?.tilemap).toEqual(["  "]); // source untouched
  });

  test("painting the same character back is a no-op by identity", () => {
    const layers = [layer("props", ["x "])];
    expect(paintLayer(layers, 0, 0, 0, "x")).toBe(layers);
    expect(paintLayer(layers, 5, 0, 0, "#")).toBe(layers); // no such layer
  });

  test("rect fill targets one overlay", () => {
    const layers = [layer("props", ["  ", "  "])];
    expect(fillLayerRect(layers, 0, 0, 0, 1, 1, "#")[0]?.tilemap).toEqual(["##", "##"]);
    expect(fillLayerRect(layers, 0, 0, 0, 0, 0, " ")).toBe(layers); // already transparent
  });

  test("a new overlay is transparent everywhere", () => {
    expect(blankLayer("props", 3, 2)).toEqual({ id: "props", tilemap: ["   ", "   "] });
  });

  test("layer ids are allocated around the ones in use", () => {
    expect(freeLayerId([])).toBe("layer_1");
    expect(freeLayerId([layer("layer_1", []), layer("layer_3", [])])).toBe("layer_2");
  });

  test("resizing pads overlays with transparency, and only when needed", () => {
    const small = [layer("props", ["x"])];
    expect(resizeLayers(small, 3, 2)[0]?.tilemap).toEqual(["x  ", "   "]);

    const big = [layer("props", ["xxx", "xxx"])];
    expect(resizeLayers(big, 3, 2)).toBe(big);
  });

  test("moving a layer swaps the draw order and ignores out-of-range moves", () => {
    const layers = [layer("a", [" "]), layer("b", [" "])];
    expect(moveLayer(layers, 1, -1).map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(moveLayer(layers, 0, -1)).toBe(layers);
    expect(moveLayer(layers, 1, 1)).toBe(layers);
  });
});
