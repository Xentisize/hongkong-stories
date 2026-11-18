import { randomBytes } from "node:crypto";

import { asc, eq, sql } from "drizzle-orm";

import { isRecord, toKey } from "@hkstories/core";

import { db, hasDatabase } from "@/db/client";
import { factcheckEntries, type FactcheckEntryRow } from "@/db/schema";
import { completeProse } from "./completion";
import { WORLD_RULES } from "./prompts";

/**
 * Fact-check queue (PLAN 7.6, 9.2) — a second cheap call scores an NPC line against its lore.
 *
 * The rule from §7.6: **flag for review; never rewrite the player's words back at them.** Entries
 * sit at status `open` until a human resolves them `dismissed`/`confirmed` in the admin UI.
 *
 * The checker runs in prose mode: constraining it to the NPC reply schema would shape the verdict
 * wrong. Its output is parsed defensively, and an unparsable reply becomes `questionable` — which is
 * precisely what a review queue is for.
 *
 * Now a table rather than a JSONL file. The reason is `resolve`: the file version read every entry,
 * mutated one, and rewrote the whole file, so two authors resolving different entries at the same
 * moment silently lost one edit. This is a single-row `UPDATE`.
 */

export const VERDICTS = ["ok", "questionable", "contradiction"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** The wire shape the admin consumes: snake_case, `ts` as an ISO string. */
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
}

function toEntry(row: FactcheckEntryRow): FactCheckEntry {
  return {
    id: row.id,
    ts: row.ts.toISOString(),
    npc_id: row.npcId,
    player_input: row.playerInput,
    reply: row.reply,
    verdict: row.verdict,
    reason: row.reason,
    status: row.status,
    cost_usd: Number(row.costUsd),
  };
}

function requireDatabase(): void {
  if (!hasDatabase()) throw new Error("DATABASE_URL is not configured");
}

/** Open entries first, then resolved ones; chronological within each group. */
export async function listEntries(): Promise<FactCheckEntry[]> {
  requireDatabase();
  const rows = await db()
    .select()
    .from(factcheckEntries)
    .orderBy(
      sql`case when ${factcheckEntries.status} = 'open' then 0 else 1 end`,
      asc(factcheckEntries.ts),
    );
  return rows.map(toEntry);
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

/** Score one NPC line against the character's authored lore, then queue it for review. */
export async function check(
  options: CheckOptions,
  npc: Record<string, unknown>,
  playerInput: string,
  reply: string,
): Promise<FactCheckEntry> {
  requireDatabase();

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
  const row: FactcheckEntryRow = {
    id: `fc_${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomBytes(3).toString("hex")}`,
    ts: now,
    npcId: toKey(npc["id"] ?? ""),
    playerInput,
    reply,
    verdict,
    reason,
    status: "open",
    costUsd: String(result.costUsd),
  };

  await db().insert(factcheckEntries).values(row);
  return toEntry(row);
}

/**
 * Resolve one entry; returns the updated entry, or `null` when the id is unknown.
 *
 * A single-row update, so concurrent resolutions of different entries cannot clobber each other.
 */
export async function resolve(id: string, status: string): Promise<FactCheckEntry | null> {
  if (status !== "dismissed" && status !== "confirmed") {
    throw new Error(`bad status '${status}'`);
  }
  requireDatabase();

  const rows = await db()
    .update(factcheckEntries)
    .set({ status })
    .where(eq(factcheckEntries.id, id))
    .returning();

  const row = rows[0];
  return row ? toEntry(row) : null;
}
