import { describe, expect, test } from "bun:test";

import {
  appendNode,
  blankNode,
  blankQuest,
  moveNode,
  nextNodeId,
  nodeId,
  nodesOf,
  relinkChain,
  removeNode,
  renameNode,
  type QuestDoc,
} from "./questDoc";

/**
 * Chain edits. Every rule asserted here is one the validator enforces from the other side: a node
 * nothing links to is unreachable, a deleted middle node must not orphan the rest of the arc, and a
 * quest with no nodes is refused outright.
 */

const quest = (nodes: Array<{ id: string; next: string | null }>): QuestDoc => ({
  id: "q_test",
  nodes: nodes.map((node) => ({ ...blankNode(node.id), next: node.next })),
});

const links = (doc: QuestDoc | null): Array<[string, string | null]> =>
  nodesOf(doc).map((node) => [nodeId(node), node.next ?? null]);

describe("nextNodeId", () => {
  test("skips the ids already taken", () => {
    expect(nextNodeId(quest([{ id: "n1", next: "n3" }, { id: "n3", next: null }]))).toBe("n2");
  });

  test("starts at n1 for an empty quest", () => {
    expect(nextNodeId({})).toBe("n1");
  });
});

describe("appendNode", () => {
  test("links the current tail to the new node", () => {
    const appended = appendNode(quest([{ id: "n1", next: null }]));
    expect(links(appended)).toEqual([
      ["n1", "n2"],
      ["n2", null],
    ]);
  });

  test("a starting node keeps its own id when the chain has a hole", () => {
    const appended = appendNode(quest([{ id: "n2", next: null }]));
    expect(links(appended)[0]?.[1]).toBe("n1");
  });

  test("does not rewrite a tail that already points somewhere", () => {
    const branched = quest([
      { id: "n1", next: "n2" },
      { id: "n2", next: null },
    ]);
    // The last *row* has no successor, so it gets linked; the earlier branch is left alone.
    expect(links(appendNode(branched))).toEqual([
      ["n1", "n2"],
      ["n2", "n3"],
      ["n3", null],
    ]);
  });

  test("clears nothing on an empty quest", () => {
    expect(links(appendNode({ id: "q", nodes: [] }))).toEqual([["n1", null]]);
  });

  test("the source document is not mutated", () => {
    const source = quest([{ id: "n1", next: null }]);
    appendNode(source);
    expect(links(source)).toEqual([["n1", null]]);
  });
});

describe("removeNode", () => {
  test("a middle node's predecessor adopts its successor", () => {
    const removed = removeNode(
      quest([
        { id: "n1", next: "n2" },
        { id: "n2", next: "n3" },
        { id: "n3", next: null },
      ]),
      "n2",
    );
    expect(links(removed)).toEqual([
      ["n1", "n3"],
      ["n3", null],
    ]);
  });

  test("removing the tail ends the chain", () => {
    const removed = removeNode(
      quest([
        { id: "n1", next: "n2" },
        { id: "n2", next: null },
      ]),
      "n2",
    );
    expect(links(removed)).toEqual([["n1", null]]);
  });

  test("refuses to remove the only node", () => {
    expect(removeNode(quest([{ id: "n1", next: null }]), "n1")).toBeNull();
  });

  test("an unknown id changes nothing", () => {
    const source = quest([{ id: "n1", next: null }]);
    expect(removeNode(source, "n9")).toBeNull();
  });
});

describe("moveNode", () => {
  test("swaps rows without touching the chain", () => {
    const moved = moveNode(
      quest([
        { id: "n1", next: "n2" },
        { id: "n2", next: null },
      ]),
      "n2",
      -1,
    );
    expect(nodesOf(moved).map(nodeId)).toEqual(["n2", "n1"]);
    expect(links(moved)).toEqual([
      ["n2", null],
      ["n1", "n2"],
    ]);
  });

  test("moving past either end is a no-op by reference", () => {
    const source = quest([{ id: "n1", next: null }]);
    expect(moveNode(source, "n1", -1)).toBe(source);
    expect(moveNode(source, "missing", 1)).toBe(source);
  });
});

describe("renameNode", () => {
  test("renames the node and repoints its predecessor", () => {
    const renamed = renameNode(
      quest([
        { id: "n1", next: "n2" },
        { id: "n2", next: null },
      ]),
      "n2",
      "n2_shore",
    );
    expect(links(renamed)).toEqual([
      ["n1", "n2_shore"],
      ["n2_shore", null],
    ]);
  });

  test("refuses a blank, identical or already-taken id", () => {
    const source = quest([
      { id: "n1", next: "n2" },
      { id: "n2", next: null },
    ]);
    expect(renameNode(source, "n1", "  ")).toBeNull();
    expect(renameNode(source, "n1", "n1")).toBeNull();
    expect(renameNode(source, "n1", "n2")).toBeNull();
    expect(renameNode(source, "n9", "n10")).toBeNull();
  });

  test("trims the id it writes", () => {
    const renamed = renameNode(quest([{ id: "n1", next: null }]), "n1", "  start ");
    expect(links(renamed)).toEqual([["start", null]]);
  });
});

describe("relinkChain", () => {
  test("makes the visible order the chain and ends the last row", () => {
    const relinked = relinkChain(
      quest([
        { id: "n2", next: null },
        { id: "n1", next: "n2" },
        { id: "n3", next: "n1" },
      ]),
    );
    expect(links(relinked)).toEqual([
      ["n2", "n1"],
      ["n1", "n3"],
      ["n3", null],
    ]);
  });
});

describe("blankQuest", () => {
  test("is publishable-shaped: one node, clear title, no entry gate", () => {
    const doc = blankQuest("q_new");
    expect(doc.id).toBe("q_new");
    expect(doc.entry_requires).toBeNull();
    expect(nodesOf(doc)).toHaveLength(1);
    expect(links(doc)).toEqual([["n1", null]]);
  });
});
