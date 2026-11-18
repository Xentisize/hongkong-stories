import { evaluate, isRecord, toKey, type ConditionState } from "@hkstories/core";

/**
 * Prompt assembly with a byte-stable cache prefix (PLAN 7.2, 7.7), ported from
 * `server/app/llm/prompts.py`.
 *
 * Ordering is the whole cost strategy. The system message holds only text that cannot change
 * between turns for a given (npc, lang, event-page) triple — persona, world rules, lore, output
 * contract, register — so it hits the provider cache instead of full price. History is
 * append-only and therefore prefix-stable too. Everything volatile (revealed secrets, player
 * state, the current line) goes in the final user message, where it is tiny.
 *
 * The condition checks go through `@hkstories/core`, so which event page is active and which
 * secrets are visible here cannot disagree with the client or the admin.
 */

type Npc = Record<string, unknown>;

export const WORLD_RULES = `You are a character inside a Hong Kong historical drama game. Rules:
1. Stay in character at all times. Never mention being a model, an AI, a prompt, or a game system.
2. Only state facts that appear in the LORE section. If you do not know something, react to it in
   character — deflect, misremember, change the subject, or admit you do not remember. Never invent
   dates, names, deaths, prices or events.
3. Never speak or narrate for the player. Do not describe the player's thoughts or actions.
4. Reply with 1-3 short sentences, as speech only. No narration, no stage directions, no emoji.
5. Never discuss present-day politics, and never take a side in an argument about it. If the player
   pushes, brush it off in character the way your persona would.
6. Keep to your own life: work, family, food, money, neighbours, the street. That is your world.`;

const OUTPUT_CONTRACT = `Output contract: reply with a single JSON object and nothing else.
{"say": <string, your spoken line>, "mood": <one of neutral|warm|gruff|wistful|amused|wary|sad>,
 "actions": [<zero or more state changes>]}
\`actions\` is usually empty. An action is only valid if it is listed as permitted for you in the
PERMITTED ACTIONS section; requests for anything else must be expressed as speech instead.
Action shapes: {"type":"give","item":<id>} | {"type":"take","item":<id>} |
{"type":"set_flag","flag":<id>,"value":<bool>} | {"type":"var","name":<id>,"value":<number>} |
{"type":"reveal_secret","secret":<id>}`;

const REGISTER: Record<string, string> = {
  // Measured, not assumed: the previous wording asked for "WRITTEN CANTONESE (粵文)" — the *literary*
  // register — and sampled clean only because the model carries Cantonese on its own. What a character
  // in this game sounds like is 香港口語: how a person on that street actually talks.
  zh_HK: `Language: reply in the Cantonese a Hong Kong person actually speaks (香港口語, Traditional
characters) — not 書面語, not the written 粵文 register, and not Mandarin with Cantonese words in it.
Use Cantonese words and grammar: 係 / 唔 / 咗 / 嘅 / 喺 / 哋 / 嗰 / 冇 / 咩 / 佢 / 而家 / 得閒.
End sentences the way people talk — 啦 / 喇 / 囉 / 喎 / 咋 / 嘛 / 㗎 — a few, not on every sentence.
Say it the Cantonese way instead of translating Mandarin:
我唔知 (not 我不知道) · 你去咗邊度 (not 你去了哪裡) · 呢樣嘢 (not 這個東西) ·
佢係我老竇 (not 他是我的父親) · 好靚 (not 很漂亮) · 食咗飯喇 (not 已經吃了飯了) ·
邊個 (not 誰) · 咩事 (not 甚麼事) · 冇 (not 沒有).
Do not use 的 / 是 / 很 / 們 / 他 / 她 / 這 / 那 / 甚麼 / 誰 as function words, and do not compose
written sentences (否則 / 然而 / 因此 / 由於 / 以及 / 給 / 讓).
Loanwords Hong Kongers really say are fine (巴士, 的士, 士多, 隔籬); nothing else in English.
Speak as your persona speaks: an older shopkeeper on this street does not use a young person's slang.`,
  zh_CN: `Language: reply in Simplified Chinese using standard written Chinese (書面語).
Never use Cantonese particles or Cantonese-only characters.`,
  en: `Language: reply in English, in the same voice and register as your persona.`,
};

const LANGUAGE_REMINDER: Record<string, string> = {
  zh_HK:
    "LANGUAGE REMINDER: this turn's reply must be spoken Hong Kong Cantonese in Traditional characters (係 / 唔 / 咗 / 嘅 / 冇), not Mandarin and not written Chinese — even if the player has just written Mandarin or English, and even if the history above is in another language.",
  zh_CN:
    "LANGUAGE REMINDER: this turn's reply must be in Simplified Chinese (書面語, no Cantonese particles), even if the history above is in another language.",
  en: "LANGUAGE REMINDER: this turn's reply must be in English, even if the history above is in another language.",
};

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => toKey(entry)) : [];
}

function trimOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** A localised value, or the first non-empty string it holds. */
function displayName(npc: Npc): string {
  const name = npc["display_name"];
  if (typeof name === "string" && name.trim()) return name;
  if (isRecord(name)) {
    for (const key of ["en", "zh_HK", "zh_CN"]) {
      const value = name[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return toKey(npc["id"]);
}

/**
 * The NPC's active event page (RPG Maker's conditional pages, §5.1).
 *
 * `states` is ordered; the FIRST entry whose `requires` passes wins, and no match falls back to
 * the base definition.
 */
export function activeState(npc: Npc, state: ConditionState): Record<string, unknown> {
  const pages = Array.isArray(npc["states"]) ? npc["states"] : [];
  for (const entry of pages) {
    if (isRecord(entry) && evaluate(entry["requires"], state)) return entry;
  }
  return {};
}

function personaBlock(npc: Npc, page: Record<string, unknown>): string {
  const persona = isRecord(npc["persona"]) ? npc["persona"] : {};
  const patch = isRecord(page["persona_patch"]) ? page["persona_patch"] : {};

  const lines = [`CHARACTER: ${displayName(npc)} (${toKey(npc["id"])})`];
  for (const [key, label] of [
    ["role", "Who you are"],
    ["voice", "How you speak"],
    ["wants", "What you want"],
  ] as const) {
    const patched = patch[key];
    const value = typeof patched === "string" && patched.trim() ? patched : persona[key];
    if (typeof value === "string" && value.trim()) lines.push(`${label}: ${value.trim()}`);
  }

  const patchedTaboos = patch["taboos"];
  const taboos = Array.isArray(patchedTaboos) && patchedTaboos.length ? patchedTaboos : persona["taboos"];
  if (Array.isArray(taboos) && taboos.length > 0) {
    lines.push("Never: " + taboos.map((entry) => String(entry)).join("; "));
  }
  return lines.join("\n");
}

function loreBlock(npc: Npc, page: Record<string, unknown>): string {
  const extra = trimOr(page["lore_extra"], "");
  const lore = typeof npc["lore"] === "string" ? npc["lore"].trim() : "";

  if (lore || extra) {
    let body = lore;
    if (extra) {
      body = (body ? body + "\n\n" : "") + "WHAT CHANGED RECENTLY (now true of your world):\n" + extra;
    }
    return "LORE (your world — the only source of facts you may state):\n" + body;
  }

  const persona = isRecord(npc["persona"]) ? npc["persona"] : {};
  const tags = strings(persona["knowledge_tags"]);
  const tagLine = tags.length > 0 ? `Your knowledge touches on: ${tags.join(", ")}.` : "";
  return (
    "LORE: nothing has been authored for this character yet. State no historical facts at all; " +
    "speak only about what you can see, do and feel right now. " +
    tagLine
  ).trim();
}

function permittedBlock(npc: Npc): string {
  const llm = isRecord(npc["llm"]) ? npc["llm"] : {};
  const parts: string[] = [];

  const give = strings(llm["items_may_give"]);
  if (give.length > 0) parts.push("give: " + give.join(", "));

  const flags = strings(llm["flags_may_set"]);
  if (flags.length > 0) parts.push("set_flag: " + flags.join(", "));

  const bounds = isRecord(llm["vars_may_change"]) ? llm["vars_may_change"] : {};
  const entries = Object.entries(bounds).filter(([, value]) => isRecord(value));
  if (entries.length > 0) {
    // The Python version formatted this as `-{max}..{max}`, using `max` for both ends — a
    // copy-paste slip that told the model the wrong lower bound. `min..max` is what the
    // allowlist actually enforces, so the prompt and the validator now agree.
    parts.push(
      "var: " +
        entries
          .map(([name, value]) => {
            const range = value as Record<string, unknown>;
            const min = Number(range["min"] ?? 0);
            const max = Number(range["max"] ?? 0);
            return `${name} (${min}..${max})`;
          })
          .join(", "),
    );
  }

  const body = parts.length > 0 ? parts.join("\n") : "none — you cannot change any state. Speak instead.";
  return "PERMITTED ACTIONS:\n" + body;
}

/** The cacheable part: depends only on (npc, lang, event page). */
export function stablePrefix(npc: Npc, lang: string, page: Record<string, unknown> = {}): string {
  return [
    personaBlock(npc, page),
    WORLD_RULES.trim(),
    loreBlock(npc, page),
    OUTPUT_CONTRACT.trim(),
    permittedBlock(npc),
    (REGISTER[lang] ?? REGISTER["en"]!).trim(),
  ].join("\n\n");
}

/** Secrets whose `reveal_if` currently passes. */
export function visibleSecrets(npc: Npc, state: ConditionState): Array<Record<string, unknown>> {
  const secrets = Array.isArray(npc["secrets"]) ? npc["secrets"] : [];
  return secrets.filter(
    (secret): secret is Record<string, unknown> =>
      isRecord(secret) && evaluate(secret["reveal_if"], state),
  );
}

export function volatileBlock(
  npc: Npc,
  state: ConditionState,
  lang: string,
  playerInput: string,
): string {
  const sections: string[] = [];

  const secrets = visibleSecrets(npc, state);
  if (secrets.length > 0) {
    const rendered = secrets
      .map((secret) => `- ${toKey(secret["id"])}: ${String(secret["text"] ?? "")}`)
      .join("\n");
    sections.push("SECRETS YOU MAY NOW REVEAL (only if it fits what you are saying):\n" + rendered);
  }

  const flags = isRecord(state.flags) ? state.flags : {};
  const inventory = isRecord(state.inventory) ? state.inventory : {};
  const variables = isRecord(state.vars) ? state.vars : {};
  const talkCounts = isRecord(state.talk_counts) ? state.talk_counts : {};
  const npcId = toKey(npc["id"]);
  const held = toKey(state.held_item ?? "");

  const trueFlags = Object.entries(flags)
    .filter(([, value]) => Boolean(value))
    .map(([key]) => key)
    .sort();

  const stateLines = [
    `You have spoken with the player ${Number(talkCounts[npcId] ?? 0)} time(s) before.`,
    "Flags currently true: " + (trueFlags.length > 0 ? trueFlags.join(", ") : "none"),
    "Player carries: " + (Object.keys(inventory).length > 0 ? Object.keys(inventory).sort().join(", ") : "nothing"),
    "In the player's hands right now: " + (held || "nothing — their hands are empty"),
  ];

  if (held) {
    stateLines.push(
      "You can see the item in their hands. React to it naturally if it interests your " +
        "character — ask about it, admire it, or eye it warily — but only when it fits " +
        "the conversation already happening.",
    );
  }

  const variableEntries = Object.entries(variables);
  if (variableEntries.length > 0) {
    stateLines.push(
      "Values: " +
        variableEntries
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(", "),
    );
  }

  const locationContext = trimOr(state.location_context, "");
  if (locationContext) {
    sections.push("WHERE YOU ARE (the street around this conversation):\n" + locationContext);
  }

  sections.push("RIGHT NOW:\n" + stateLines.join("\n"));

  const line = playerInput || "(The player says nothing, and just looks at you.)";
  sections.push("PLAYER SAYS:\n" + line);
  // The last word before generation decides the language when history disagrees with the
  // current locale.
  sections.push((LANGUAGE_REMINDER[lang] ?? LANGUAGE_REMINDER["en"]!).trim());

  return sections.join("\n\n");
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export function buildMessages(
  npc: Npc,
  state: ConditionState,
  lang: string,
  history: unknown,
  playerInput: string,
): ChatMessage[] {
  const page = activeState(npc, state);
  const messages: ChatMessage[] = [{ role: "system", content: stablePrefix(npc, lang, page) }];

  if (Array.isArray(history)) {
    for (const turn of history) {
      if (!isRecord(turn)) continue;
      const role = toKey(turn["role"]);
      const content = String(turn["content"] ?? "");
      if ((role === "user" || role === "assistant") && content) {
        messages.push({ role, content });
      }
    }
  }

  messages.push({ role: "user", content: volatileBlock(npc, state, lang, playerInput) });
  return messages;
}
