/* The §5.5/§5.6 vocabulary the editors share (PLAN 9.2).
 *
 * Conditions and effects are JSON, and several views need to *edit* them rather than paste them: the
 * standalone Builder, a location's doors and exits, an object's `on_interact`, and (next) a quest's
 * nodes. Keeping the row vocabulary here — and only here — is what stops those views drifting into
 * two slightly different rule languages, which is precisely what the chapters view warned about when
 * it refused to grow a second condition editor.
 *
 * Everything is a plain object walk: the JSON object IS the model, so these helpers read it and
 * return a replacement, and a form can hold it in React state.
 */

import { toKey } from "@hkstories/core";

export type Rule = Record<string, unknown>;

/** Nesting deeper than this is not offered, matching the original builder's cap. */
export const MAX_DEPTH = 4;

/** Leaf verbs a creator picks from; `all`/`any`/`not` are structure, not verbs. */
export const LEAF_VERBS: Array<[string, string]> = [
  ["flag", "旗標 flag"],
  ["has_item", "持有 has_item"],
  ["var", "變量 var"],
  ["visited", "去過 visited"],
  ["talked", "談過 talked"],
  ["quest_state", "任務進行到 quest_state"],
  ["quest_done", "任務完成 quest_done"],
  ["time_of_day", "時段 time_of_day"],
];

export const MODES: Array<[string, string]> = [
  ["empty", "無條件（恆真）"],
  ["single", "單條"],
  ["all", "all 組（全部滿足）"],
  ["any", "any 組（任一滿足）"],
  ["not", "not 包裹（取反）"],
];

export const COMPARISONS = ["==", "!=", ">", ">=", "<", "<="];

export function isRule(value: unknown): value is Rule {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Which group a condition is, or `null` when it is a leaf (or not a condition at all). */
export function groupKey(cond: unknown): "all" | "any" | "not" | null {
  if (!isRule(cond)) return null;
  if ("all" in cond) return "all";
  if ("any" in cond) return "any";
  if ("not" in cond) return "not";
  return null;
}

/** The verb a leaf condition uses, or `null` when it is a group or has no known verb. */
export function leafVerb(cond: unknown): string | null {
  if (!isRule(cond) || groupKey(cond) !== null) return null;
  const key = Object.keys(cond).find((entry) => LEAF_VERBS.some(([verb]) => verb === entry));
  return key ?? null;
}

/** A fresh leaf for a verb, with the parameters that verb actually runs on. */
export function freshLeaf(verb: string): Rule {
  switch (verb) {
    case "has_item":
      return { has_item: "", count: 1 };
    case "var":
      return { var: "", op: ">=", value: 0 };
    case "talked":
      return { talked: "", min: 1 };
    case "quest_state":
      return { quest_state: "", node: "" };
    case "time_of_day":
      return { time_of_day: "day" };
    default:
      return { [verb]: "" };
  }
}

export type RootMode = "empty" | "single" | "all" | "any" | "not";

export function rootMode(cond: unknown): RootMode {
  const group = groupKey(cond);
  if (group !== null) return group;
  return leafVerb(cond) !== null ? "single" : "empty";
}

/**
 * The first leaf inside a condition, descending through groups.
 *
 * Mode switching carries this across: turning "all 組" back into "單條" should keep the rule the
 * author wrote, not discard it because the root happened to be a group.
 */
export function firstLeaf(cond: unknown, depth = 0): Rule | null {
  if (depth > MAX_DEPTH || !isRule(cond)) return null;
  if (leafVerb(cond) !== null) return cond;

  const group = groupKey(cond);
  if (group === null) return null;
  if (group === "not") return firstLeaf(cond["not"], depth + 1);

  const entries = Array.isArray(cond[group]) ? (cond[group] as unknown[]) : [];
  for (const entry of entries) {
    const found = firstLeaf(entry, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Re-shape a condition to a new root mode.
 *
 * Switching mode keeps the leaf that was already there — turning "旗標門開" into "all 組" should
 * start from that rule, not throw it away and hand back a blank row.
 */
export function withMode(cond: unknown, mode: RootMode): Rule {
  const leaf = firstLeaf(cond) ?? freshLeaf("flag");

  switch (mode) {
    case "empty":
      return {};
    case "single":
      return { ...leaf };
    case "not":
      return { not: { ...leaf } };
    default:
      return { [mode]: [{ ...leaf }] };
  }
}

/* ---------- immutable path edits ---------- */

/** A route into a rule tree: object keys and array indices, from the root. */
export type Path = ReadonlyArray<string | number>;

export function valueAt(root: unknown, path: Path): unknown {
  let current: unknown = root;
  for (const step of path) {
    if (typeof step === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[step];
    } else {
      if (!isRule(current)) return undefined;
      current = current[step];
    }
  }
  return current;
}

/**
 * Replace the value at `path`, copying only the nodes along the way.
 *
 * The editor holds the tree in React state, so an edit has to produce a new object at every level
 * up to the root while leaving every untouched branch shared. Doing it here — rather than with
 * `structuredClone` on each keystroke — keeps a four-deep rule tree cheap enough to re-render per
 * key press, and keeps the mutation path in one testable place instead of spread across recursive
 * components. A numeric step indexes an array, anything else indexes an object.
 */
export function replaceAt(root: Rule, path: Path, value: unknown): Rule {
  return setIn(root, path, value) as Rule;
}

/** Delete an array entry, or remove an object key, at `path`. */
export function removeAt(root: Rule, path: Path): Rule {
  return deleteIn(root, path) as Rule;
}

/** Append to the array at `path`. */
export function appendAt(root: Rule, path: Path, value: unknown): Rule {
  const current = valueAt(root, path);
  const list = Array.isArray(current) ? current : [];
  return replaceAt(root, path, [...list, value]);
}

function setIn(node: unknown, path: Path, value: unknown): unknown {
  const [step, ...rest] = path;
  if (step === undefined) return value;

  if (typeof step === "number") {
    const list = Array.isArray(node) ? [...node] : [];
    list[step] = rest.length === 0 ? value : setIn(list[step], rest, value);
    return list;
  }

  const base = isRule(node) ? node : {};
  return { ...base, [step]: rest.length === 0 ? value : setIn(base[step], rest, value) };
}

function deleteIn(node: unknown, path: Path): unknown {
  const [step, ...rest] = path;
  if (step === undefined) return node;

  if (typeof step === "number") {
    if (!Array.isArray(node)) return node;
    if (rest.length === 0) return node.filter((_, index) => index !== step);
    return node.map((entry, index) => (index === step ? deleteIn(entry, rest) : entry));
  }

  if (!isRule(node)) return node;
  if (rest.length === 0) {
    const copy: Rule = { ...node };
    delete copy[step];
    return copy;
  }
  return { ...node, [step]: deleteIn(node[step], rest) };
}

/* ---------- leaf parameters ---------- */

/** The parameters each leaf verb reads, mirrored from `packages/core/src/conditions.ts`. */
const LEAF_FIELDS: Record<string, FieldSpec[]> = {
  flag: [
    { key: "flag", label: "旗標 flag", kind: "text", placeholder: "door_open" },
    // `{flag: x, value: false}` is "this flag is unset" — the evaluator reads `value` through
    // pyBool, so the editor has to keep the false half reachable.
    { key: "value", label: "應為 value", kind: "boolean" },
  ],
  has_item: [
    { key: "has_item", label: "物品 item", kind: "text", placeholder: "item_flat_key" },
    { key: "count", label: "最少 count", kind: "number" },
  ],
  var: [
    { key: "var", label: "變量 var", kind: "text" },
    { key: "op", label: "比較 op", kind: "select", options: COMPARISONS },
    { key: "value", label: "數值 value", kind: "number" },
  ],
  visited: [{ key: "visited", label: "地點 location", kind: "text", placeholder: "loc_ssp_flat" }],
  talked: [
    { key: "talked", label: "NPC", kind: "text", placeholder: "npc_ch01_tai" },
    { key: "min", label: "最少次數 min", kind: "number" },
  ],
  quest_state: [
    { key: "quest_state", label: "任務 quest", kind: "text", placeholder: "ch01" },
    { key: "node", label: "節點 node", kind: "text", placeholder: "n2" },
  ],
  quest_done: [{ key: "quest_done", label: "任務 quest", kind: "text", placeholder: "ch01" }],
  time_of_day: [
    { key: "time_of_day", label: "時段", kind: "select", options: ["day", "dusk", "night"] },
  ],
};

export function leafFields(verb: string): FieldSpec[] {
  return LEAF_FIELDS[verb] ?? [];
}

/* ---------- effects ---------- */

export type FieldKind = "text" | "number" | "select" | "localized" | "boolean";

export interface FieldSpec {
  key: string;
  label: string;
  kind: FieldKind;
  options?: string[];
  placeholder?: string;
}

/**
 * The parameters each effect type reads, mirrored from `packages/core/src/effects.ts`.
 *
 * Only types the interpreter handles appear here; anything else stays editable as raw JSON, so a
 * future effect type is not locked out of the editor before the interpreter learns it.
 */
const EFFECT_FIELDS: Record<string, FieldSpec[]> = {
  set_flag: [{ key: "flag", label: "旗標 flag", kind: "text", placeholder: "ch01_met_tai" }],
  give: [
    { key: "item", label: "物品 item", kind: "text", placeholder: "item_tea_tin" },
    { key: "count", label: "數量 count", kind: "number" },
  ],
  take: [
    { key: "item", label: "物品 item", kind: "text", placeholder: "item_tea_tin" },
    { key: "count", label: "數量 count", kind: "number" },
  ],
  var: [
    { key: "name", label: "變量 name", kind: "text" },
    { key: "op", label: "運算 op", kind: "select", options: ["add", "set"] },
    { key: "value", label: "數值 value", kind: "number" },
  ],
  say: [{ key: "text", label: "對白 text", kind: "localized" }],
  quest: [
    { key: "quest", label: "任務 quest", kind: "text", placeholder: "ch01" },
    { key: "op", label: "動作 op", kind: "select", options: ["start", "complete"] },
  ],
  goto: [
    { key: "location", label: "地點 location", kind: "text", placeholder: "loc_ssp_flat" },
    { key: "spawn", label: "落地點 spawn", kind: "text", placeholder: "default" },
  ],
  reveal_secret: [
    { key: "npc", label: "NPC（留空＝說話者）", kind: "text" },
    { key: "secret", label: "秘密 id", kind: "text" },
  ],
  open_shop: [{ key: "npc", label: "商人 NPC", kind: "text" }],
  play_sfx: [{ key: "name", label: "音效 name", kind: "text" }],
  shake: [
    { key: "strength", label: "力度 strength", kind: "number" },
    { key: "time", label: "時間 time", kind: "number" },
  ],
  fade: [
    { key: "to", label: "方向 to", kind: "select", options: ["out", "in"] },
    { key: "time", label: "時間 time", kind: "number" },
  ],
};

/** The effect types the editor can render as rows, in the interpreter's vocabulary order. */
export const EFFECT_TYPES = Object.keys(EFFECT_FIELDS);

export function effectType(effect: unknown): string {
  return isRule(effect) ? toKey(effect["type"] ?? "") : "";
}

export function fieldSpecs(type: string): FieldSpec[] {
  return EFFECT_FIELDS[type] ?? [];
}

/** A fresh effect with the defaults the interpreter assumes when a field is absent. */
export function freshEffect(type: string): Rule {
  switch (type) {
    case "give":
    case "take":
      return { type, item: "", count: 1 };
    case "var":
      return { type, name: "", op: "add", value: 1 };
    case "say":
      return { type, text: {} };
    case "quest":
      return { type, quest: "", op: "start" };
    case "goto":
      return { type, location: "", spawn: "default" };
    case "shake":
      return { type, strength: 4, time: 0.25 };
    case "fade":
      return { type, to: "out", time: 0.4 };
    default:
      return { type };
  }
}

/**
 * One line naming what an effect does, for a collapsed row.
 *
 * Deliberately the primary parameter only: the point is to tell two `give` rows apart at a glance,
 * not to restate every field the row already shows.
 */
export function describeEffect(effect: unknown): string {
  if (!isRule(effect)) return "(無效效應 / invalid)";
  const type = effectType(effect);
  const specs = fieldSpecs(type);
  const primary = specs[0];
  if (!primary) return type === "" ? "(未設定 / unset)" : type;

  const value = effect[primary.key];
  const shown = primary.kind === "localized" ? localizedHead(value) : String(value ?? "");
  return shown === "" ? type : `${type} · ${shown}`;
}

function localizedHead(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRule(value)) return "";
  const ordered = ["zh_HK", "zh_CN", "en"];
  for (const locale of ordered) {
    const text = value[locale];
    if (typeof text === "string" && text.trim() !== "") return text;
  }
  return "";
}
