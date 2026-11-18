/**
 * The effect interpreter (§5.6) — the ONLY way game state changes.
 *
 * One funnel is what makes the per-NPC allowlist in §5.1 meaningful: doors, interactables, item
 * hooks, quest nodes and LLM-validated actions all mutate state through this module, so there is
 * exactly one door into a save.
 *
 * ## Why this returns events instead of emitting them
 *
 * The Godot original called `Game.set_flag(...)` and then `Bus.flag_set.emit(...)` inline. That
 * couples the rules to one runtime's autoloads, which is precisely what stopped the evaluator
 * and the validator from being shared. Here the mutation happens in place and the notifications
 * come back as a list the caller replays however it likes:
 *
 *   - the Phaser client fans them onto its bus (audio, HUD toasts, quest journal);
 *   - the server ignores presentation events and uses the state diff for previews;
 *   - the admin runs it against a hypothetical save to answer "what would this do?".
 *
 * The event names are deliberately the old signal names, so ported call sites stay readable.
 */

import { evaluate, type Condition } from "./conditions";
import {
  bucket,
  isRecord,
  pyBool,
  toFloat,
  toInt,
  toKey,
  type Locale,
} from "./state";

/** The mutable save state. A `GameState` is assignable to `ConditionState` by design. */
export interface GameState {
  flags: Record<string, unknown>;
  vars: Record<string, unknown>;
  inventory: Record<string, unknown>;
  visited: Record<string, unknown>;
  talk_counts: Record<string, unknown>;
  quests: Record<string, unknown>;
  held_item: string;
  time_of_day: string;
}

export type GameEvent =
  | { type: "effect_applied"; effect: Record<string, unknown> }
  | { type: "flag_set"; flag: string; value: boolean }
  | { type: "var_changed"; name: string; value: number }
  | { type: "item_gained"; item: string; count: number }
  | { type: "item_lost"; item: string; count: number }
  | { type: "inventory_changed" }
  | { type: "message_shown"; text: string }
  | { type: "quest_updated"; quest: string; node: string }
  | { type: "quest_completed"; quest: string }
  | { type: "goto_requested"; location: string; spawn: string }
  | { type: "secret_revealed"; npc: string; secret: string; text: string }
  | { type: "shop_opened"; npc: string }
  | { type: "sfx_requested"; name: string }
  | { type: "shake_requested"; strength: number; time: number }
  | { type: "fade_requested"; direction: "out" | "in"; time: number };

/** Read-only content access; the caller supplies it so this module never loads files. */
export interface ContentLookup {
  npc(id: string): Record<string, unknown> | undefined;
  quest(id: string): Record<string, unknown> | undefined;
  item(id: string): Record<string, unknown> | undefined;
  localize(field: unknown, locale: Locale): string;
}

export interface EffectContext {
  content: ContentLookup;
  locale: Locale;
  /**
   * `allow_flags` / `allow_items`. Absent means unrestricted — scripted content is trusted,
   * model output is not. An empty array also means unrestricted, matching the original.
   */
  allow_flags?: readonly string[];
  allow_items?: readonly string[];
  /** The speaking NPC, so a validated model action need only carry the secret id. */
  npc?: string;
}

export interface EffectOutcome {
  applied: number;
  events: GameEvent[];
  warnings: string[];
}

/**
 * Default stack cap when an item declares none. The client's `_max_stack` returns 999, and a
 * differing default here would silently change how many of an item a player can hold.
 */
const DEFAULT_STACK_MAX = 999;

export function emptyGameState(): GameState {
  return {
    flags: {},
    vars: {},
    inventory: {},
    visited: {},
    talk_counts: {},
    quests: {},
    held_item: "",
    time_of_day: "day",
  };
}

// ---------------------------------------------------------------------------
// State mutators — the client's `Game` methods, kept identical in behaviour.
// ---------------------------------------------------------------------------

export function itemCount(state: GameState, itemId: string): number {
  return toInt(bucket(state, "inventory")[itemId]);
}

export function maxStack(content: ContentLookup, itemId: string): number {
  const item = content.item(itemId);
  const declared = item?.["stack_max"];
  const cap = toInt(declared, DEFAULT_STACK_MAX);
  return cap > 0 ? cap : DEFAULT_STACK_MAX;
}

/** Returns how many were actually added (respects the item's `stack_max`, §5.2). */
export function addItem(
  state: GameState,
  content: ContentLookup,
  itemId: string,
  count = 1,
  events: GameEvent[] = [],
): number {
  if (itemId === "" || count <= 0) return 0;
  const current = itemCount(state, itemId);
  const cap = maxStack(content, itemId);
  const added = Math.min(count, cap - current);
  if (added <= 0) return 0;
  state.inventory[itemId] = current + added;
  events.push({ type: "item_gained", item: itemId, count: added });
  events.push({ type: "inventory_changed" });
  return added;
}

/** Returns how many were actually removed. */
export function removeItem(
  state: GameState,
  itemId: string,
  count = 1,
  events: GameEvent[] = [],
): number {
  const current = itemCount(state, itemId);
  const removed = Math.min(count, current);
  if (removed <= 0) return 0;
  if (current - removed <= 0) delete state.inventory[itemId];
  else state.inventory[itemId] = current - removed;
  events.push({ type: "item_lost", item: itemId, count: removed });
  events.push({ type: "inventory_changed" });
  return removed;
}

export function getVar(state: GameState, name: string, fallback = 0): number {
  return toFloat(bucket(state, "vars")[name], fallback);
}

export function setVar(
  state: GameState,
  name: string,
  value: number,
  events: GameEvent[] = [],
): void {
  state.vars[name] = value;
  events.push({ type: "var_changed", name, value });
}

export function setFlag(
  state: GameState,
  flag: string,
  value: boolean,
  events: GameEvent[] = [],
): void {
  state.flags[flag] = value;
  events.push({ type: "flag_set", flag, value });
}

// ---------------------------------------------------------------------------
// The interpreter
// ---------------------------------------------------------------------------

/** Apply an effect list. Returns how many effects actually applied, plus what happened. */
export function applyEffects(
  effects: unknown,
  state: GameState,
  context: EffectContext,
): EffectOutcome {
  const events: GameEvent[] = [];
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);

  if (!Array.isArray(effects)) {
    if (effects !== null && effects !== undefined) warn("effects must be a list");
    return { applied: 0, events, warnings };
  }

  let applied = 0;
  for (const raw of effects) {
    if (!isRecord(raw)) {
      warn(`skipping non-object effect ${JSON.stringify(raw)}`);
      continue;
    }
    if (applyOne(raw, state, context, events, warn)) {
      applied += 1;
      events.push({ type: "effect_applied", effect: raw });
    }
  }
  return { applied, events, warnings };
}

function applyOne(
  effect: Record<string, unknown>,
  state: GameState,
  context: EffectContext,
  events: GameEvent[],
  warn: (message: string) => void,
): boolean {
  const kind = toKey(effect["type"] ?? "");

  switch (kind) {
    case "set_flag": {
      const flag = toKey(effect["flag"] ?? "");
      if (flag === "") {
        warn("set_flag: empty flag");
        return false;
      }
      if (!permitted(context.allow_flags, flag)) {
        warn(`flag '${flag}' not permitted here`);
        return false;
      }
      setFlag(state, flag, pyBool(effect["value"] ?? true), events);
      return true;
    }

    case "give": {
      const item = toKey(effect["item"] ?? "");
      if (!permitted(context.allow_items, item)) {
        warn(`item '${item}' not permitted here`);
        return false;
      }
      return addItem(state, context.content, item, toInt(effect["count"] ?? 1), events) > 0;
    }

    case "take": {
      // Deliberately not allow-listed: losing an item can never corrupt a save into a
      // reward, and a scripted `take` must always be able to run.
      const item = toKey(effect["item"] ?? "");
      return removeItem(state, item, toInt(effect["count"] ?? 1), events) > 0;
    }

    case "var": {
      const name = toKey(effect["name"] ?? "");
      if (name === "") return false;
      const value = toFloat(effect["value"] ?? 0);
      if (toKey(effect["op"] ?? "add") === "set") setVar(state, name, value, events);
      else setVar(state, name, getVar(state, name) + value, events);
      return true;
    }

    case "say": {
      const text = context.content.localize(effect["text"], context.locale);
      if (text === "") {
        warn(`'say' has no text for locale ${context.locale}`);
        return false;
      }
      events.push({ type: "message_shown", text });
      return true;
    }

    case "quest":
      return applyQuest(effect, state, context, events, warn);

    case "goto": {
      events.push({
        type: "goto_requested",
        location: toKey(effect["location"] ?? ""),
        spawn: toKey(effect["spawn"] ?? "default"),
      });
      return true;
    }

    case "reveal_secret":
      return revealSecret(effect, state, context, events, warn);

    case "open_shop": {
      const npc = toKey(effect["npc"] ?? context.npc ?? "");
      if (npc === "") {
        warn("'open_shop' has no npc");
        return false;
      }
      events.push({ type: "shop_opened", npc });
      return true;
    }

    case "play_sfx": {
      // Presentation only (§5.6): surfaced as an event for whatever audio layer exists.
      events.push({ type: "sfx_requested", name: toKey(effect["name"] ?? "") });
      return true;
    }

    case "shake": {
      events.push({
        type: "shake_requested",
        strength: toFloat(effect["strength"] ?? 4.0),
        time: toFloat(effect["time"] ?? 0.25),
      });
      return true;
    }

    case "fade": {
      const direction = toKey(effect["to"] ?? "out");
      if (direction !== "out" && direction !== "in") {
        warn(`'fade' direction must be 'out' or 'in', got '${direction}'`);
        return false;
      }
      events.push({
        type: "fade_requested",
        direction,
        time: toFloat(effect["time"] ?? 0.4),
      });
      return true;
    }

    default:
      warn(`unknown effect type '${kind}'`);
      return false;
  }
}

/**
 * Absent key means unrestricted; a present but *empty* list also means unrestricted, matching
 * `allowed.is_empty() or allowed.has(id)` in the original. Only a non-empty list restricts.
 * Reading an empty list as "allow nothing" would silently disable every scripted effect that
 * passed `allow_flags: []`.
 */
function permitted(allowList: readonly string[] | undefined, id: string): boolean {
  if (allowList === undefined || allowList.length === 0) return true;
  return allowList.includes(id);
}

/**
 * `{"type":"quest","quest":<id>,"op":"start|advance|complete","node":<id>}` (§5.6).
 *
 * Quest records live in state so a save captures them; the quest machine in the client reacts
 * to the emitted events and evaluates `complete_when` / `on_complete` from there.
 */
function applyQuest(
  effect: Record<string, unknown>,
  state: GameState,
  context: EffectContext,
  events: GameEvent[],
  warn: (message: string) => void,
): boolean {
  const questId = toKey(effect["quest"] ?? "");
  const op = toKey(effect["op"] ?? "start");
  const definition = context.content.quest(questId);
  if (!isRecord(definition)) {
    warn(`unknown quest '${questId}'`);
    return false;
  }

  if (op === "start") {
    if (isRecord(bucket(state, "quests")[questId])) return true; // starting twice is a no-op

    const entry = definition["entry_requires"] as Condition;
    if (entry !== null && entry !== undefined && !evaluate(entry, state)) {
      warn(`quest '${questId}' entry requirements not met`);
      return false;
    }

    const nodes = Array.isArray(definition["nodes"]) ? definition["nodes"] : [];
    const first = isRecord(nodes[0]) ? toKey(nodes[0]["id"] ?? "") : "";
    if (first === "") {
      warn(`quest '${questId}' has no nodes`);
      return false;
    }
    state.quests[questId] = { node: first, done: false };
    events.push({ type: "quest_updated", quest: questId, node: first });
    return true;
  }

  if (op === "advance") {
    const record = bucket(state, "quests")[questId];
    if (!isRecord(record) || pyBool(record["done"] ?? false)) {
      warn(`cannot advance quest '${questId}'`);
      return false;
    }
    const node = toKey(effect["node"] ?? "");
    if (node === "") {
      warn("'advance' needs a node id");
      return false;
    }
    record["node"] = node;
    events.push({ type: "quest_updated", quest: questId, node });
    return true;
  }

  if (op === "complete") {
    const record = bucket(state, "quests")[questId];
    if (!isRecord(record)) {
      warn(`cannot complete unstarted quest '${questId}'`);
      return false;
    }
    if (pyBool(record["done"] ?? false)) return true; // idempotent
    record["done"] = true;
    events.push({ type: "quest_updated", quest: questId, node: toKey(record["node"] ?? "") });
    events.push({ type: "quest_completed", quest: questId });
    return true;
  }

  warn(`unknown quest op '${op}'`);
  return false;
}

/**
 * `{"type":"reveal_secret","npc":<id>,"secret":<id>}`.
 *
 * A validated model action carries only the secret id, so the speaking NPC arrives through
 * `context.npc`; scripted content names the npc explicitly. The reveal is recorded as
 * `secret_<id>` so it survives a save and can gate later conditions (§5.6 observability).
 */
function revealSecret(
  effect: Record<string, unknown>,
  state: GameState,
  context: EffectContext,
  events: GameEvent[],
  warn: (message: string) => void,
): boolean {
  const npcId = toKey(effect["npc"] ?? context.npc ?? "");
  const secretId = toKey(effect["secret"] ?? "");
  if (npcId === "" || secretId === "") {
    warn("'reveal_secret' needs an npc and a secret id");
    return false;
  }

  const npc = context.content.npc(npcId);
  const secrets = Array.isArray(npc?.["secrets"]) ? (npc["secrets"] as unknown[]) : [];
  const secret = secrets.find(
    (entry) => isRecord(entry) && toKey(entry["id"] ?? "") === secretId,
  );
  if (!isRecord(secret)) {
    warn(`npc '${npcId}' has no secret '${secretId}'`);
    return false;
  }

  const text = context.content.localize(secret["text"], context.locale);
  setFlag(state, `secret_${secretId}`, true, events);
  events.push({ type: "secret_revealed", npc: npcId, secret: secretId, text });
  events.push({ type: "message_shown", text });
  return true;
}
