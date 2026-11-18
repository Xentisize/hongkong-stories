import { localize, type ConditionState, type Locale } from "@hkstories/core";

/**
 * The inventory as data, before it is pixels.
 *
 * The Godot HUD's panel took `Game.inventory` plus the item table and drew a list with a detail pane,
 * a Use button gated by `use_requires` (with the content's own `use_locked` line when it refuses), and
 * a Hold toggle. All of that is a decision about *what to show*, which is why it lives here: the DOM
 * layer should only be told "these rows, this one is held, this one cannot be used and here is why".
 *
 * Two rules worth stating because they are not obvious:
 *
 * - **A carried item the content does not define is still shown**, by its id. A save can hold
 *   something a later edit deleted, and silently hiding it would make the bag disagree with the save.
 * - **`usable` is not enough.** An item is only usable when its `use_requires` also passes; otherwise
 *   the row carries the content's `use_locked` text, so a refusal is explained rather than ignored.
 */

export interface ItemDef {
  id?: string;
  name?: Record<string, string>;
  desc?: Record<string, string>;
  category?: string;
  icon?: string;
  usable?: boolean;
  use_requires?: unknown;
  use_locked?: Record<string, string>;
  on_use?: unknown[];
  stack_max?: number;
}

export interface InventoryRow {
  id: string;
  count: number;
  name: string;
  description: string;
  category: string;
  held: boolean;
  /** `usable` **and** the requirements pass right now. */
  usable: boolean;
  /** The content's own line explaining why it cannot be used yet, when it declares one. */
  locked: string;
}

/** Requirements that are absent mean "no gate"; an empty object is still a condition. */
function permits(condition: unknown, evaluate: (condition: unknown) => boolean): boolean {
  if (condition === undefined || condition === null) return true;
  return evaluate(condition);
}

/**
 * The bag, ready to render.
 *
 * Sorted by category, then name, then id — deterministic, so a row does not jump when something is
 * used, and a test can assert an order rather than a set.
 */
export function inventoryRows(
  items: Record<string, ItemDef>,
  state: ConditionState,
  locale: Locale,
  evaluate: (condition: unknown) => boolean,
): InventoryRow[] {
  const rows: InventoryRow[] = [];

  for (const [id, raw] of Object.entries(state.inventory ?? {})) {
    const count = Number(raw);
    if (!Number.isFinite(count) || count <= 0) continue;

    const def = items[id];
    const declaredUsable = def?.usable === true;
    const permitted = permits(def?.use_requires, evaluate);

    rows.push({
      id,
      count,
      // A save can hold an item the pack no longer defines: show the id rather than hide the fact.
      name: localize(def?.name, locale) || id,
      description: localize(def?.desc, locale),
      category: typeof def?.category === "string" ? def.category : "",
      held: state.held_item === id,
      usable: declaredUsable && permitted,
      // Only explainable when the content says how; otherwise the row just cannot be used.
      locked: declaredUsable && !permitted ? localize(def?.use_locked, locale) : "",
    });
  }

  return rows.sort(
    (left, right) =>
      left.category.localeCompare(right.category) ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );
}

export type UseOutcome =
  | { ok: true; effects: unknown[] }
  | { ok: false; reason: "unknown" | "not-usable" | "locked"; locked?: string };

/**
 * Whether an item can be used, and what that would do.
 *
 * Separate from the click handler because the answer has three refusals that must not look alike: no
 * such item, an item that is not usable at all, and an item whose requirements are not met yet — the
 * last one is the only one the player should be told about, in the content's own words.
 */
export function planUse(
  items: Record<string, ItemDef>,
  itemId: string,
  locale: Locale,
  evaluate: (condition: unknown) => boolean,
): UseOutcome {
  const def = items[itemId];
  if (def === undefined) return { ok: false, reason: "unknown" };
  if (def.usable !== true) return { ok: false, reason: "not-usable" };

  if (!permits(def.use_requires, evaluate)) {
    return { ok: false, reason: "locked", locked: localize(def.use_locked, locale) };
  }

  return { ok: true, effects: Array.isArray(def.on_use) ? def.on_use : [] };
}

/** The HUD's "holding" line, or "" when the hands are empty. */
export function heldLabel(
  items: Record<string, ItemDef>,
  state: ConditionState,
  locale: Locale,
): string {
  const held = state.held_item;
  if (typeof held !== "string" || held === "") return "";

  return localize(items[held]?.name, locale) || held;
}
