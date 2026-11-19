/* Declared narrative links.
 *
 * The graph the studio draws is *derived* from fields the engine reads (`has_item`, `talked`, `give`,
 * `set_flag`). Those must never be stored twice: a declared edge the engine does not honour would be
 * a second truth that drifts, and the player would walk into the gap.
 *
 * Some relationships, though, exist only in a writer's head — "this photo is about grandmother",
 * "foreshadows the fire", "part of the memento set". Nothing executes them, so there is nothing to
 * derive them from. Those are what `links` is for, and they are deliberately:
 *
 *   - a separate field from anything mechanical,
 *   - validated (a dangling target warns, it never blocks a publish),
 *   - rendered differently in the studio, so a note is never mistaken for a law of the game.
 */

export const LINK_KINDS = ["about", "foreshadows", "belongs_to", "related"] as const;

export type LinkKind = (typeof LINK_KINDS)[number];

export interface DeclaredLink {
  /** The other end's id. */
  to: string;
  kind: LinkKind | string;
  /** Why, in the author's words. Optional: the kind alone is often enough. */
  note?: string;
}

export function isLinkKind(value: unknown): value is LinkKind {
  return typeof value === "string" && (LINK_KINDS as readonly string[]).includes(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A document's declared links, dropping anything malformed rather than repairing it. */
export function declaredLinks(doc: unknown): DeclaredLink[] {
  const body = record(doc);
  const raw = body?.["links"];
  if (!Array.isArray(raw)) return [];

  const links: DeclaredLink[] = [];
  for (const entry of raw) {
    const link = record(entry);
    if (link === null) continue;
    const to = typeof link["to"] === "string" ? link["to"].trim() : "";
    const kind = typeof link["kind"] === "string" ? link["kind"].trim() : "";
    if (to === "" || kind === "") continue;
    const note = typeof link["note"] === "string" ? link["note"].trim() : "";
    links.push(note === "" ? { to, kind } : { to, kind, note });
  }
  return links;
}
