import { describe, expect, test } from "bun:test";

import { layoutQuest, moveAfter, questEdges, questHead, reconnect, wouldCycle } from "./questFlow";
import type { QuestDoc } from "./questDoc";

/**
 * Flow-view graph maths.
 *
 * The gestures are only honest if these hold: the layout follows `next` rather than the array
 * order, an unreachable node still shows up, a reconnect cannot close a loop, and a drag rewires
 * the chain it visually reorders.
 */

function quest(nodes: Array<{ id: string; next?: string | null }>): QuestDoc {
  return {
    schema_version: 1,
    id: "q",
    nodes: nodes.map((node) => ({ id: node.id, type: "objective", text: {}, next: node.next ?? null })),
  };
}

describe("edges and head", () => {
  test("links come from next, not from the array order", () => {
    const doc = quest([
      { id: "n1", next: "n3" },
      { id: "n2", next: "n1" },
      { id: "n3" },
    ]);
    expect(questEdges(doc)).toEqual([
      { from: "n1", to: "n3" },
      { from: "n2", to: "n1" },
    ]);
    expect(questHead(doc)).toBe("n2");
  });

  test("a dangling next is not drawn", () => {
    const doc = quest([{ id: "n1", next: "n9" }]);
    expect(questEdges(doc)).toEqual([]);
    expect(questHead(doc)).toBe("n1");
  });
});

describe("layoutQuest", () => {
  test("columns follow the chain from the head", () => {
    const doc = quest([
      { id: "n2", next: "n3" },
      { id: "n1", next: "n2" },
      { id: "n3" },
    ]);
    const layout = layoutQuest(doc);
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    expect(byId.get("n1")?.depth).toBe(0);
    expect(byId.get("n2")?.depth).toBe(1);
    expect(byId.get("n3")?.depth).toBe(2);
    expect(layout.columns).toBe(3);
  });

  test("a node the chain cannot reach is still drawn, on its own row", () => {
    const doc = quest([
      { id: "n1", next: null },
      { id: "orphan", next: null },
    ]);
    const layout = layoutQuest(doc);
    const orphan = layout.nodes.find((node) => node.id === "orphan");
    expect(orphan?.reachable).toBe(false);
    expect(orphan?.row).toBe(1);
  });

  test("a loop lays out once and stops instead of spinning", () => {
    const doc = quest([
      { id: "n1", next: "n2" },
      { id: "n2", next: "n1" },
    ]);
    const layout = layoutQuest(doc);
    expect(layout.nodes).toHaveLength(2);
  });

  test("an empty quest has nothing to draw", () => {
    expect(layoutQuest({ nodes: [] }).nodes).toEqual([]);
    expect(layoutQuest({}).columns).toBe(1);
  });
});

describe("wouldCycle", () => {
  const chain = quest([
    { id: "n1", next: "n2" },
    { id: "n2", next: "n3" },
    { id: "n3" },
  ]);

  test("linking back up the chain is a cycle", () => {
    expect(wouldCycle(chain, "n3", "n1")).toBe(true);
  });

  test("re-stating an existing forward link is not a cycle", () => {
    expect(wouldCycle(chain, "n2", "n3")).toBe(false);
  });

  test("linking to itself is a cycle", () => {
    expect(wouldCycle(chain, "n2", "n2")).toBe(true);
  });

  test("a forward link that ends the walk is fine", () => {
    expect(wouldCycle(chain, "n1", "n3")).toBe(false);
  });
});

describe("reconnect", () => {
  const chain = quest([
    { id: "n1", next: "n2" },
    { id: "n2", next: "n3" },
    { id: "n3" },
  ]);

  test("sets the link and leaves the rest untouched", () => {
    const next = reconnect(chain, "n1", "n3");
    expect(next?.nodes?.[0]?.next).toBe("n3");
    expect(next?.nodes?.[1]?.next).toBe("n3");
  });

  test("null ends the chain at that node", () => {
    expect(reconnect(chain, "n2", null)?.nodes?.[1]?.next).toBeNull();
  });

  test("refuses a cycle, an unknown node, and self-links", () => {
    expect(reconnect(chain, "n3", "n1")).toBeNull();
    expect(reconnect(chain, "n1", "n9")).toBeNull();
    expect(reconnect(chain, "n9", "n1")).toBeNull();
    expect(reconnect(chain, "n1", "n1")).toBeNull();
  });

  test("does not mutate the document it was given", () => {
    reconnect(chain, "n1", "n3");
    expect(chain.nodes?.[0]?.next).toBe("n2");
  });
});

describe("moveAfter", () => {
  test("dragging a node after another rewires the chain to the visible order", () => {
    const doc = quest([
      { id: "n1", next: "n2" },
      { id: "n2", next: "n3" },
      { id: "n3" },
    ]);
    const next = moveAfter(doc, "n3", "n1");
    expect(next?.nodes?.map((node) => node.id)).toEqual(["n1", "n3", "n2"]);
    expect(next?.nodes?.map((node) => node.next)).toEqual(["n3", "n2", null]);
  });

  test("moving forward lands after the target as well", () => {
    const doc = quest([
      { id: "n1", next: "n2" },
      { id: "n2", next: "n3" },
      { id: "n3" },
    ]);
    const next = moveAfter(doc, "n1", "n2");
    expect(next?.nodes?.map((node) => node.id)).toEqual(["n2", "n1", "n3"]);
    expect(next?.nodes?.map((node) => node.next)).toEqual(["n1", "n3", null]);
  });

  test("a drop on itself or on an unknown node changes nothing", () => {
    const doc = quest([{ id: "n1", next: "n2" }, { id: "n2" }]);
    expect(moveAfter(doc, "n1", "n1")).toBeNull();
    expect(moveAfter(doc, "n1", "nope")).toBeNull();
  });
});
