import { describe, expect, test } from "bun:test";

import { legendColumns, tileIndexGrid, tileIndexGrids, type LocationFile } from "./content";

/**
 * Layer resolution for the renderer.
 *
 * Two things are being pinned down. The base grid keeps resolving exactly as it did before layers
 * existed — that is the compatibility promise for every document already authored. And `-1` means
 * "draw nothing", whether it comes from an unknown character (a typo the author should see as a
 * hole) or from a space in an overlay (deliberate transparency).
 */

const location = (extra: Partial<LocationFile> = {}): LocationFile => ({
  id: "loc_test",
  display_name: { zh_HK: "測試", zh_CN: "测试", en: "Test" },
  tile_size: 24,
  atlas: "res://assets/tiles/p1_tiles.png",
  legend: { ".": [0, 0], "#": [1, 0], x: [2, 0] },
  tilemap: [".#", ".."],
  collision: [],
  spawn_points: {},
  ...extra,
});

describe("tileIndexGrids", () => {
  test("a single-layer document yields one grid, indexed the same way as before", () => {
    const grids = tileIndexGrids(location());
    expect(grids).toHaveLength(1);
    // Three atlas columns (legend's widest is column 2), so index = row * 3 + column.
    expect(grids[0]).toEqual([
      [0, 1],
      [0, 0],
    ]);
  });

  test("overlays follow the base grid in authored order", () => {
    const grids = tileIndexGrids(
      location({
        layers: [
          { id: "props", tilemap: ["x ", " x"] },
          { id: "roof", tilemap: [" #", "  "] },
        ],
      }),
    );

    expect(grids).toHaveLength(3);
    expect(grids[1]).toEqual([
      [2, -1],
      [-1, 2],
    ]);
    expect(grids[2]).toEqual([
      [-1, 1],
      [-1, -1],
    ]);
  });

  test("a space paints nothing in an overlay, and an unknown character paints nothing anywhere", () => {
    const grids = tileIndexGrids(location({ tilemap: [".?", ".."], layers: [{ id: "a", tilemap: ["  ", "  "] }] }));
    expect(grids[0]?.[0]).toEqual([0, -1]); // '?' is not in the legend
    expect(grids[1]).toEqual([
      [-1, -1],
      [-1, -1],
    ]);
  });

  test("a malformed layer is skipped rather than half-read", () => {
    const grids = tileIndexGrids(
      location({
        layers: [null as never, { id: "no-grid" }, { id: "ok", tilemap: ["x ", ".."] }],
      }),
    );
    expect(grids).toHaveLength(2);
  });

  test("ragged rows are read as far as they go", () => {
    const grids = tileIndexGrids(location({ tilemap: [".#", "."] }));
    expect(grids[0]).toEqual([
      [0, 1],
      [0],
    ]);
  });

  test("the legend's width, not a hard-coded four, decides the row stride", () => {
    expect(legendColumns(location())).toBe(3);
  });
});

describe("tileIndexGrid", () => {
  test("is the base grid alone — what doors swap cells on", () => {
    const doc = location({ layers: [{ id: "props", tilemap: ["x ", " x"] }] });
    expect(tileIndexGrid(doc)).toEqual(tileIndexGrids(doc)[0]!);
  });
});
