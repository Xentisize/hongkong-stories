/* What is connected to what.
 *
 * An item is not a row in a table — it is *given* by someone, *wanted* by a step, and *needed* to
 * open a door. Those relationships already exist as references in the content (`has_item`, `talked`,
 * `add_item`, `npc`, an exit's `to`), so the graph is **derived from them** rather than authored a
 * second time. That is the same rule the story map and the quest flow follow: one source of truth,
 * several pictures of it.
 *
 * Flags are part of the picture because they are the invisible glue: a `set_flag` effect writes one,
 * a condition somewhere else waits on it, and nothing in the content says so in one place. Drawing
 * them as nodes is what turns "why does this never unlock?" into a visible answer.
 *
 * The label on an edge comes from the field that holds the reference, plus the effect that owns it:
 * a path ending in `has_item` means "needs", `add_item` means "gives", and a `flag` under a
 * `set_flag` effect means "sets" while the same key under any condition means "waits on".
 */

import { declaredLinks } from "@hkstories/core";

export type RefKind = "item" | "npc" | "quest" | "chapter" | "location" | "flag" | "unknown";

export interface Ref {
  /** What the other end is. */
  kind: RefKind;
  id: string;
  /** The relationship, in words a creator reads ("需要持有 / needs", "設定 / sets"). */
  label: string;
  /** The field path that carries the reference, for the "why is this here?" case. */
  path: string;
  /** True when a person wrote this link; false (or absent) when the engine's own fields imply it. */
  declared?: boolean;
}

export interface Connections {
  /** What this document points at. */
  outbound: Ref[];
  /** Who points at it, and how. */
  inbound: Ref[];
}

/** A relationship that is missing, phrased as something an author can act on. */
export type GapKind = "item-no-giver" | "flag-nothing-sets" | "flag-nothing-reads";

export interface Gap {
  kind: GapKind;
  /** The sentence shown to the author. */
  hint: string;
  /** The instruction handed to the co-pilot, so "fix it" needs no retyping. */
  intent: string;
}

type Pack = Record<string, Record<string, unknown>>;

/** A reference found while walking a document. */
interface Walked {
  id: string;
  path: string;
  /** True when the reference is a flag name rather than an entity id. */
  isFlag: boolean;
  /** The nearest enclosing `type` (“set_flag”, “add_item”, …), which names the relationship. */
  context: string;
}

/** A rough classifier, from the id conventions the pack already follows. */
export function refKind(id: string): RefKind {
  if (id.startsWith("item_")) return "item";
  if (id.startsWith("npc_")) return "npc";
  if (id.startsWith("loc_")) return "location";
  if (id.startsWith("ch")) return "chapter";
  return "unknown";
}

/** The relationship a field expresses. Unknown fields keep their path as the label. */
export function labelFor(path: string, context = ""): string {
  const segments = path.split(".");
  let last = segments.pop() ?? path;
  // `items_may_give.0` says nothing; its key does. An index is a position, not a relationship.
  if (/^\d+$/.test(last)) last = segments.pop() ?? last;

  // The same `flag` key means opposite things depending on the effect that owns it.
  if (last === "flag") return context === "set_flag" ? "設定 / sets" : "等緊 / waits on";

  if (last === "has_item" || last === "use_requires") return "需要持有 / needs";
  if (last === "items_may_give" || last === "gives" || last === "give" || last === "reward") {
    return "可以給予 / can give";
  }
  if (last === "add_item" || last === "item") return "給予 / gives";
  if (last === "talked") return "要對話 / talk to";
  if (last === "npc") return "出場 / placed in";
  if (last === "to") return "通往 / leads to";
  if (last === "id" || last === "quest") return "屬於 / belongs to";
  if (last === "all" || last === "any") return "其中一個條件 / one of";
  return last;
}

/** Every reference inside a document: entity ids by convention, flags by their field name. */
function walk(value: unknown, path: string, out: Walked[], context = ""): void {
  if (typeof value === "string") {
    const key = path.split(".").pop() ?? "";
    if (/^(item_|npc_|loc_|ch\d)/.test(value)) {
      out.push({ id: value, path, isFlag: false, context });
    } else if (key === "flag" && value.trim() !== "") {
      out.push({ id: value.trim(), path, isFlag: true, context });
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${path}.${index}`, out, context));
    return;
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const owner = typeof record["type"] === "string" ? record["type"] : context;
    for (const [key, entry] of Object.entries(record)) {
      walk(entry, path === "" ? key : `${path}.${key}`, out, owner);
    }
  }
}

function refsOf(doc: unknown): Walked[] {
  const out: Walked[] = [];
  walk(doc, "", out);
  return out;
}

const KIND_LABEL: Record<string, string> = {
  npcs: "角色 characters",
  items: "物品 items",
  quests: "任務 quests",
  locations: "場景 scenes",
  chapters: "章節 chapters",
  lore: "典故 lore",
  settings: "設定 settings",
  flags: "旗標 flags",
};

/** Human name for the table a document lives in. */
export function tableLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

/** Every flag the pack mentions — set, waited on, or both. */
export function flagsIn(pack: Pack): string[] {
  const names = new Set<string>();
  for (const docs of Object.values(pack)) {
    for (const doc of Object.values(docs ?? {})) {
      for (const entry of refsOf(doc)) if (entry.isFlag) names.add(entry.id);
    }
  }
  return [...names].sort();
}

function toRef(entry: Walked): Ref {
  return {
    kind: entry.isFlag ? "flag" : refKind(entry.id),
    id: entry.id,
    label: labelFor(entry.path, entry.context),
    path: entry.path,
  };
}

/**
 * The connections of one document, or of one flag.
 *
 * `outbound` is what the document itself names; `inbound` is every other document that names it.
 * A document does not count as its own connection, which keeps "who else" answerable at a glance.
 */
export function connectionsFor(pack: Pack, kind: string, id: string): Connections {
  const self = pack[kind]?.[id];
  const outbound: Ref[] = [];
  const inbound: Ref[] = [];

  if (self !== undefined) {
    for (const entry of refsOf(self)) {
      if (!entry.isFlag && entry.id === id) continue;
      outbound.push(toRef(entry));
    }
  }

  for (const [table, docs] of Object.entries(pack)) {
    if (table === "flags") continue;
    for (const [otherId, doc] of Object.entries(docs ?? {})) {
      if (table === kind && otherId === id) continue;
      const matches = refsOf(doc).filter((entry) =>
        kind === "flags" ? entry.isFlag && entry.id === id : !entry.isFlag && entry.id === id,
      );
      if (matches.length > 0) {
        // A document often mentions the same id twice (`items_may_give` and the action that gives it);
        // reporting the mention whose field says *what the relationship is* reads better than the first.
        const hit = matches.find((entry) => !/^\d+$/.test(labelFor(entry.path, entry.context))) ?? matches[0]!;
        // The other end of an inbound edge is the *owner* document, not the thing being looked at.
        inbound.push({
          kind: refKind(otherId),
          id: otherId,
          label: `${labelFor(hit.path, hit.context)}（${tableLabel(table)}）`,
          path: hit.path,
        });
      }

      // Someone may also have *written* a link to this: narrative, never enforced, always marked.
      for (const link of declaredLinks(doc)) {
        if (link.to !== id) continue;
        inbound.push({
          kind: refKind(otherId),
          id: otherId,
          label: `聲明 / declared（${link.kind}）（${tableLabel(table)}）`,
          path: "links",
          declared: true,
        });
      }
    }
  }

  if (kind === "flags") {
    // A flag is passive: it has nothing of its own to point at.
    return { outbound: [], inbound: dedupe(inbound) };
  }

  // Declared narrative links: what a person wrote, not what the engine implies. They are marked so
  // the picture never lets a note pass for a mechanic.
  declaredLinks(self).forEach((link, index) => {
    outbound.push({
      kind: refKind(link.to),
      id: link.to,
      label: `聲明 / declared（${link.kind}）`,
      path: `links[${index}]`,
      declared: true,
    });
  });

  return { outbound: dedupe(outbound), inbound: dedupe(inbound) };
}

function dedupe(refs: Ref[]): Ref[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}/${ref.id}/${ref.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One line an author can act on: "who wants this, and what does it unlock". */
export function summarise(connections: Connections): string[] {
  const givers = connections.inbound.filter((ref) => ref.label.includes("給予")).length;
  const needs = connections.inbound.filter((ref) => ref.label.includes("需要")).length + connections.inbound.filter((ref) => ref.label.includes("要對話")).length;
  const unlocks = connections.outbound.length;
  return [
    givers > 0 ? `${givers} 個人會畀呢樣嘢 / ${givers} giver(s)` : "冇人畀呢樣嘢 / nothing gives this",
    needs > 0 ? `${needs} 樣嘢需要佢 / ${needs} thing(s) need it` : "冇嘢需要佢 / nothing needs it",
    unlocks > 0 ? `佢指向 ${unlocks} 樣嘢 / it points at ${unlocks}` : "佢冇指向任何嘢 / it points at nothing yet",
  ];
}

/**
 * The gaps worth telling someone about.
 *
 * Deliberately only the ones that make a *silent* failure: an item the player can never obtain, and
 * a flag that is waited on but never set (or set and never read). Each comes with the sentence the
 * author reads and the instruction the co-pilot can act on, so "fix it" is one click.
 */
export function gapsFor(pack: Pack, kind: string, id: string): Gap[] {
  const connections = connectionsFor(pack, kind, id);
  const gaps: Gap[] = [];

  if (kind === "items") {
    const givers = connections.inbound.filter((ref) => ref.label.includes("給予"));
    if (givers.length === 0) {
      gaps.push({
        kind: "item-no-giver",
        hint: "冇人會畀呢件物品，玩家永遠攞唔到。/ nothing gives this item, so the player can never get it.",
        intent:
          `令 ${id} 有人可以畀：加一個 NPC 動作或任務效果去給出 ${id}，並保持其他內容不變。` +
          ` / make ${id} obtainable: add an NPC action or a quest effect that gives ${id}, changing nothing else.`,
      });
    }
  }

  if (kind === "flags") {
    const setters = connections.inbound.filter((ref) => ref.label.includes("設定"));
    const readers = connections.inbound.filter((ref) => ref.label.includes("等緊"));
    if (setters.length === 0) {
      gaps.push({
        kind: "flag-nothing-sets",
        hint: `「${id}」有人等緊，但冇任何效果會設定佢，所以嗰步永遠唔會發生。/ "${id}" is waited on but nothing sets it, so that step can never happen.`,
        intent:
          `令旗標 ${id} 真係會被設定：喺最合適嘅 NPC 動作或任務效果加 set_flag ${id}，其他內容不變。` +
          ` / make the flag ${id} actually get set: add a set_flag ${id} effect where it belongs, changing nothing else.`,
      });
    }
    if (readers.length === 0) {
      gaps.push({
        kind: "flag-nothing-reads",
        hint: `「${id}」會被設定，但冇任何條件讀佢，所以設定咗都冇效果。/ "${id}" is set but nothing reads it, so setting it changes nothing.`,
        intent:
          `令旗標 ${id} 有用：喺最合適嘅條件加佢做條件，或者刪走設定佢嘅效果。` +
          ` / make ${id} matter: use it in a condition, or remove the effect that sets it.`,
      });
    }
  }

  return gaps;
}
