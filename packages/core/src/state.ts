/**
 * The save-state projection the condition evaluator reads (§5.1, §5.5).
 *
 * This mirrors `Game` in the Godot client and the `state` envelope the client sends to
 * `/v1/chat`. It is deliberately a plain object so it can cross a wire, survive JSON, and be
 * logged in a test fixture without any class or accessor magic.
 *
 * The three helpers below (`pyBool`, `toInt`, `toFloat`) exist because this module was ported
 * from a Python twin and a GDScript twin, and the two disagree about coercing sloppy values:
 * `bool([])` is False in Python but `[]` is truthy in JavaScript. Content is authored data, so
 * a divergence here is a silent quest-progression bug rather than a crash — hence the explicit
 * Python-shaped coercions instead of JavaScript truthiness.
 */

export type Locale = "zh_HK" | "zh_CN" | "en";

/** Fallback chain (§5.8, §6.5): Cantonese → other Chinese → English. */
export const LOCALES: readonly Locale[] = ["zh_HK", "zh_CN", "en"];
export const FALLBACK_LOCALE: Locale = "en";

export interface QuestRecord {
  node?: string;
  done?: boolean;
  [key: string]: unknown;
}

/**
 * The subset of saved game state a condition may read. Every bucket is optional: a fresh save
 * has no flags, and a condition asking about an absent bucket must read as "unset", not throw.
 */
export interface ConditionState {
  flags?: Record<string, unknown>;
  inventory?: Record<string, unknown>;
  vars?: Record<string, unknown>;
  visited?: Record<string, unknown>;
  talk_counts?: Record<string, unknown>;
  quests?: Record<string, unknown>;
  held_item?: unknown;
  time_of_day?: unknown;
  /**
   * The per-map context sheet (§5.1 `locations[].context`) for the NPC's current map.
   *
   * Conditions never read this — it exists because the client sends it and prompt assembly
   * grounds a conversation in the street around it. Modelling it here keeps the server from
   * reaching into an untyped bag for a field that is part of the wire contract.
   */
  location_context?: unknown;
}

/** True for a plain object — excludes null, arrays and primitives. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python `bool()`: empty containers and empty strings are false, unlike JavaScript. */
export function pyBool(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

/**
 * Python `int()` for the shapes content actually uses: truncation toward zero for numbers, and
 * numeric strings accepted. Malformed input falls back instead of raising, because an evaluator
 * that throws mid-frame would take the game down over an authoring typo that validation
 * already reports as an error.
 */
export function toInt(value: unknown, fallback = 0): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : fallback;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  }
  return fallback;
}

/** Python `float()` for the same shapes, with the same forgiving fallback. */
export function toFloat(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/**
 * Key coercion for id lookups. Python used `str(...)`; every authored id is a string, so this
 * only matters for malformed content, where a stable string beats `[object Object]`.
 */
export function toKey(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  if (isRecord(value) || Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

/** Read a state bucket, treating a non-object (absent or wrong type) as empty. */
export function bucket(state: ConditionState, key: keyof ConditionState): Record<string, unknown> {
  const value = state[key];
  return isRecord(value) ? value : {};
}
