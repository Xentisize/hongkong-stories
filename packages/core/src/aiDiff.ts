/* Reviewing a proposal: what would actually change.
 *
 * A summary line ("a tea shop street") tells the author what they asked for; the diff tells them
 * what they are about to write. The approval card shows both, because "approve" is only meaningful if
 * the change is visible — and for an `update` the interesting part is the fields that move, not the
 * document's existence.
 *
 * Top-level keys rather than a deep walk: content documents are small, one key per concept, and a
 * path like `tilemap` or `npcs` is exactly the granularity an author reasons about. Values are
 * compared as compact JSON so an array reorder reads as a change.
 */

export type DiffKind = "added" | "removed" | "changed";

export interface FieldDiff {
  field: string;
  kind: DiffKind;
  /** Compact JSON of the value before/after, trimmed for display. */
  before?: string;
  after?: string;
}

function compact(value: unknown): string {
  const text = JSON.stringify(value ?? null);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Field-level differences between two documents, in key order: removed, added, then changed. */
export function diffDocuments(before: unknown, after: unknown): FieldDiff[] {
  const from = record(before);
  const to = record(after);
  const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort();

  const removed: FieldDiff[] = [];
  const added: FieldDiff[] = [];
  const changed: FieldDiff[] = [];

  for (const field of keys) {
    const hadIt = Object.hasOwn(from, field);
    const hasIt = Object.hasOwn(to, field);
    if (hadIt && !hasIt) removed.push({ field, kind: "removed", before: compact(from[field]) });
    else if (!hadIt && hasIt) added.push({ field, kind: "added", after: compact(to[field]) });
    else if (compact(from[field]) !== compact(to[field])) {
      changed.push({ field, kind: "changed", before: compact(from[field]), after: compact(to[field]) });
    }
  }

  return [...removed, ...added, ...changed];
}

/** One line per difference, for the approval card. */
export function describeDiff(diffs: FieldDiff[]): string[] {
  return diffs.map((diff) => {
    const mark = diff.kind === "added" ? "+" : diff.kind === "removed" ? "−" : "~";
    if (diff.kind === "added") return `${mark} ${diff.field}: ${diff.after}`;
    if (diff.kind === "removed") return `${mark} ${diff.field}: ${diff.before}`;
    return `${mark} ${diff.field}: ${diff.before} → ${diff.after}`;
  });
}
