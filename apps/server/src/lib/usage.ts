import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { adminDataDir } from "./admin";

/**
 * Usage accounting (PLAN 9.2 usage dashboard) — append-only JSONL, aggregated on read.
 *
 * One line per billable event: in-game chat turns, playground turns, fact-check calls, image
 * generations. JSONL rather than a database for now because the dashboard reads a few hundred
 * lines this phase; the seam that matters is that every write goes through `logEvent`, so moving
 * to Postgres later is one module rather than a hunt through routes.
 *
 * Logging is best-effort and never fatal: a broken ledger must not break a chat turn.
 */

export interface UsageEvent {
  ts: string;
  type: string;
  [field: string]: unknown;
}

export function usagePath(): string {
  return join(adminDataDir(), "usage.jsonl");
}

export async function logEvent(type: string, fields: Record<string, unknown> = {}): Promise<void> {
  const entry: UsageEvent = { ts: new Date().toISOString(), type, ...fields };
  try {
    const path = usagePath();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Accounting must never break a turn.
  }
}

async function load(): Promise<UsageEvent[]> {
  let text: string;
  try {
    text = await readFile(usagePath(), "utf8");
  } catch {
    return [];
  }

  const entries: UsageEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as UsageEvent);
    } catch {
      continue; // a torn line from a crash must not poison the dashboard
    }
  }
  return entries;
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.95))]!;
}

export interface UsageSummary {
  month: string;
  chat_cost_usd: number;
  image_cost_usd: number;
  factcheck_cost_usd: number;
  turns: number;
  tokens: number;
  p95_latency_ms: number;
  top_rejected: Array<{ reason: string; count: number }>;
  sessions: Array<{ session: string; turns: number; cost_usd: number }>;
}

/** Month-to-date rollup: spend, turns, tokens, p95 latency, top rejections, costliest sessions. */
export async function aggregate(): Promise<UsageSummary> {
  const month = new Date().toISOString().slice(0, 7);
  const entries = await load();

  let chatCost = 0;
  let imageCost = 0;
  let factcheckCost = 0;
  let turns = 0;
  let tokens = 0;
  const latencies: number[] = [];
  const rejected = new Map<string, number>();
  const sessions = new Map<string, { turns: number; cost_usd: number }>();

  for (const entry of entries) {
    if (!String(entry.ts ?? "").startsWith(month)) continue;

    const kind = String(entry.type ?? "");
    const cost = Number(entry.cost_usd ?? 0) || 0;

    if (kind === "chat" || kind === "playground") {
      chatCost += cost;
      turns += 1;
      tokens += Number(entry.tokens ?? 0) || 0;
      if (entry.latency_ms !== undefined && entry.latency_ms !== null) {
        latencies.push(Number(entry.latency_ms));
      }
      const session = entry.session;
      if (session) {
        const key = String(session);
        const slot = sessions.get(key) ?? { turns: 0, cost_usd: 0 };
        slot.turns += 1;
        slot.cost_usd += cost;
        sessions.set(key, slot);
      }
    } else if (kind === "image") {
      imageCost += cost;
    } else if (kind === "fact_check") {
      factcheckCost += cost;
    }

    const reasons = entry.rejected;
    if (Array.isArray(reasons)) {
      for (const reason of reasons) {
        const key = String(reason);
        rejected.set(key, (rejected.get(key) ?? 0) + 1);
      }
    }
  }

  const round = (value: number) => Math.round(value * 1e6) / 1e6;

  return {
    month,
    chat_cost_usd: round(chatCost),
    image_cost_usd: round(imageCost),
    factcheck_cost_usd: round(factcheckCost),
    turns,
    tokens,
    p95_latency_ms: Math.round(p95(latencies) * 10) / 10,
    top_rejected: [...rejected.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count })),
    sessions: [...sessions.entries()]
      .map(([session, slot]) => ({ session, ...slot }))
      .sort((a, b) => b.cost_usd - a.cost_usd)
      .slice(0, 10),
  };
}
