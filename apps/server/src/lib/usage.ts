import { sql } from "drizzle-orm";

import { db, hasDatabase } from "@/db/client";
import { usageEvents } from "@/db/schema";

/**
 * Usage accounting (PLAN 9.2 usage dashboard) — an append-only table, aggregated on read.
 *
 * One row per billable event: in-game chat turns, playground turns, fact-check calls, image
 * generations. The rollup is now a set of SQL aggregates rather than a file read in JavaScript —
 * that is the point of the move, since the dashboard asks "sum what, count what, percentile what"
 * and the database answers it without materialising every row in memory.
 *
 * Logging stays best-effort: a broken ledger must not break a chat turn. It is no longer *silent*
 * though — the JSONL version swallowed write errors entirely, which meant a ledger that had quietly
 * stopped recording looked exactly like a month with no traffic.
 */

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

function asNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export interface UsageEventFields {
  session?: string;
  npc?: string;
  tokens?: number;
  cost_usd?: number;
  latency_ms?: number;
  cached_tokens?: number;
  rejected?: string[];
  path?: string;
}

export async function logEvent(type: string, fields: UsageEventFields = {}): Promise<void> {
  if (!hasDatabase()) return;

  try {
    await db()
      .insert(usageEvents)
      .values({
        ts: new Date(),
        type,
        session: fields.session ?? null,
        npc: fields.npc ?? null,
        tokens: fields.tokens === undefined ? null : Math.trunc(fields.tokens),
        // `numeric` travels as a string so the exact decimal is preserved.
        costUsd: String(asNumber(fields.cost_usd)),
        latencyMs: fields.latency_ms === undefined ? null : asNumber(fields.latency_ms),
        cachedTokens: fields.cached_tokens === undefined ? null : Math.trunc(fields.cached_tokens),
        rejected: fields.rejected && fields.rejected.length > 0 ? fields.rejected.map(String) : null,
        path: fields.path ?? null,
      });
  } catch (error) {
    // Never fatal, never silent.
    console.error(`usage ledger write failed (${type}): ${String(error)}`);
  }
}

interface TotalsRow {
  month: string;
  chat_cost: string | number;
  image_cost: string | number;
  factcheck_cost: string | number;
  turns: string | number;
  tokens: string | number;
  p95: string | number | null;
}

/** Month-to-date rollup: spend by kind, turns, tokens, p95 latency, top rejections, sessions. */
export async function aggregate(): Promise<UsageSummary> {
  // No fallback to an empty summary: callers guard on `ledgerReady()` and answer 503. Returning
  // zeros here would render a broken ledger as a quiet month.
  const totalsQuery = sql`
    select
      to_char(date_trunc('month', now()), 'YYYY-MM') as month,
      coalesce(sum(cost_usd) filter (where type in ('chat', 'playground')), 0) as chat_cost,
      coalesce(sum(cost_usd) filter (where type = 'image'), 0) as image_cost,
      coalesce(sum(cost_usd) filter (where type = 'fact_check'), 0) as factcheck_cost,
      count(*) filter (where type in ('chat', 'playground')) as turns,
      coalesce(sum(tokens) filter (where type in ('chat', 'playground')), 0) as tokens,
      percentile_disc(0.95) within group (order by latency_ms)
        filter (where type in ('chat', 'playground') and latency_ms is not null) as p95
    from usage_events
    where ts >= date_trunc('month', now())
  `;

  const rejectedQuery = sql`
    select reason, count(*)::int as count
    from (
      select unnest(rejected) as reason
      from usage_events
      where ts >= date_trunc('month', now()) and rejected is not null
    ) expanded
    group by reason
    order by count desc, reason asc
    limit 5
  `;

  const sessionsQuery = sql`
    select session, count(*)::int as turns, sum(cost_usd) as cost_usd
    from usage_events
    where ts >= date_trunc('month', now())
      and type in ('chat', 'playground')
      and session is not null
    group by session
    order by sum(cost_usd) desc
    limit 10
  `;

  const [totalsRows, rejectedRows, sessionRows] = await Promise.all([
    db().execute(totalsQuery) as unknown as Promise<TotalsRow[]>,
    db().execute(rejectedQuery) as unknown as Promise<Array<{ reason: string; count: number }>>,
    db().execute(sessionsQuery) as unknown as Promise<
      Array<{ session: string; turns: number; cost_usd: string | number }>
    >,
  ]);

  const totals = totalsRows[0];

  return {
    month: totals?.month ?? new Date().toISOString().slice(0, 7),
    chat_cost_usd: round6(asNumber(totals?.chat_cost)),
    image_cost_usd: round6(asNumber(totals?.image_cost)),
    factcheck_cost_usd: round6(asNumber(totals?.factcheck_cost)),
    turns: asNumber(totals?.turns),
    tokens: asNumber(totals?.tokens),
    p95_latency_ms: Math.round(asNumber(totals?.p95) * 10) / 10,
    top_rejected: rejectedRows.map((row) => ({ reason: row.reason, count: asNumber(row.count) })),
    sessions: sessionRows.map((row) => ({
      session: row.session,
      turns: asNumber(row.turns),
      cost_usd: round6(asNumber(row.cost_usd)),
    })),
  };
}
