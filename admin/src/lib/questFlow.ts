/* Graph maths for the quest flow view.
 *
 * A quest is a chain in the data — `nodes[].next` — and the flow view must not invent a second
 * source of truth. So positions are *derived* (column = steps from the head) and the gestures are
 * expressed as edits to the same fields the validator reads: dragging a node onto another rewrites
 * the order and relinks `next`, dragging from a port sets one `next` link. Kept pure so the
 * gestures are testable without a browser.
 */

import { nodeId, nodesOf, relinkChain, type QuestDoc, type QuestNode } from "./questDoc";

export interface FlowEdge {
  from: string;
  to: string;
}

export interface FlowNode {
  id: string;
  /** Column: how many steps from the head. */
  depth: number;
  /** 0 is the main line; 1 is for nodes the chain cannot reach, so they stay visible. */
  row: number;
  reachable: boolean;
}

export interface FlowLayout {
  nodes: FlowNode[];
  edges: FlowEdge[];
  columns: number;
}

function nextOf(node: QuestNode): string | null {
  return typeof node.next === "string" && node.next !== "" ? node.next : null;
}

/** Every `next` link that points at a node that exists (dangling ids are the validator's job). */
export function questEdges(doc: QuestDoc): FlowEdge[] {
  const nodes = nodesOf(doc);
  const ids = new Set(nodes.map(nodeId).filter((id) => id !== ""));
  const edges: FlowEdge[] = [];

  for (const node of nodes) {
    const id = nodeId(node);
    const to = nextOf(node);
    if (id === "" || to === null || !ids.has(to) || to === id) continue;
    edges.push({ from: id, to });
  }
  return edges;
}

/** The node nothing links to — the chain's head; falls back to the first node, or null. */
export function questHead(doc: QuestDoc): string | null {
  const ids = nodesOf(doc).map(nodeId).filter((id) => id !== "");
  if (ids.length === 0) return null;
  const linked = new Set(questEdges(doc).map((edge) => edge.to));
  return ids.find((id) => !linked.has(id)) ?? ids[0]!;
}

/** Columns from the head, and a second row for anything the chain cannot reach. */
export function layoutQuest(doc: QuestDoc): FlowLayout {
  const nodes = nodesOf(doc);
  const edges = questEdges(doc);
  const byId = new Map(nodes.map((node) => [nodeId(node), node]));
  const positioned = new Map<string, FlowNode>();

  let cursor = questHead(doc);
  let depth = 0;
  while (cursor !== null && !positioned.has(cursor) && byId.has(cursor)) {
    positioned.set(cursor, { id: cursor, depth, row: 0, reachable: true });
    depth += 1;
    cursor = nextOf(byId.get(cursor)!);
  }

  const orphans = nodes.map(nodeId).filter((id) => id !== "" && !positioned.has(id));
  orphans.forEach((id, index) => {
    positioned.set(id, { id, depth: index, row: 1, reachable: false });
  });

  return {
    nodes: [...positioned.values()],
    edges,
    columns: Math.max(1, depth, orphans.length),
  };
}

/** Would `from → to` close a loop (or link a node to itself)? */
export function wouldCycle(doc: QuestDoc, from: string, to: string): boolean {
  if (from === to) return true;
  const byId = new Map(nodesOf(doc).map((node) => [nodeId(node), node]));
  const seen = new Set<string>();
  let cursor: string | null = to;

  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === from) return true;
    seen.add(cursor);
    const node = byId.get(cursor);
    cursor = node ? nextOf(node) : null;
  }
  return false;
}

/** Set `from.next`, or null when that would be a self-link, a cycle, or an unknown node. */
export function reconnect(doc: QuestDoc, from: string, to: string | null): QuestDoc | null {
  const ids = new Set(nodesOf(doc).map(nodeId));
  if (!ids.has(from)) return null;
  if (to !== null && (!ids.has(to) || wouldCycle(doc, from, to))) return null;

  const next = structuredClone(doc);
  const node = nodesOf(next).find((entry) => nodeId(entry) === from);
  if (!node) return null;
  node.next = to;
  return next;
}

/**
 * Move `dragged` so it sits immediately after `target`, then relink the chain.
 *
 * Unlike the row reorder (which deliberately leaves `next` alone so a branched arc survives a
 * tidy-up), a drag in the flow view *is* a structural edit: what the author sees as the order is
 * what the chain becomes.
 */
export function moveAfter(doc: QuestDoc, dragged: string, target: string): QuestDoc | null {
  if (dragged === target) return null;

  const nodes = nodesOf(doc);
  const ids = nodes.map(nodeId);
  const fromIndex = ids.indexOf(dragged);
  const targetIndex = ids.indexOf(target);
  if (fromIndex < 0 || targetIndex < 0) return null;

  const reordered = [...nodes];
  const [moved] = reordered.splice(fromIndex, 1);
  if (moved === undefined) return null;
  reordered.splice(fromIndex < targetIndex ? targetIndex : targetIndex + 1, 0, moved);

  return relinkChain({ ...doc, nodes: reordered });
}
