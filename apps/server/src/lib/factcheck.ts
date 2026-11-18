import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { isRecord, toKey } from "@hkstories/core";

import { adminDataDir } from "./admin";
import { completeProse } from "./completion";
import { WORLD_RULES } from "./prompts";

/**
 * Fact-check queue (PLAN 7.6, 9.2) — a second cheap call scores an NPC line against its lore.
 *
 * The rule from §7.6: **flag for review; never rewrite the player's words back at them.** Entries
 * sit at status `open` until a human resolves them `dismissed`/`confirmed` in the admin UI.
 *
 * The checker runs in prose mode: constraining it to the NPC reply schema would shape the verdict
 * wrong. Its output is parsed defensively, and an unparsable reply becomes `questionable` — which
 * is precisely what a review queue is for.
 */

export const VERDICTS = ["ok", "questionable", "contradiction"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface FactCheckEntry {
  id: string;
  ts: string;
  npc_id: string;
  player_input: string;
  reply: string;
  verdict: string;
  reason: string;
  status: string;
  cost_usd: number;
  [field: string]: unknown;
}

export function factcheckPath(): string {
  return join(adminDataDir(), "factcheck.jsonl");
}

async function load(): Promise<FactCheckEntry[]> {
  let text: string;
  try {
    text = await readFile(factcheckPath(), "utf8");
  } catch {
    return [];
  }

  const entries: FactCheckEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as FactCheckEntry);
    } catch {
      continue; // a torn line must not lose the rest of the queue
    }
  }
  return entries;
}

/** Open entries first, then resolved ones; chronological within each group. */
export async function listEntries(): Promise<FactCheckEntry[]> {
  const entries = await load();
  return entries.sort((a, b) => {
    const rank = Number(a.status !== "open") - Number(b.status !== "open");
    if (rank !== 0) return rank;
    return String(a.ts ?? "").localeCompare(String(b.ts ?? ""));
  });
}

/** Strip a fenced block, then trust nothing else about the shape. */
export function parseVerdict(raw: string): { verdict: Verdict; reason: string } {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```/, "").replace(/```$/, "").trim();
    if (text.toLowerCase().startsWith("json")) text = text.slice(4).trim();
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return { verdict: "questionable", reason: "checker returned a non-object" };
    const claimed = toKey(parsed["verdict"] ?? "questionable");
    const verdict = (VERDICTS as readonly string[]).includes(claimed)
      ? (claimed as Verdict)
      : "questionable";
    return { verdict, reason: String(parsed["reason"] ?? "").slice(0, 500) };
  } catch {
    return { verdict: "questionable", reason: "checker returned unparsable output" };
  }
}

export interface CheckOptions {
  apiKey: string;
  model: string;
}

/** Score one NPC line against the character's authored lore, then append it to the queue. */
export async function check(
  options: CheckOptions,
  npc: Record<string, unknown>,
  playerInput: string,
  reply: string,
): Promise<FactCheckEntry> {
  const persona = isRecord(npc["persona"]) ? npc["persona"] : {};
  const lore = String(npc["lore"] ?? "") || "(none authored)";

  const prompt =
    "You are the fact-check pass for a historical drama game. Judge ONLY whether the " +
    "character's reply asserts anything the authored LORE does not support, or " +
    "contradicts it. Do not judge style, grammar, or tone.\n\n" +
    `CHARACTER: ${String(persona["role"] ?? "")}\n` +
    `LORE:\n${lore}\n\n` +
    `PLAYER SAID: ${playerInput || "(nothing)"}\n` +
    `CHARACTER REPLIED: ${reply}\n\n` +
    'Reply with {"verdict": "ok" | "questionable" | "contradiction", "reason": "..."} ' +
    "and nothing else.";

  const result = await completeProse({
    apiKey: options.apiKey,
    model: options.model,
    messages: [
      { role: "system", content: WORLD_RULES.trim() },
      { role: "user", content: prompt },
    ],
    temperature: 0.2,
    maxTokens: 200,
  });

  const { verdict, reason } = parseVerdict(result.raw);

  const now = new Date();
  const entry: FactCheckEntry = {
    id: `fc_${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomBytes(3).toString("hex")}`,
    ts: now.toISOString(),
    npc_id: toKey(npc["id"] ?? ""),
    player_input: playerInput,
    reply,
    verdict,
    reason,
    status: "open",
    cost_usd: result.costUsd,
  };

  const path = factcheckPath();
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
  return entry;
}

/**
 * Resolve one entry; returns the updated entry, or `null` when the id is unknown.
 *
 * The Python version rewrote the whole file in place, which truncates the queue if the process dies
 * mid-write. This writes a sibling temp file and renames over the original, so a crash leaves the
 * previous queue intact.
 */
export async function resolve(id: string, status: string): Promise<FactCheckEntry | null> {
  if (status !== "dismissed" && status !== "confirmed") {
    throw new Error(`bad status '${status}'`);
  }

  const entries = await load();
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) return null;

  entry.status = status;

  const path = factcheckPath();
  const temporary = `${path}.tmp`;
  const body = entries.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(temporary, body, "utf8");
  await rename(temporary, path);

  return entry;
}
