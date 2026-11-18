import { randomBytes } from "node:crypto";

import { asc, eq, sql } from "drizzle-orm";

import { isRecord, toKey } from "@hkstories/core";

import { db, hasDatabase } from "@/db/client";
import { factcheckEntries, type FactcheckEntryRow } from "@/db/schema";
import { completeStructured } from "./completion";
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

/** Strip a fenced code block, which models add even when a schema asked for bare JSON. */
function stripFences(raw: string): string {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```/, "").replace(/```$/, "").trim();
    if (text.toLowerCase().startsWith("json")) text = text.slice(4).trim();
  }
  return text;
}

/**
 * The parsed verdict, or `null` when the text is not a usable verdict object.
 *
 * Distinct from `parseVerdict` because "the checker failed to answer" and "the checker answered"
 * lead to different behaviour: the first is worth retrying, the second is a review entry.
 */
export function tryParseVerdict(raw: string): { verdict: Verdict; reason: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const claimed = toKey(parsed["verdict"] ?? "");
  const verdict = (VERDICTS as readonly string[]).includes(claimed)
    ? (claimed as Verdict)
    : "questionable";
  return { verdict, reason: String(parsed["reason"] ?? "").slice(0, 500) };
}

/** Defensive form for callers that must always get an answer. */
export function parseVerdict(raw: string): { verdict: Verdict; reason: string } {
  return tryParseVerdict(raw) ?? {
    verdict: "questionable",
    reason: "checker returned unparsable output",
  };
}

/**
 * Ask the checker for JSON rather than prose.
 *
 * The original objection was to reusing the **NPC reply** schema here — constraining the checker to
 * the character's output shape would shape the verdict wrong. A schema of its own is a different
 * thing. Without one the model answered in prose, which parsed to nothing and became `questionable`
 * every time: that fallback, not the checker's judgement, is what filled the review queue.
 */
export function verdictResponseFormat(): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: "fact_check_verdict",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["verdict", "reason"],
        properties: {
          verdict: { type: "string", enum: [...VERDICTS] },
          reason: { type: "string" },
        },
      },
    },
  };
}

/** The two messages the checker sees. Pure, so the prompt itself can be asserted. */
export function buildVerdictMessages(
  npc: Record<string, unknown>,
  playerInput: string,
  reply: string,
): Array<{ role: string; content: string }> {
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

  return [
    { role: "system", content: WORLD_RULES.trim() },
    { role: "user", content: prompt },
  ];
}

/** How many times a verdict is asked for before giving up and queueing it for a human. */
export const MAX_VERDICT_ATTEMPTS = 2;

export interface ScoredVerdict {
  verdict: Verdict;
  reason: string;
  attempts: number;
  /** False when every attempt came back unusable: the entry is a review target, not a judgement. */
  parsed: boolean;
}

/**
 * Score a line, retrying once when the answer is unusable.
 *
 * `ask` is injected so the retry policy can be tested without a provider — the interesting behaviour
 * here is how a second attempt and a final fallback are decided, not the HTTP call.
 */
export async function scoreLine(ask: (attempt: number) => Promise<string>): Promise<ScoredVerdict> {
  for (let attempt = 1; attempt <= MAX_VERDICT_ATTEMPTS; attempt += 1) {
    const parsed = tryParseVerdict(await ask(attempt));
    if (parsed) return { ...parsed, attempts: attempt, parsed: true };
  }

  return {
    verdict: "questionable",
    reason: `checker returned unparsable output (after ${MAX_VERDICT_ATTEMPTS} attempts)`,
    attempts: MAX_VERDICT_ATTEMPTS,
    parsed: false,
  };
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

  const messages = buildVerdictMessages(npc, playerInput, reply);
  let cost = 0;

  const scored = await scoreLine(async (attempt) => {
    const result = await completeStructured(
      {
        apiKey: options.apiKey,
        model: options.model,
        messages,
        // A retry drops to temperature 0: a first answer that is not JSON is usually sampling, and a
        // deterministic second attempt is more useful than a third coin flip.
        temperature: attempt === 1 ? 0.2 : 0,
        maxTokens: 200,
      },
      verdictResponseFormat(),
    );

    // Every attempt cost money; the entry records what the row actually cost to judge.
    cost += result.costUsd;
    return result.raw;
  });

  const now = new Date();
  const row: FactcheckEntryRow = {
    id: `fc_${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomBytes(3).toString("hex")}`,
    ts: now,
    npcId: toKey(npc["id"] ?? ""),
    playerInput,
    reply,
    verdict: scored.verdict,
    reason: scored.reason,
    status: "open",
    costUsd: String(cost),
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
