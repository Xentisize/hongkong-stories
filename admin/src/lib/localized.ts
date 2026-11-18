/* Localized-field writes shared by the content editors.
 *
 * The publish gate has two rules that a naive `{ ...field, [locale]: text }` violates: a locale
 * key that is present but blank is an *error*, and a field missing locales is an error unless the
 * document acknowledges the gap in `_todo`. So an emptied box drops its key instead of writing
 * `""`, and filling a locale retires that locale's `_todo` entry — an acknowledgement that
 * outlives the gap it acknowledged would hide the next real one.
 */

import { isRecord } from "@hkstories/core";

/** A localized value as the editors keep it: locale tag → string, plus an optional `_todo`. */
export type LocalizedTable = Record<string, string | string[]>;

/**
 * Read a raw document field as a table.
 *
 * The schemas allow a bare string as a localized field. There is no tag to recover from one, so it
 * seeds the canonical locale — the author is editing `zh_HK` by default everywhere else.
 */
export function asLocalized(field: unknown): Record<string, string> {
  if (typeof field === "string") return field.trim() === "" ? {} : { zh_HK: field };
  if (!isRecord(field)) return {};

  const table: Record<string, string> = {};
  for (const [key, value] of Object.entries(field)) {
    // `_todo` is the acknowledgement list, not a language — and a document may store it as a
    // string, so the key is skipped by name rather than by shape.
    if (key === "_todo" || key.startsWith("_")) continue;
    if (typeof value === "string") table[key] = value;
  }
  return table;
}

/** The `_todo` acknowledgement list, as the document actually stores it. */
export function todoLocales(field: unknown): string[] {
  if (!isRecord(field)) return [];
  const todo = field["_todo"];
  return Array.isArray(todo) ? todo.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Write one locale, returning a new table: blank text removes the key, and non-blank text retires
 * that locale from `_todo` (dropping `_todo` itself once nothing is acknowledged).
 */
export function writeLocale(field: unknown, locale: string, text: string): Record<string, string | string[]> {
  const next: Record<string, string | string[]> = asLocalized(field);

  if (text.trim() === "") {
    delete next[locale];
  } else {
    next[locale] = text;
  }

  const todo = todoLocales(field);
  if (todo.length > 0) {
    const remaining = text.trim() === "" ? todo : todo.filter((entry) => entry !== locale);
    if (remaining.length > 0) next["_todo"] = remaining;
  }

  return next;
}
