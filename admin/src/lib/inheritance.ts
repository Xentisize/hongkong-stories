/* Authoring-time inheritance, seen from the editor.
 *
 * The resolver lives in `@hkstories/core` (`resolveInheritance` / `mergeDocuments`) and is what
 * publish and the clients use. This module is the *authoring* half: which documents may be a parent,
 * and what a chosen parent actually contributes to the one being edited. Keeping the two apart
 * matters — a preview that reimplemented the merge would eventually disagree with the merge that
 * ships, which is the one thing an inheritance UI must never do.
 */

import { mergeDocuments, type ContentEntity } from "@hkstories/core";

const isRecord = (value: unknown): value is ContentEntity =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * The ids that can be a parent for this document: same kind, not itself, templates first.
 *
 * Templates (`_`-prefixed) lead because they are what a base document is *for*; everything else
 * follows alphabetically so the list does not reshuffle as the pack grows.
 */
export function parentCandidates(ids: readonly string[], selfId: string | null | undefined): string[] {
  return ids
    .filter((id) => id !== selfId)
    .sort((a, b) => {
      const aTemplate = a.startsWith("_");
      const bTemplate = b.startsWith("_");
      if (aTemplate !== bTemplate) return aTemplate ? -1 : 1;
      return a.localeCompare(b);
    });
}

/** What one key of the child ends up being, relative to its parent. */
export type InheritanceState = "inherited" | "overridden" | "removed" | "own";

export interface InheritanceEntry {
  key: string;
  state: InheritanceState;
}

const STATE_ORDER: Record<InheritanceState, number> = {
  inherited: 0,
  overridden: 1,
  own: 2,
  removed: 3,
};

/**
 * What the parent contributes, key by key.
 *
 * The four answers are the resolver's four rules, named: `inherited` (only the parent says it),
 * `overridden` (both do, the child wins), `own` (only the child says it) and `removed` (the child
 * wrote `null`, which deletes an inherited value). Authoring notes, `id` and `extends` never appear,
 * because none of them are inherited.
 */
export function inheritancePreview(parent: unknown, child: unknown): InheritanceEntry[] {
  if (!isRecord(parent) || !isRecord(child)) return [];

  const reportable = (key: string) => key !== "id" && key !== "extends" && !key.startsWith("_");
  const entries: InheritanceEntry[] = [];

  for (const key of Object.keys(parent)) {
    if (!reportable(key)) continue;
    if (!(key in child)) entries.push({ key, state: "inherited" });
    else entries.push({ key, state: child[key] === null ? "removed" : "overridden" });
  }

  for (const key of Object.keys(child)) {
    if (!reportable(key) || key in parent) continue;
    entries.push({ key, state: "own" });
  }

  return entries.sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.key.localeCompare(b.key),
  );
}

/** The document the child becomes once its parent is applied — the same merge publish performs. */
export function resolvedDocument(parent: unknown, child: unknown): ContentEntity | null {
  if (!isRecord(parent) || !isRecord(child)) return null;
  return mergeDocuments(parent, child);
}
