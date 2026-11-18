/**
 * The quest node machine (`quests.gd`, PLAN §5.4/§5.6).
 *
 * Quest state lives in the save as `quests[id] = {node, done}`. This machine listens for state
 * changes and walks the active node forward when its `complete_when` starts passing, applying
 * `on_complete` first. Two rules make it a machine rather than a polling loop:
 *
 * - **A cutscene node never auto-advances.** It waits for the player to dismiss the overlay, which
 *   calls `dismissCutscene()`. Otherwise a chapter could open and close its own cutscene in the same
 *   frame.
 * - **A pass is re-entrant-safe.** Applying `on_complete` changes state, which would normally
 *   schedule another pass — so a pass marks itself dirty instead of recursing, and loops until
 *   nothing progresses. That loop is bounded: content that chases its own tail stops with a warning
 *   rather than hanging the client.
 *
 * Everything is injected — node lookup, condition evaluation, effect application — so the machine
 * is testable without content, a scene, or a save.
 */

export interface QuestNode {
  id: string;
  /** `objective` (default) or `cutscene`. */
  type?: string;
  next?: string | null;
  complete_when?: unknown;
  on_complete?: unknown[];
  /** Localized line(s) a cutscene node shows. */
  text?: unknown;
}

export interface QuestRecord {
  node?: string;
  done?: boolean;
}

export interface QuestHooks {
  /** The quest's node definitions, from content. */
  nodes: (questId: string) => QuestNode[];
  /** Whether a `complete_when` condition passes in the current state. */
  evaluate: (condition: unknown) => boolean;
  /** Apply a node's `on_complete` effects, told which quest emitted them. */
  applyEffects: (effects: unknown[], context: { quest: string }) => void;
  onUpdated?: (questId: string, node: string) => void;
  onCompleted?: (questId: string) => void;
  onCutscene?: (questId: string, node: string) => void;
  onWarning?: (message: string) => void;
}

/** `quests.gd`'s `MAX_ROUNDS`: enough for a real chain, small enough to fail fast on a cycle. */
export const MAX_ROUNDS = 16;

export class QuestMachine {
  private inPass = false;
  private dirty = false;
  private awaiting: { quest: string; node: string } | null = null;

  /**
   * `questsOf` is a function, not the bag itself.
   *
   * The bag is replaced wholesale when a save is swapped in ("new game", or importing a code), and a
   * captured reference would leave the machine advancing quests in an object nobody reads any more:
   * the pass runs, finds nothing to do, and the game silently stops progressing.
   */
  constructor(
    private readonly questsOf: () => Record<string, unknown>,
    private readonly hooks: QuestHooks,
  ) {}

  /** Re-evaluate every active quest. Safe to call from inside `applyEffects`. */
  schedule(): void {
    if (this.inPass) {
      this.dirty = true;
      return;
    }
    this.runPass();
  }

  /** The player dismissed the cutscene the machine is waiting on. */
  dismissCutscene(): void {
    const waiting = this.awaiting;
    if (waiting === null) return;

    this.awaiting = null;
    const node = this.nodeDef(waiting.quest, waiting.node);
    // A cutscene the content no longer defines is not worth stranding the quest for.
    if (node !== null) this.completeNode(waiting.quest, node);
    this.schedule();
  }

  /** Which cutscene node, if any, the machine is waiting on. */
  get waitingOn(): { quest: string; node: string } | null {
    return this.awaiting;
  }

  private runPass(): void {
    if (this.inPass) {
      this.dirty = true;
      return;
    }

    this.inPass = true;
    this.dirty = false;

    let rounds = 0;
    let progressed = true;

    while (progressed && rounds < MAX_ROUNDS) {
      rounds += 1;
      progressed = false;
      for (const questId of Object.keys(this.questsOf())) {
        if (this.advance(questId)) progressed = true;
      }
    }

    this.inPass = false;

    if (progressed) {
      // Still moving at the ceiling: the node graph is cyclic, or `on_complete` re-triggers itself.
      this.dirty = false;
      this.hooks.onWarning?.(`quest pass hit ${MAX_ROUNDS} rounds — check for a cycle`);
      return;
    }

    // State changed mid-pass: one more bounded pass settles it.
    if (this.dirty) this.runPass();
  }

  private advance(questId: string): boolean {
    const record = this.record(questId);
    if (record === null || record.done === true) return false;

    const node = this.nodeDef(questId, String(record.node ?? ""));
    if (node === null) {
      this.hooks.onWarning?.(`quest '${questId}' points at an unknown node`);
      return false;
    }

    // Waits for the player: `dismissCutscene` is the only way past it.
    if ((node.type ?? "objective") === "cutscene") return false;

    const gate = node.complete_when;
    // No condition, no auto-advance — content has to be explicit about what finishes a node.
    if (gate === undefined || gate === null) return false;
    if (typeof gate === "object" && !Array.isArray(gate) && Object.keys(gate).length === 0) return false;
    if (!this.hooks.evaluate(gate)) return false;

    this.completeNode(questId, node);
    return true;
  }

  private completeNode(questId: string, node: QuestNode): void {
    const rewards = Array.isArray(node.on_complete) ? node.on_complete : [];
    if (rewards.length > 0) this.hooks.applyEffects(rewards, { quest: questId });

    // `on_complete` may have touched this quest — re-read before advancing.
    const record = this.record(questId);
    if (record === null || record.done === true) return;

    // JSON writes `"next": null` on a terminal node, and that null is not "absent".
    const next = typeof node.next === "string" ? node.next : "";
    if (next === "") {
      record.done = true;
      this.hooks.onCompleted?.(questId);
      return;
    }

    record.node = next;
    this.hooks.onUpdated?.(questId, next);

    const nextNode = this.nodeDef(questId, next);
    if (nextNode !== null && nextNode.type === "cutscene") {
      this.awaiting = { quest: questId, node: next };
      this.hooks.onCutscene?.(questId, next);
    }
  }

  private record(questId: string): QuestRecord | null {
    const raw = this.questsOf()[questId];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    return raw as QuestRecord;
  }

  private nodeDef(questId: string, nodeId: string): QuestNode | null {
    if (nodeId === "") return null;
    return this.hooks.nodes(questId).find((node) => node.id === nodeId) ?? null;
  }
}

/** The localized lines a cutscene node shows, ready for the overlay. */
export function cutsceneLines(node: QuestNode): unknown[] {
  const text = node.text;
  if (Array.isArray(text)) return text;
  if (text === undefined || text === null || text === "") return [];
  return [text];
}
