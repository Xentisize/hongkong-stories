/* The story map: the world as a graph.
 *
 * A chapter's scenes are connected by `exits` — each one names the scene it leads to, and may be
 * gated on a condition. That is already the story's structure, so the map is *derived* from it rather
 * than authored twice: nodes are scenes, edges are doors, and a gated door is drawn differently.
 *
 * Pure, so the layout is testable without a canvas: the same rule the quest flow uses — columns by
 * distance from the start, and anything unreachable still drawn, on its own row.
 */

export interface SceneNode {
  id: string;
  label: string;
}

export interface SceneEdge {
  from: string;
  to: string;
  /** The exit's own id, so two doors between the same pair stay distinguishable. */
  id: string;
  /** True when the exit carries a `requires`: a door you cannot always walk through. */
  gated: boolean;
}

export interface StoryGraph {
  nodes: SceneNode[];
  edges: SceneEdge[];
}

export interface PlacedScene extends SceneNode {
  depth: number;
  row: number;
  reachable: boolean;
}

export interface StoryLayout {
  nodes: PlacedScene[];
  edges: SceneEdge[];
  columns: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A scene's display name: its title in the pack's languages, else the id. */
function sceneLabel(doc: unknown, id: string): string {
  const body = record(doc);
  const title = body === null ? null : record(body["title"]);
  if (title !== null) {
    const value = title["zh_HK"] ?? title["en"];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return id;
}

/** Scenes and the doors between them, from the locations table. Dangling exits are dropped. */
export function sceneGraph(locations: Record<string, unknown> | undefined): StoryGraph {
  if (locations === undefined) return { nodes: [], edges: [] };

  const ids = Object.keys(locations).sort();
  const known = new Set(ids);
  const nodes: SceneNode[] = ids.map((id) => ({ id, label: sceneLabel(locations[id], id) }));
  const edges: SceneEdge[] = [];

  for (const id of ids) {
    const doc = record(locations[id]);
    const exits = doc === null ? [] : doc["exits"];
    if (!Array.isArray(exits)) continue;
    for (const raw of exits) {
      const exit = record(raw);
      if (exit === null) continue;
      const to = typeof exit["to"] === "string" ? exit["to"] : "";
      if (to === "" || !known.has(to) || to === id) continue;
      edges.push({
        from: id,
        to,
        id: typeof exit["id"] === "string" ? exit["id"] : `${id}->${to}`,
        gated: exit["requires"] !== undefined && exit["requires"] !== null,
      });
    }
  }

  return { nodes, edges };
}

/**
 * Column = steps from the start scene; scenes the doors cannot reach sit on a second row.
 *
 * Unreachable scenes are shown rather than hidden: an orphaned scene is usually a missing door, and
 * that is exactly what the author needs to see.
 */
export function layoutStory(graph: StoryGraph, start?: string | null): StoryLayout {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const placed = new Map<string, PlacedScene>();

  let cursor: string | null =
    start !== undefined && start !== null && byId.has(start) ? start : (graph.nodes[0]?.id ?? null);
  let depth = 0;
  while (cursor !== null && !placed.has(cursor)) {
    placed.set(cursor, { ...byId.get(cursor)!, depth, row: 0, reachable: true });
    const next = graph.edges.find((edge) => edge.from === cursor && !placed.has(edge.to));
    depth += 1;
    cursor = next === undefined ? null : next.to;
  }

  const orphans = graph.nodes.filter((node) => !placed.has(node.id));
  orphans.forEach((node, index) => {
    placed.set(node.id, { ...node, depth: index, row: 1, reachable: false });
  });

  return {
    nodes: [...placed.values()],
    edges: graph.edges,
    columns: Math.max(1, depth, orphans.length),
  };
}
