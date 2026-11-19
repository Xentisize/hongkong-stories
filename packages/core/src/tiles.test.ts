import { describe, expect, test } from "bun:test";

import {
  BASE_LAYER_ID,
  TILE_TRANSFORMS,
  TILE_TRANSFORM_FLIPS,
  TILE_TRANSFORM_QUARTER_TURNS,
  TILE_TRANSFORM_TRANSPOSE,
  TRANSPARENT_TILE,
  atlasCellSize,
  layerTileAt,
  legendFrame,
  tileLayers,
  type TileLayer,
} from "./tiles";
import { packFromEntries, validatePack } from "./validate";

/**
 * Tile layers.
 *
 * Two properties matter and both are asserted here. **Compatibility**: a document that predates the
 * field has exactly one layer and validates unchanged. **Alignment**: an overlay that is a row short
 * or a column narrow is refused, because the failure it causes at runtime is a silent shift that
 * looks like bad art rather than bad data.
 */

const layer = (id: string, tilemap: string[]): TileLayer => ({ id, tilemap, overlay: true });

describe("tileLayers", () => {
  test("a document without overlays has exactly the base layer", () => {
    expect(tileLayers({ tilemap: ["##", ".."] })).toEqual([
      { id: BASE_LAYER_ID, tilemap: ["##", ".."], overlay: false },
    ]);
  });

  test("overlays follow the base, in authored order", () => {
    const layers = tileLayers({
      tilemap: [".."],
      layers: [
        { id: "props", tilemap: ["x "] },
        { id: "roof", tilemap: [" #"] },
      ],
    });
    expect(layers.map((entry) => entry.id)).toEqual([BASE_LAYER_ID, "props", "roof"]);
    expect(layers.every((entry) => entry.overlay === (entry.id !== BASE_LAYER_ID))).toBe(true);
  });

  test("malformed overlays are skipped, not half-read", () => {
    const layers = tileLayers({
      tilemap: ["."],
      layers: [
        { id: "", tilemap: ["x"] }, // no id
        { id: "empty", tilemap: [] }, // nothing to draw
        { id: "rows", tilemap: "not-a-list" },
        null,
        { id: "ok", tilemap: ["x"] },
      ],
    });
    expect(layers.map((entry) => entry.id)).toEqual([BASE_LAYER_ID, "ok"]);
  });

  test("anything that is not a location has no layers", () => {
    expect(tileLayers(null)).toEqual([]);
    expect(tileLayers("loc")).toEqual([]);
  });
});

describe("layerTileAt", () => {
  const base: TileLayer = { id: "base", tilemap: ["#."], overlay: false };

  test("the base layer reads its characters directly", () => {
    expect(layerTileAt(base, 0, 0)).toBe("#");
    expect(layerTileAt(base, 1, 0)).toBe(".");
  });

  test("a space in an overlay is transparency, not a tile", () => {
    expect(layerTileAt(layer("props", [" x"]), 0, 0)).toBeUndefined();
    expect(layerTileAt(layer("props", [" x"]), 1, 0)).toBe("x");
  });

  test("a space in the base is a hole the author wrote, so it is returned", () => {
    expect(layerTileAt({ id: "base", tilemap: [" ."], overlay: false }, 0, 0)).toBe(" ");
    expect(TRANSPARENT_TILE).toBe(" ");
  });

  test("outside the layer is undefined, ragged rows included", () => {
    expect(layerTileAt(base, 9, 0)).toBeUndefined();
    expect(layerTileAt(base, 0, 9)).toBeUndefined();
  });
});

/* ---------- validation ---------- */

const LOCATION = {
  schema_version: 1,
  id: "loc_test",
  display_name: { zh_HK: "測試", zh_CN: "测试", en: "Test" },
  tile_size: 24,
  atlas: "res://assets/tiles/p1_tiles.png",
  legend: { ".": [0, 0], "#": [1, 0], x: [2, 0] },
  tilemap: ["....", "....", "...."],
  collision: [],
  spawn_points: { default: [1.5, 1.5] },
};

function issuesFor(extra: Record<string, unknown>) {
  const pack = packFromEntries({ "locations/loc_test.json": { ...LOCATION, ...extra } });
  return validatePack(pack).filter((issue) => issue.path.startsWith("locations/loc_test"));
}

describe("layer validation", () => {
  test("a document with no overlays validates as before", () => {
    expect(issuesFor({})).toEqual([]);
  });

  test("a well-formed overlay validates", () => {
    expect(issuesFor({ layers: [{ id: "props", tilemap: ["    ", " x  ", "   x"] }] })).toEqual([]);
  });

  test("a space paints nothing and is not an unknown character", () => {
    expect(issuesFor({ layers: [{ id: "empty", tilemap: ["    ", "    ", "    "] }] })).toEqual([]);
  });

  test("an overlay one row short is refused — it would shift every tile below", () => {
    const issues = issuesFor({ layers: [{ id: "props", tilemap: ["    ", " x  "] }] });
    expect(issues).toEqual([
      {
        level: "error",
        path: "locations/loc_test.layers/props.tilemap",
        message: "layer has 2 row(s) but the map has 3 — an overlay must cover the whole map",
      },
    ]);
  });

  test("a narrow row is refused with the width it should be", () => {
    const issues = issuesFor({ layers: [{ id: "props", tilemap: ["    ", " x ", "    "] }] });
    expect(issues[0]?.message).toBe("row 1 is 3 character(s), the map is 4 wide");
  });

  test("two overlays cannot share an id", () => {
    const issues = issuesFor({
      layers: [
        { id: "props", tilemap: ["    ", "    ", "    "] },
        { id: "props", tilemap: ["    ", "    ", "    "] },
      ],
    });
    expect(issues.some((issue) => issue.message.includes("duplicate layer id 'props'"))).toBe(true);
  });

  test("an overlay without an id is refused", () => {
    expect(issuesFor({ layers: [{ tilemap: ["    ", "    ", "    "] }] })[0]?.message).toBe(
      "layer 0 needs an id",
    );
  });

  test("a character that is not in the legend is reported, and does not block", () => {
    const issues = issuesFor({ layers: [{ id: "props", tilemap: ["    ", " q  ", "    "] }] });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.level).toBe("warn");
    expect(issues[0]?.message).toContain("'q' is not in legend");
  });

  test("layers must be a list", () => {
    expect(issuesFor({ layers: { id: "props" } })[0]?.message).toBe(
      "layers must be a list of {id, tilemap}",
    );
  });

  test("a layer whose tilemap is not a list of rows is refused", () => {
    expect(issuesFor({ layers: [{ id: "props", tilemap: "...." }] })[0]?.message).toBe(
      "tilemap must be a list of rows",
    );
  });
});

describe("legend frames and transforms", () => {
  test("reads a plain frame", () => {
    expect(legendFrame([2, 0])).toEqual({ col: 2, row: 0, transform: null });
  });

  test("reads a transform on the frame", () => {
    expect(legendFrame([2, 0, "rot90"])).toEqual({ col: 2, row: 0, transform: "rot90" });
    expect(legendFrame([0, 1, "flipX"])).toEqual({ col: 0, row: 1, transform: "flipX" });
  });

  test("anything that is not a frame is nothing", () => {
    expect(legendFrame([2])).toBeNull();
    expect(legendFrame(["2", 0])).toBeNull();
    expect(legendFrame("x")).toBeNull();
    expect(legendFrame(undefined)).toBeNull();
  });

  test("a frame with a transform validates", () => {
    expect(issuesFor({ legend: { ".": [0, 0], "#": [2, 0], r: [2, 0, "rot90"] } })).toEqual([]);
  });

  test("every offered transform is accepted by the validator", () => {
    for (const transform of TILE_TRANSFORMS) {
      expect(issuesFor({ legend: { ".": [0, 0], x: [1, 1, transform] } })).toEqual([]);
    }
  });

  test("an unknown transform is refused, naming the ones that exist", () => {
    const issues = issuesFor({ legend: { ".": [0, 0], x: [1, 1, "rot45"] } });
    expect(issues[0]?.path).toBe("locations/loc_test.legend/x");
    expect(issues[0]?.message).toContain("unknown transform 'rot45'");
    expect(issues[0]?.message).toContain("rot90");
  });

  test("a frame that is not two or three entries is refused", () => {
    expect(issuesFor({ legend: { x: [1] } })[0]?.message).toBe(
      "a frame is [col, row] or [col, row, transform]",
    );
    expect(issuesFor({ legend: { x: [1, 1, "rot90", "extra"] } })).toHaveLength(1);
  });

  test("non-integer coordinates are refused", () => {
    expect(issuesFor({ legend: { x: [1.5, 1] } })[0]?.message).toBe(
      "col and row must be whole numbers",
    );
  });
});

describe("atlasCellSize", () => {
  test("derives the cell from the image and the legend's columns", () => {
    expect(atlasCellSize(384, 8)).toBe(48);
    expect(atlasCellSize(96, 4)).toBe(24);
  });

  test("a redraw at 2x detail raises the cell without any document change", () => {
    // The same four columns: 96px wide was 24px cells, 192px wide is 48px cells.
    expect(atlasCellSize(192, 4)).toBe(48);
  });

  test("nonsense reads as zero, so a caller falls back to the world tile size", () => {
    expect(atlasCellSize(0, 4)).toBe(0);
    expect(atlasCellSize(96, 0)).toBe(0);
    expect(atlasCellSize(Number.NaN, 4)).toBe(0);
  });
});

describe("the renderer mapping tables", () => {
  test("every transform is described for both clients", () => {
    for (const transform of TILE_TRANSFORMS) {
      expect(TILE_TRANSFORM_QUARTER_TURNS[transform]).toBeGreaterThanOrEqual(0);
      expect(TILE_TRANSFORM_QUARTER_TURNS[transform]).toBeLessThanOrEqual(3);
      expect(TILE_TRANSFORM_FLIPS[transform]).toBeDefined();
      expect(TILE_TRANSFORM_TRANSPOSE[transform]).toBeDefined();
    }
  });

  test("rotations carry the flips that make the quarter turn the right way round", () => {
    // Godot composes transpose + flips; the web client rotates. These pairs are the contract the
    // GDScript mirrors, so they are pinned rather than left to inspection.
    expect(TILE_TRANSFORM_TRANSPOSE.rot90).toEqual({ transpose: true, flipX: true, flipY: false });
    expect(TILE_TRANSFORM_TRANSPOSE.rot180).toEqual({ transpose: false, flipX: true, flipY: true });
    expect(TILE_TRANSFORM_TRANSPOSE.rot270).toEqual({ transpose: true, flipX: false, flipY: true });
    expect(TILE_TRANSFORM_FLIPS.rot90).toEqual({ x: false, y: false });
  });

  test("plain flips are flips in both vocabularies", () => {
    expect(TILE_TRANSFORM_QUARTER_TURNS.flipX).toBe(0);
    expect(TILE_TRANSFORM_QUARTER_TURNS.flipY).toBe(0);
    expect(TILE_TRANSFORM_QUARTER_TURNS.flipXY).toBe(0);
    expect(TILE_TRANSFORM_TRANSPOSE.flipX).toEqual({ transpose: false, flipX: true, flipY: false });
    expect(TILE_TRANSFORM_TRANSPOSE.flipXY).toEqual({ transpose: false, flipX: true, flipY: true });
  });
});
