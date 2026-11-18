/* A playable first slice, built deterministically.
 *
 * The beginner path must not depend on a model being reachable: "ten minutes to something you can
 * walk around in" is a promise, and a wizard that fails when the API key is missing is not one. So
 * the starter is *derived* from three choices the author already understands — a scene, a character,
 * an item — and writes ordinary documents:
 *
 *   - a copy of the chosen scene with the character standing on it,
 *   - a three-step quest that asks the player to find the item and bring it back,
 *   - the item itself, if the pack does not already have one.
 *
 * The co-pilot can still write something richer later; this is the floor, not the ceiling.
 */

import { placeNpc, type MapNpc, type TileMap } from "./map";
import type { QuestDoc, QuestNode } from "./questDoc";

export interface StarterChoice {
  /** The scene the author picked: its document is the base. */
  scene: Record<string, unknown>;
  sceneId: string;
  npcId: string;
  itemId: string;
  /** Display names, so the generated quest reads like a sentence rather than ids. */
  names: { scene: string; npc: string; item: string };
}

export interface Starter {
  location: { id: string; doc: Record<string, unknown> };
  quest: QuestDoc;
}

/** Somewhere sensible to stand: the middle of the first walkable row, or the first free cell. */
export function standingTile(tilemap: unknown): [number, number] {
  const rows = Array.isArray(tilemap) ? tilemap.filter((row): row is string => typeof row === "string") : [];
  const height = rows.length;
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const y = Math.max(0, Math.floor(height / 2));
  for (let x = Math.max(0, Math.floor(width / 2)); x < width; x += 1) {
    const char = rows[y]?.[x];
    if (char !== undefined && char !== "#") return [x, y];
  }
  return [Math.max(0, Math.floor(width / 2)), y];
}

/** A three-step quest: meet them, find the thing, bring it back. */
export function starterQuest({ sceneId, npcId, itemId, names }: StarterChoice): QuestDoc {
  const id = `${sceneId.replace(/^loc_/, "")}_intro`;
  const nodes: QuestNode[] = [
    {
      id: "n1",
      type: "objective",
      text: { zh_HK: `去${names.scene}搵${names.npc}傾偈。`, en: `Find ${names.npc} at ${names.scene}.` },
      complete_when: { talked: npcId, min: 1 },
      next: "n2",
      on_complete: [],
    },
    {
      id: "n2",
      type: "objective",
      text: { zh_HK: `搵到${names.item}。`, en: `Find the ${names.item}.` },
      complete_when: { has_item: itemId },
      next: "n3",
      on_complete: [],
    },
    {
      id: "n3",
      type: "cutscene",
      text: [
        { zh_HK: "搞掂。條街而家識得你。", en: "Done. The street knows you now." },
        { zh_HK: "打開下一章，睇吓仲有咩。", en: "Open the next chapter to see what else is here." },
      ],
      next: null,
      on_complete: [{ type: "set_flag", flag: `${id}_done` }],
    },
  ];

  return {
    schema_version: 1,
    id,
    title: { zh_HK: `第一次上街`, en: "First time out" },
    entry_requires: null,
    nodes,
  };
}

/** The chosen scene with the character placed on it, under a new id so the original stays intact. */
export function starterScene(choice: StarterChoice): { id: string; doc: Record<string, unknown> } {
  const id = `${choice.sceneId}_intro`;
  const doc = structuredClone(choice.scene) as Record<string, unknown>;
  doc["id"] = id;
  const title = doc["title"];
  if (typeof title === "object" && title !== null && !Array.isArray(title)) {
    doc["title"] = {
      ...(title as Record<string, unknown>),
      zh_HK: `${String((title as Record<string, unknown>)["zh_HK"] ?? choice.names.scene)}（起步）`,
    };
  }

  const existing: MapNpc[] = Array.isArray(doc["npcs"]) ? (doc["npcs"] as MapNpc[]) : [];
  const [x, y] = standingTile(doc["tilemap"]);
  doc["npcs"] = placeNpc(existing, choice.npcId, x, y);

  return { id, doc };
}

export function buildStarter(choice: StarterChoice): Starter {
  return { location: starterScene(choice), quest: starterQuest(choice) };
}

/** Exposed for the wizard's preview line: what the author is about to get. */
export function describeStarter(starter: Starter): string[] {
  const tilemap = (starter.location.doc["tilemap"] ?? []) as TileMap;
  return [
    `場景 ${starter.location.id}（${tilemap.length} 行）`,
    `任務 ${starter.quest.id}（${(starter.quest.nodes ?? []).length} 步）`,
  ];
}
