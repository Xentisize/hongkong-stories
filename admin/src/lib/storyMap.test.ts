import { describe, expect, test } from "bun:test";

import { layoutStory, sceneGraph } from "./storyMap";

/**
 * The story map's graph.
 *
 * A scene is a node, a door is an edge: what matters is that a gated door is distinguishable, a door
 * to nowhere is dropped rather than drawn to nothing, and a scene nobody can reach still appears.
 */

const locations = {
  loc_a: { id: "loc_a", title: { zh_HK: "街市", en: "Market" }, exits: [{ id: "door1", to: "loc_b" }] },
  loc_b: { id: "loc_b", exits: [{ id: "door2", to: "loc_c", requires: { has_item: "item_key" } }] },
  loc_c: { id: "loc_c", exits: [{ id: "dangling", to: "loc_missing" }] },
  loc_orphan: { id: "loc_orphan" },
};

describe("sceneGraph", () => {
  test("scenes become nodes, labelled by title when there is one", () => {
    const graph = sceneGraph(locations);
    expect(graph.nodes.find((node) => node.id === "loc_a")?.label).toBe("街市");
    expect(graph.nodes.find((node) => node.id === "loc_b")?.label).toBe("loc_b");
  });

  test("a door is an edge, and a gated door says so", () => {
    const graph = sceneGraph(locations);
    expect(graph.edges).toContainEqual({ from: "loc_a", to: "loc_b", id: "door1", gated: false });
    expect(graph.edges).toContainEqual({ from: "loc_b", to: "loc_c", id: "door2", gated: true });
  });

  test("a door to a scene that does not exist is dropped", () => {
    expect(sceneGraph(locations).edges.some((edge) => edge.to === "loc_missing")).toBe(false);
  });

  test("an empty pack is an empty map", () => {
    expect(sceneGraph(undefined)).toEqual({ nodes: [], edges: [] });
    expect(sceneGraph({})).toEqual({ nodes: [], edges: [] });
  });
});

describe("layoutStory", () => {
  test("columns follow the doors from the start scene", () => {
    const layout = layoutStory(sceneGraph(locations), "loc_a");
    const depth = (id: string) => layout.nodes.find((node) => node.id === id)?.depth;
    expect(depth("loc_a")).toBe(0);
    expect(depth("loc_b")).toBe(1);
    expect(depth("loc_c")).toBe(2);
  });

  test("a scene no door reaches is still drawn, on its own row", () => {
    const orphan = layoutStory(sceneGraph(locations), "loc_a").nodes.find((node) => node.id === "loc_orphan");
    expect(orphan?.reachable).toBe(false);
    expect(orphan?.row).toBe(1);
  });

  test("without a known start it begins at the first scene", () => {
    expect(layoutStory(sceneGraph(locations)).nodes.find((node) => node.depth === 0)?.row).toBe(0);
    expect(layoutStory({ nodes: [], edges: [] }).columns).toBe(1);
  });
});
