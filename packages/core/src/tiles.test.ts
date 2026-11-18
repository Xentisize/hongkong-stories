import { describe, expect, test } from "bun:test";

import {
  BASE_LAYER_ID,
  TRANSPARENT_TILE,
  layerTileAt,
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
