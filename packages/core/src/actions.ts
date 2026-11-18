/**
 * Action allowlist enforcement (§5.1, §7.3).
 *
 * The model performs; the game decides. Every action an NPC asks for is checked against that
 * NPC's declared `llm` block before it reaches the client, and rejects are returned rather than
 * silently dropped — that is how model drift becomes visible without ever corrupting a save.
 *
 * This is policy, not transport: it stays server-side even after the LLM plumbing moves to
 * TanStack AI. The framework proves the *shape* of a reply; this proves the character was
 * allowed to do it.
 */

import { bucket, isRecord, pyBool, toFloat, toInt, toKey } from "./state";

/** A model may do at most two things per turn. */
export const MAX_ACTIONS_PER_TURN = 2;

export type ActionRejection =
  | "too_many_actions"
  | "not_an_object"
  | "type_not_allowed"
  | "item_not_allowed"
  | "not_held"
  | "flag_not_allowed"
  | "var_not_allowed"
  | "var_out_of_bounds"
  | "unknown_secret";

export interface RejectedAction {
  action: unknown;
  reason: ActionRejection;
}

export interface ActionVerdict {
  accepted: Record<string, unknown>[];
  rejected: RejectedAction[];
}

export interface ActionState {
  inventory?: Record<string, unknown>;
  vars?: Record<string, unknown>;
}

/** The subset of an NPC definition that governs what it may do. */
export interface NpcLike {
  llm?: unknown;
  secrets?: unknown;
  [key: string]: unknown;
}

/**
 * Validate the actions a model proposed.
 *
 * Order matters and is preserved from the original: the per-turn cap is tested *before* the
 * action is even inspected, so a third entry is rejected as `too_many_actions` rather than for
 * whatever else might be wrong with it.
 */
export function validateActions(
  rawActions: unknown,
  npc: NpcLike,
  state: ActionState = {},
): ActionVerdict {
  const llm = isRecord(npc.llm) ? npc.llm : {};
  const allowedTypes = new Set(asStrings(llm["actions_allowed"]));
  const mayGive = new Set(asStrings(llm["items_may_give"]));
  const mayTake = new Set(
    llm["items_may_take"] === undefined ? asStrings(llm["items_may_give"]) : asStrings(llm["items_may_take"]),
  );
  const mayFlag = new Set(asStrings(llm["flags_may_set"]));
  const varBounds = isRecord(llm["vars_may_change"]) ? llm["vars_may_change"] : {};

  const inventory = bucket({ inventory: state.inventory }, "inventory");
  const variables = bucket({ vars: state.vars }, "vars");

  const accepted: Record<string, unknown>[] = [];
  const rejected: RejectedAction[] = [];

  if (!Array.isArray(rawActions)) return { accepted, rejected };

  for (const raw of rawActions) {
    if (accepted.length >= MAX_ACTIONS_PER_TURN) {
      rejected.push({ action: raw, reason: "too_many_actions" });
      continue;
    }
    if (!isRecord(raw)) {
      rejected.push({ action: raw, reason: "not_an_object" });
      continue;
    }

    const kind = toKey(raw["type"] ?? "");
    if (!allowedTypes.has(kind)) {
      rejected.push({ action: raw, reason: "type_not_allowed" });
      continue;
    }

    if (kind === "give") {
      const item = toKey(raw["item"] ?? "");
      if (!mayGive.has(item)) {
        rejected.push({ action: raw, reason: "item_not_allowed" });
        continue;
      }
      accepted.push({ ...raw, item, count: clampInt(raw["count"] ?? 1, 1, 1) });
      continue;
    }

    if (kind === "take") {
      const item = toKey(raw["item"] ?? "");
      if (!mayTake.has(item)) {
        rejected.push({ action: raw, reason: "item_not_allowed" });
        continue;
      }
      if (toInt(inventory[item]) <= 0) {
        rejected.push({ action: raw, reason: "not_held" });
        continue;
      }
      accepted.push({ ...raw, item, count: clampInt(raw["count"] ?? 1, 1, 1) });
      continue;
    }

    if (kind === "set_flag") {
      const flag = toKey(raw["flag"] ?? "");
      if (!mayFlag.has(flag)) {
        rejected.push({ action: raw, reason: "flag_not_allowed" });
        continue;
      }
      accepted.push({ ...raw, flag, value: pyBool(raw["value"] ?? true) });
      continue;
    }

    if (kind === "var") {
      const name = toKey(raw["name"] ?? "");
      const bounds = varBounds[name];
      if (!isRecord(bounds)) {
        rejected.push({ action: raw, reason: "var_not_allowed" });
        continue;
      }
      const current = toFloat(variables[name]);
      const delta = toFloat(raw["value"] ?? 0);
      const low = toFloat(bounds["min"], -1e9);
      const high = toFloat(bounds["max"], 1e9);
      if (!(low <= current + delta && current + delta <= high)) {
        rejected.push({ action: raw, reason: "var_out_of_bounds" });
        continue;
      }
      accepted.push({ ...raw, name, value: delta });
      continue;
    }

    if (kind === "reveal_secret") {
      const secret = toKey(raw["secret"] ?? "");
      const known = new Set(
        (Array.isArray(npc.secrets) ? npc.secrets : [])
          .filter(isRecord)
          .map((entry) => toKey(entry["id"] ?? "")),
      );
      if (!known.has(secret)) {
        rejected.push({ action: raw, reason: "unknown_secret" });
        continue;
      }
      accepted.push({ ...raw, secret });
      continue;
    }

    accepted.push(raw);
  }

  return { accepted, rejected };
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => toKey(entry));
}

function clampInt(value: unknown, low: number, high: number): number {
  const number = toInt(value, low);
  return Math.max(low, Math.min(high, number));
}
