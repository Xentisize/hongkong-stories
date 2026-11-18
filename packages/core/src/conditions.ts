/**
 * The condition mini-language (§5.5) — the single implementation.
 *
 * This replaces two twins that had to be kept in agreement by hand:
 *   client/autoload/conditions.gd   (gated doors, quests, interactables)
 *   server/app/llm/conditions.py    (filtered which NPC secrets may be revealed)
 *
 * Both were checked against `client/tests/fixtures/conditions.json`. That table is now this
 * module's acceptance test, not a bandage over a duplicate.
 *
 * ## Two things that are semantic, not stylistic
 *
 * 1. **Check order.** `all` / `any` / `not` are tested before any leaf verb, and the first
 *    matching key wins. A condition carrying two verbs is an authoring bug, and both previous
 *    implementations resolved it by key order. Reordering these `if`s would change behaviour.
 * 2. **Float comparison.** The twins disagreed: Python used exact `==`, GDScript used
 *    `is_equal_approx`. Vars are floats accumulated by `add_var`, so exact equality can fail
 *    after drift (0.1 added ten times is not 1.0). This module uses approximate equality,
 *    matching the GDScript twin, because that is the correct behaviour for accumulated state.
 *    The shared fixture table deliberately contains only integer-valued vars so the existing
 *    Python and GDScript suites stay valid; the drift case is pinned in a TS-only test, and
 *    the Python twin must adopt the same rule when it is retired.
 */

import {
  bucket,
  isRecord,
  pyBool,
  toFloat,
  toInt,
  toKey,
  type ConditionState,
} from "./state";

/** Relative tolerance mirroring Godot's `is_equal_approx` (CMP_EPSILON = 1e-5). */
const EPSILON = 1e-5;

export type Condition = unknown;

export interface EvaluateOptions {
  /** Receives the same diagnostics the twins sent to `warnings.warn` / `push_warning`. */
  onWarning?: (message: string) => void;
}

/**
 * Evaluate a condition against saved state.
 *
 * `null`/absent means "no requirement", which is the common case for doors and props.
 */
export function evaluate(
  condition: Condition,
  state: ConditionState = {},
  options: EvaluateOptions = {},
): boolean {
  const warn = options.onWarning ?? (() => {});

  if (condition === null || condition === undefined) return true;

  if (!isRecord(condition)) {
    warn(`condition is not an object: ${JSON.stringify(condition)}`);
    return false;
  }

  if (Object.keys(condition).length === 0) return true;

  if ("all" in condition) {
    const branches = condition["all"];
    if (!Array.isArray(branches)) {
      warn("'all' must be a list");
      return false;
    }
    return branches.every((sub) => evaluate(sub, state, options));
  }

  if ("any" in condition) {
    const branches = condition["any"];
    if (!Array.isArray(branches)) {
      warn("'any' must be a list");
      return false;
    }
    return branches.some((sub) => evaluate(sub, state, options));
  }

  if ("not" in condition) {
    return !evaluate(condition["not"], state, options);
  }

  if ("flag" in condition) {
    const flags = bucket(state, "flags");
    const expected = pyBool(condition["value"] ?? true);
    return pyBool(flags[toKey(condition["flag"])] ?? false) === expected;
  }

  if ("has_item" in condition) {
    const inventory = bucket(state, "inventory");
    const have = toInt(inventory[toKey(condition["has_item"])]);
    return have >= toInt(condition["count"] ?? 1);
  }

  if ("held" in condition) {
    // The item screen's "in hand" choice (§5.5): the projection carries the held item id.
    return toKey(state.held_item ?? "") === toKey(condition["held"]);
  }

  if ("var" in condition) {
    const variables = bucket(state, "vars");
    return compare(
      toFloat(variables[toKey(condition["var"])]),
      toKey(condition["op"] ?? ">="),
      toFloat(condition["value"] ?? 0),
      warn,
    );
  }

  if ("visited" in condition) {
    return pyBool(bucket(state, "visited")[toKey(condition["visited"])]);
  }

  if ("talked" in condition) {
    const counts = bucket(state, "talk_counts");
    const spoken = toInt(counts[toKey(condition["talked"])]);
    return spoken >= toInt(condition["min"] ?? 1);
  }

  if ("quest_state" in condition) {
    // `{"quest_state": "ch01", "node": "n2"}` — started, not done, sitting on n2.
    // Without `node`, it just asks whether the quest is active.
    //
    // An unknown quest must read as absent, never as an empty record: an empty record would
    // look "active" with no node, and the shared fixture caught exactly that divergence.
    const record = bucket(state, "quests")[toKey(condition["quest_state"])];
    if (!isRecord(record)) return false;
    if (pyBool(record["done"] ?? false)) return false;
    const wanted = toKey(condition["node"] ?? "");
    return wanted === "" || toKey(record["node"] ?? "") === wanted;
  }

  if ("quest_done" in condition) {
    const record = bucket(state, "quests")[toKey(condition["quest_done"])];
    return isRecord(record) && pyBool(record["done"] ?? false);
  }

  if ("time_of_day" in condition) {
    return toKey(state.time_of_day ?? "day") === toKey(condition["time_of_day"]);
  }

  warn(`unknown condition: ${JSON.stringify(Object.keys(condition))}`);
  return false;
}

/** Approximate equality for float state, matching Godot's `is_equal_approx`. */
export function approxEqual(left: number, right: number): boolean {
  if (left === right) return true;
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= EPSILON * scale;
}

function compare(
  left: number,
  op: string,
  right: number,
  warn: (message: string) => void,
): boolean {
  switch (op) {
    case "==":
      return approxEqual(left, right);
    case "!=":
      return !approxEqual(left, right);
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    default:
      warn(`unknown comparison ${JSON.stringify(op)}`);
      return false;
  }
}
