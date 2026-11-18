import type { ConditionState } from "@hkstories/core";

import { emptySave, type SavePayload } from "./save";

/**
 * The game state a save carries, with the bookkeeping `game.gd` performs.
 *
 * Conditions read a projection of this (`toConditionState`), the dialogue bumps a talk count when a
 * turn lands, and the save code serialises the whole thing — so all three have to agree on the
 * rules, which is why they live here rather than in the shell.
 *
 * Every mutator matches `game.gd`, including the parts that look incidental: an item stack caps at
 * `stack_max` (999 when a definition does not say), removing the last one erases the key instead of
 * leaving a zero, and a held item that is not in the inventory is dropped.
 */

/** `game.gd`'s fallback when an item definition has no `stack_max`. */
export const DEFAULT_STACK_MAX = 999;

/** The minimum a store needs; `localStorage` satisfies it and a test can pass a Map-backed fake. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const SAVE_STORAGE_KEY = "hks.save.v1";

export interface GameStateOptions {
  /** `stack_max` per item id, from content. Absent definitions fall back to 999. */
  stackMax?: (itemId: string) => number | undefined;
  onChange?: (save: SavePayload) => void;
}

export class GameState {
  private payload: SavePayload;

  constructor(
    payload: SavePayload = emptySave(),
    private readonly options: GameStateOptions = {},
  ) {
    this.payload = payload;
    // A restored save can carry a held item the inventory lost; settle it on load, as from_dict does.
    this.settleHeldItem();
  }

  get save(): SavePayload {
    return this.payload;
  }

  /** The projection conditions read. Cheap enough to call per evaluation. */
  conditionState(): ConditionState {
    return {
      flags: this.payload.flags,
      vars: this.payload.vars,
      inventory: this.payload.inventory,
      visited: this.payload.visited,
      talk_counts: this.payload.talk_counts,
      quests: this.payload.quests,
      held_item: this.payload.held_item,
      time_of_day: this.payload.time_of_day,
    };
  }

  flag(flag: string): boolean {
    return this.payload.flags[flag] === true;
  }

  setFlag(flag: string, value: boolean): void {
    this.payload.flags[flag] = value;
    this.emit();
  }

  variable(name: string, fallback = 0): number {
    const value = Number(this.payload.vars[name]);
    return Number.isFinite(value) ? value : fallback;
  }

  setVar(name: string, value: number): void {
    this.payload.vars[name] = value;
    this.emit();
  }

  addVar(name: string, delta: number): void {
    this.setVar(name, this.variable(name) + delta);
  }

  count(itemId: string): number {
    const value = Number(this.payload.inventory[itemId]);
    return Number.isInteger(value) && value > 0 ? value : 0;
  }

  hasItem(itemId: string, count = 1): boolean {
    return this.count(itemId) >= count;
  }

  stackMax(itemId: string): number {
    const declared = this.options.stackMax?.(itemId);
    const max = Number(declared);
    return Number.isFinite(max) && max > 0 ? max : DEFAULT_STACK_MAX;
  }

  /** Adds up to the stack ceiling. Returns how many actually landed, like `game.gd`. */
  addItem(itemId: string, count = 1): number {
    if (itemId === "" || count <= 0) return 0;

    const current = this.count(itemId);
    const added = Math.min(count, this.stackMax(itemId) - current);
    if (added <= 0) return 0;

    this.payload.inventory[itemId] = current + added;
    this.emit();
    return added;
  }

  /** Removes up to what is held, erasing the key when the last one goes. */
  removeItem(itemId: string, count = 1): number {
    const current = this.count(itemId);
    const removed = Math.min(count, current);
    if (removed <= 0) return 0;

    if (current - removed <= 0) delete this.payload.inventory[itemId];
    else this.payload.inventory[itemId] = current - removed;

    // Empty hands are a real state, not a stale id.
    if (this.payload.held_item === itemId && !this.hasItem(itemId)) this.payload.held_item = "";
    this.emit();
    return removed;
  }

  /** Holding something requires having it; anything else starts empty-handed. */
  setHeld(itemId: string): void {
    this.payload.held_item = this.hasItem(itemId) ? itemId : "";
    this.emit();
  }

  /** `dialogue.gd`: every completed turn counts, and `talked` conditions read the total. */
  bumpTalk(npcId: string): number {
    const next = this.talkCount(npcId) + 1;
    this.payload.talk_counts[npcId] = next;
    this.emit();
    return next;
  }

  talkCount(npcId: string): number {
    const value = Number(this.payload.talk_counts[npcId]);
    return Number.isInteger(value) && value > 0 ? value : 0;
  }

  markVisited(locationId: string): void {
    if (locationId === "") return;
    this.payload.visited[locationId] = true;
    this.emit();
  }

  setQuest(questId: string, record: { node?: string; done?: boolean }): void {
    this.payload.quests[questId] = { ...(record as Record<string, unknown>) };
    this.emit();
  }

  setTimeOfDay(time: string): void {
    this.payload.time_of_day = time;
    this.emit();
  }

  /** Replace the whole payload — restoring a slot, or importing a shared code. */
  replace(payload: SavePayload): void {
    this.payload = payload;
    this.settleHeldItem();
    this.emit();
  }

  private settleHeldItem(): void {
    const held = this.payload.held_item;
    if (held !== "" && this.count(held) <= 0) this.payload.held_item = "";
  }

  private emit(): void {
    this.options.onChange?.(this.payload);
  }
}

/** Store the slot. Kept separate from the code format: a slot is local, a code is shareable. */
export function persist(save: SavePayload, store: StorageLike | undefined = globalThis.localStorage): void {
  if (!store) return;
  try {
    store.setItem(SAVE_STORAGE_KEY, JSON.stringify(save));
  } catch {
    // Private-mode browsers refuse writes. Losing the slot is not worth losing the session over.
  }
}

export function restore(store: StorageLike | undefined = globalThis.localStorage): SavePayload | null {
  if (!store) return null;
  try {
    const raw = store.getItem(SAVE_STORAGE_KEY);
    if (raw === null) return null;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    // The slot is trusted only as far as it is well formed; everything else is defaulted.
    return { ...emptySave(), ...(parsed as Partial<SavePayload>) };
  } catch {
    return null;
  }
}
