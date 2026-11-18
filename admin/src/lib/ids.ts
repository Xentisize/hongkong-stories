/**
 * Id allocation for new documents.
 *
 * The number is chosen, never derived from the entry count — deleting the second of three doors
 * must not hand the next one an id a surviving door already answers to. That rule was first needed
 * by the map inspector's doors and exits, and creating a whole map or chapter needs exactly the
 * same thing, so it lives here rather than inside one view's helpers.
 */

/** `stem` + the smallest free number: `door_` → `door_1`, `door_2`, `door_3`… */
export function freeEntryId(entries: Array<{ id?: unknown }>, stem: string, start = 1): string {
  const taken = new Set(entries.map((entry) => String(entry.id ?? "")));
  for (let number = start; ; number += 1) {
    const candidate = `${stem}${number}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The same rule for a plain list of ids, which is what a content-kind listing is. */
export function freeIdFrom(taken: Iterable<string>, stem: string, start = 1): string {
  const used = new Set(taken);
  for (let number = start; ; number += 1) {
    const candidate = `${stem}${number}`;
    if (!used.has(candidate)) return candidate;
  }
}
