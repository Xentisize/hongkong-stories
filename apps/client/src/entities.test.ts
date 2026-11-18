import { describe, expect, test } from "bun:test";

import type { LocationFile } from "./content";
import {
  decorPlacements,
  doorPlacements,
  exitAt,
  exitZones,
  facingBetween,
  interactablePlacements,
  openDoorTiles,
  pickWanderTarget,
} from "./entities";

/**
 * Content → geometry.
 *
 * These are the decisions `location_root.gd`, `door.gd` and `exit_zone.gd` make, moved somewhere a
 * test can see them: a blocker spanning the union of a door's tiles, an exit area sitting on its
 * rect's centre, and a wander step that stays inside its radius or not at all.
 */

const LOCATION: LocationFile = {
  id: "loc_test",
  display_name: { zh_HK: "街", zh_CN: "街", en: "Street" },
  tile_size: 24,
  atlas: "res://assets/tiles/p1_tiles_2027.png",
  legend: { ".": [0, 0], "#": [2, 0], "D": [3, 0] },
  tilemap: [".......", "..DD...", "......."],
  collision: [],
  spawn_points: { default: [1, 1] },
};

describe("decor", () => {
  test("resolves art to a file name and a tile centre", () => {
    const placements = decorPlacements({
      ...LOCATION,
      decor: [{ art: "art/props/prop_lantern.png", tile: [2, 2] }],
    });

    expect(placements).toEqual([
      { art: "art/props/prop_lantern.png", file: "prop_lantern.png", point: { x: 60, y: 60 } },
    ]);
  });

  test("an entry with no art is skipped rather than drawn as nothing", () => {
    expect(decorPlacements({ ...LOCATION, decor: [{ art: "", tile: [1, 1] }] })).toEqual([]);
  });
});

describe("exit zones", () => {
  test("sits on the rect's centre with pixel extents", () => {
    const [zone] = exitZones({
      ...LOCATION,
      exits: [
        {
          id: "to_flat",
          rect: [0, 6, 1, 3],
          to: "loc_ssp_flat",
          requires: { has_item: "item_flat_key" },
          blocked: { zh_HK: "鎖咗", zh_CN: "锁了", en: "Locked" },
        },
      ],
    });

    expect(zone).toMatchObject({
      id: "to_flat",
      to: "loc_ssp_flat",
      spawn: "default",
      left: 0,
      top: 144,
      width: 24,
      height: 72,
    });
    expect(zone?.centre).toEqual({ x: 12, y: 180 });
  });

  test("a degenerate rect is ignored", () => {
    const zones = exitZones({
      ...LOCATION,
      exits: [{ id: "bad", rect: [0, 0, 0, 2], to: "nowhere" }],
    });
    expect(zones).toEqual([]);
  });

  test("finds the zone under a position, with exclusive edges", () => {
    const zones = exitZones({
      ...LOCATION,
      exits: [{ id: "east", rect: [27, 6, 1, 3], to: "loc_cct" }],
    });

    expect(exitAt(zones, 27 * 24 + 1, 6 * 24 + 1)?.id).toBe("east");
    expect(exitAt(zones, 27 * 24, 9 * 24)).toBeNull(); // bottom edge is outside
    expect(exitAt(zones, 28 * 24, 7 * 24)).toBeNull(); // right edge is outside
  });
});

describe("interactables", () => {
  test("defaults scale to 1 and keeps what a prompt needs", () => {
    const [sign] = interactablePlacements({
      ...LOCATION,
      interactables: [
        {
          id: "shop_sign",
          tile: [16, 12],
          art: "art/props/prop_shop_signboard.png",
          once: true,
          prompt: { zh_HK: "執起", zh_CN: "捡起", en: "Pick up" },
          on_interact: [{ type: "give", item: "item_plate" }],
        },
      ],
    });

    expect(sign).toMatchObject({
      id: "shop_sign",
      file: "prop_shop_signboard.png",
      scale: 1,
      once: true,
      effects: [{ type: "give", item: "item_plate" }],
    });
    expect(sign?.prompt?.zh_HK).toBe("執起");
  });

  test("an explicit scale is honoured", () => {
    const [prop] = interactablePlacements({
      ...LOCATION,
      interactables: [{ id: "p", tile: [1, 1], scale: 0.8 }],
    });
    expect(prop?.scale).toBe(0.8);
  });
});

describe("doors", () => {
  test("a blocker spans the union of the door's tiles", () => {
    const [door] = doorPlacements({
      ...LOCATION,
      doors: [
        {
          id: "shop_door",
          tiles: [
            [9, 11],
            [10, 11],
          ],
          open_flag: "door_open",
          requires: { any: [{ flag: "door_open" }] },
        },
      ],
    });

    expect(door?.bounds).toEqual({ x: 9, y: 11, width: 2, height: 1 });
    expect(door?.centre).toEqual({ x: 240, y: 276 }); // (9 + 2/2) * 24, (11 + 1/2) * 24
    expect(door?.openFlag).toBe("door_open");
  });

  test("a door with no tiles is dropped", () => {
    expect(doorPlacements({ ...LOCATION, doors: [{ id: "d", tiles: [] }] })).toEqual([]);
  });

  test("a non-contiguous door still gets one covering blocker", () => {
    const [door] = doorPlacements({
      ...LOCATION,
      doors: [
        {
          id: "arch",
          tiles: [
            [2, 2],
            [4, 2],
            [2, 4],
          ],
        },
      ],
    });
    expect(door?.bounds).toEqual({ x: 2, y: 2, width: 3, height: 3 });
  });
});

describe("opening a door", () => {
  test("swaps exactly the door's cells for floor", () => {
    const opened = openDoorTiles(LOCATION.tilemap, [[2, 1], [3, 1]], ".");
    expect(opened).toEqual([".......", ".......", "......."]);
  });

  test("returns the same map when it is already floor", () => {
    const tilemap = ["..#", "###"];
    expect(openDoorTiles(tilemap, [[0, 0]], ".")).toBe(tilemap);
    expect(openDoorTiles(tilemap, [[2, 0]], ".")).not.toBe(tilemap);
  });

  test("ignores tiles outside the map instead of growing a row", () => {
    const tilemap = ["##"];
    const opened = openDoorTiles(tilemap, [[9, 0], [0, 9]], ".");
    expect(opened).toBe(tilemap);
  });
});

describe("wander", () => {
  const anywhere = () => true;

  test("a fixture with radius 0 never moves", () => {
    expect(pickWanderTarget([5, 5], 0, anywhere)).toBeNull();
  });

  test("picks a tile inside the radius", () => {
    // rand() pinned: floor(0.9 * 5) - 2 = 2 in both axes → (7, 7) from home (5, 5).
    const target = pickWanderTarget([5, 5], 2, anywhere, () => 0.9);
    expect(target).toEqual([7, 7]);
  });

  test("skips the tile it is standing on", () => {
    // 0.5 maps to floor(0.5 * 5) - 2 = 0 — the home tile — so the attempt is abandoned.
    expect(pickWanderTarget([5, 5], 2, anywhere, () => 0.5, 1)).toBeNull();
  });

  test("gives up rather than walking into a wall", () => {
    const wallsOnly = () => false;
    expect(pickWanderTarget([5, 5], 3, wallsOnly, () => 0.9)).toBeNull();
  });

  test("takes the first attempt that is walkable", () => {
    const onlyFirst = (_x: number, _y: number) => _x === 7 && _y === 7;
    expect(pickWanderTarget([5, 5], 2, onlyFirst, () => 0.9)).toEqual([7, 7]);
  });
});

describe("facing", () => {
  test("the dominant axis wins, and a tie goes vertical", () => {
    const origin = { x: 0, y: 0 };
    expect(facingBetween(origin, { x: 10, y: 4 })).toBe("right");
    expect(facingBetween(origin, { x: -10, y: 4 })).toBe("left");
    expect(facingBetween(origin, { x: 2, y: 10 })).toBe("down");
    expect(facingBetween(origin, { x: 2, y: -10 })).toBe("up");
    // Equal magnitudes fall through to the vertical branch, exactly like `_direction_name`.
    expect(facingBetween(origin, { x: 7, y: 7 })).toBe("down");
    expect(facingBetween(origin, { x: 7, y: -7 })).toBe("up");
  });
});
