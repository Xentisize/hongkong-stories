/* Quest node chains (PLAN §5.4): the edits that have to understand `next`.
 *
 * A quest is an ordered chain — `nodes[0]` is where it starts, and each node names its successor.
 * The array order is presentation; `next` is the truth. That split decides what belongs here:
 *
 *  - **append** links, because a node nothing points at is unreachable and the validator refuses it;
 *  - **remove** repoints every predecessor at the removed node's successor, so deleting a middle
 *    node shortens the arc instead of silently cutting the rest of it off;
 *  - **move** does *not* relink — reordering rows must not rewrite an author's branching chain —
 *    and `relinkChain` is the explicit "make the visible order the chain" button.
 */

import type { LocalizedTable } from "./localized";

export interface QuestNode {
  id?: string;
  type?: string;
  text?: unknown;
  complete_when?: unknown;
  next?: string | null;
  on_complete?: unknown;
  [field: string]: unknown;
}

export interface QuestDoc {
  schema_version?: number;
  id?: string;
  title?: LocalizedTable;
  entry_requires?: unknown;
  nodes?: QuestNode[];
  [field: string]: unknown;
}

export const NODE_TYPES = ["objective", "cutscene"] as const;

export function nodesOf(doc: QuestDoc | null): QuestNode[] {
  if (doc === null || !Array.isArray(doc.nodes)) return [];
  return doc.nodes.filter((node) => typeof node === "object" && node !== null);
}

/** A node's id as the validator sees it: an absent id is `""`, never a positional guess. */
export function nodeId(node: QuestNode): string {
  return typeof node.id === "string" ? node.id : "";
}

/** The smallest unused `n<N>`, so "add" is idempotent-looking across a session. */
export function nextNodeId(doc: QuestDoc): string {
  const taken = new Set(nodesOf(doc).map((node) => nodeId(node)));
  for (let index = 1; ; index += 1) {
    const candidate = `n${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function blankNode(id: string): QuestNode {
  return {
    id,
    type: "objective",
    text: {},
    complete_when: null,
    next: null,
    on_complete: [],
  };
}

/** Append a node and link it from the current last row when that row has no successor yet. */
export function appendNode(doc: QuestDoc): QuestDoc {
  const next = structuredClone(doc);
  const nodes = nodesOf(next);
  const id = nextNodeId(next);
  nodes.push(blankNode(id));

  const previous = nodes[nodes.length - 2];
  if (previous !== undefined && (previous.next === null || previous.next === undefined)) {
    previous.next = id;
  }

  next.nodes = nodes;
  return next;
}

/** Remove a node, repointing its predecessors at its successor. Refuses to remove the last one. */
export function removeNode(doc: QuestDoc, id: string): QuestDoc | null {
  const current = nodesOf(doc);
  const index = current.findIndex((node) => nodeId(node) === id);
  if (index === -1 || current.length <= 1) return null;

  const next = structuredClone(doc);
  const nodes = nodesOf(next);
  const [removed] = nodes.splice(index, 1);
  const successor = typeof removed?.next === "string" ? removed.next : null;

  for (const node of nodes) {
    if (node.next === id) node.next = successor;
  }

  next.nodes = nodes;
  return next;
}

/** Swap a row with its neighbour. `next` is deliberately untouched — see the module comment. */
export function moveNode(doc: QuestDoc, id: string, delta: number): QuestDoc {
  const current = nodesOf(doc);
  const index = current.findIndex((node) => nodeId(node) === id);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= current.length) return doc;

  const next = structuredClone(doc);
  const nodes = nodesOf(next);
  const [moved] = nodes.splice(index, 1);
  nodes.splice(target, 0, moved!);
  next.nodes = nodes;
  return next;
}

/**
 * Rename a node, repointing whatever links to it. Returns `null` when the rename would be a no-op
 * or would collide — an id that another node already answers to makes the chain ambiguous, which
 * the validator reports as a duplicate rather than a typo the author can see.
 */
export function renameNode(doc: QuestDoc, from: string, to: string): QuestDoc | null {
  const id = to.trim();
  if (id === "" || id === from) return null;

  const nodes = nodesOf(doc);
  if (nodes.some((node) => nodeId(node) === id)) return null;
  if (!nodes.some((node) => nodeId(node) === from)) return null;

  const next = structuredClone(doc);
  const list = nodesOf(next);
  for (const node of list) {
    if (nodeId(node) === from) node.id = id;
    if (node.next === from) node.next = id;
  }
  next.nodes = list;
  return next;
}

/** Make the visible order the chain: every node points at the row below it, the last one ends. */
export function relinkChain(doc: QuestDoc): QuestDoc {
  const next = structuredClone(doc);
  const nodes = nodesOf(next);
  nodes.forEach((node, index) => {
    node.next = index + 1 < nodes.length ? nodeId(nodes[index + 1]!) : null;
  });
  next.nodes = nodes;
  return next;
}

/** A new quest with one starting node, so it is publishable-shaped from the first save. */
export function blankQuest(id: string): QuestDoc {
  return {
    schema_version: 1,
    id,
    title: {},
    entry_requires: null,
    nodes: [blankNode("n1")],
  };
}
