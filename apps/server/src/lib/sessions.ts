import { sql } from "drizzle-orm";

import { db, hasDatabase } from "@/db/client";

/**
 * Anonymous sessions and per-IP daily caps (PLAN 7.1, 7.5).
 *
 * A session is the only thing the client holds: a random token and a token budget. No identity, no
 * PII, no key.
 *
 * These lived in a `Map` on `globalThis`, which is precisely why the deployment was pinned to one
 * instance — a token issued by one process was unknown to any other. They are rows now, and every
 * counter moves with `= x + n` rather than by reading and writing back, so two instances charging
 * the same session at once add up instead of overwriting each other.
 *
 * Two ceilings are enforced per IP per day: how many sessions an address may open, and how much it
 * may spend. The cost ceiling was documented in the README and carried in the config, while the
 * in-memory store tracked a `cost` field nothing ever incremented — it had never bounded anything.
 */

export interface Session {
  token: string;
  budget: number;
  ip: string;
  usedTokens: number;
  turns: number;
  createdAt: number;
}

export interface PublicSession {
  session_token: string;
  budget: number;
  remaining: number;
}

export type CreateResult =
  | { ok: true; session: Session }
  | { ok: false; reason: "daily_cap" | "store_full" };

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name] ?? Number.NaN);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Sessions expiring is new behaviour: memory used to keep them until a restart. */
function ttlMinutes(): number {
  return Math.max(1, Math.trunc(envNumber("HKS_SESSION_TTL_MINUTES", 1440)));
}

function sessionBudget(): number {
  return Math.trunc(envNumber("HKS_SESSION_BUDGET", 60_000));
}

function maxSessions(): number {
  return Math.trunc(envNumber("HKS_MAX_SESSIONS", 100_000));
}

function dailySessionCap(): number {
  return Math.trunc(envNumber("HKS_PER_IP_DAILY_SESSIONS", 40));
}

function dailyCostCap(): number {
  return envNumber("HKS_PER_IP_DAILY_COST_USD", 2);
}

function requireDatabase(): void {
  if (!hasDatabase()) throw new Error("DATABASE_URL is not configured");
}

/**
 * A row as raw SQL returns it — column names, not camelCase field names. Reading `.usedTokens` off
 * one of these yields `undefined`, which becomes `NaN` after `Number(...)`: every counter would have
 * been NaN while still looking like a number in the type system.
 */
interface SessionDbRow {
  token: string;
  ip: string;
  budget: number | string;
  used_tokens: number | string;
  turns: number | string;
  created_at: Date | string;
}

function toSession(row: SessionDbRow): Session {
  return {
    token: row.token,
    budget: Number(row.budget),
    ip: row.ip,
    usedTokens: Number(row.used_tokens),
    turns: Number(row.turns),
    createdAt: new Date(row.created_at).getTime(),
  };
}

/** Thrown inside a transaction to force a rollback; caught immediately outside it. */
class Refused extends Error {
  constructor(readonly reason: "daily_cap" | "store_full") {
    super(reason);
    this.name = "Refused";
  }
}

/** The client address, honouring a proxy header when one is present. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip") ?? "unknown";
}

/** Drop expired sessions and stale cap buckets so neither table grows without bound. */
async function prune(): Promise<void> {
  await db().execute(
    sql`delete from sessions where created_at < now() - make_interval(mins => ${ttlMinutes()})`,
  );
  // A week is enough history for "what did yesterday look like" questions; the ledger keeps spend.
  await db().execute(sql`delete from ip_daily_caps where day < current_date - 7`);
}

/**
 * Whether this address may open another session today.
 *
 * Checked before creation for the 429 the client already understands, and enforced again inside
 * `createSession`'s transaction so two simultaneous requests cannot both slip past it.
 */
export async function sessionAllowed(ip: string): Promise<boolean> {
  requireDatabase();

  const rows = (await db().execute(
    sql`select sessions, cost_usd::text as cost_usd
        from ip_daily_caps where ip = ${ip} and day = current_date`,
  )) as unknown as Array<{ sessions: number; cost_usd: string }>;

  const row = rows[0];
  // No row yet: allowed only if the ceilings actually permit anything. A cap of zero has to mean
  // zero for an address that has never been seen, otherwise "turn it off" is not expressible.
  if (!row) return dailySessionCap() > 0 && dailyCostCap() > 0;
  return Number(row.sessions) < dailySessionCap() && Number(row.cost_usd) < dailyCostCap();
}

/**
 * Open a session, counting it against the address's daily allowance in the same transaction.
 *
 * The cap is incremented with a guarded upsert (`where sessions < limit`) rather than by reading
 * then writing: the row lock during the upsert is what makes the limit exact under concurrency.
 */
export async function createSession(ip: string): Promise<CreateResult> {
  requireDatabase();
  await prune();

  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  const budget = sessionBudget();
  const limit = dailySessionCap();

  try {
    return await db().transaction(async (tx) => {
      const capRows = (await tx.execute(
        sql`insert into ip_daily_caps (ip, day, sessions, cost_usd)
            select ${ip}, current_date, 1, 0
            where 1 <= ${limit}
            on conflict (ip, day) do update
              set sessions = ip_daily_caps.sessions + 1
              where ip_daily_caps.sessions < ${limit}
            returning sessions`,
      )) as unknown as Array<{ sessions: number }>;

      // Throwing is what rolls this back. Returning early would commit the increment, leaving an
      // address charged for a session it never received.
      if (capRows.length === 0) throw new Refused("daily_cap");

      // Capacity is checked in the same statement so the count cannot go stale between a check and
      // the insert. prune() has just removed expired rows, so they do not count against the ceiling.
      const created = (await tx.execute(
        sql`with room as (
              select count(*)::int as n from sessions
              where created_at >= now() - make_interval(mins => ${ttlMinutes()})
            )
            insert into sessions (token, ip, budget)
            select ${token}, ${ip}, ${budget} from room where room.n < ${maxSessions()}
            returning token, ip, budget, used_tokens, turns, created_at`,
      )) as unknown as SessionDbRow[];

      const row = created[0];
      if (!row) throw new Refused("store_full");

      return { ok: true, session: toSession(row) } as const;
    });
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason } as const;
    throw error;
  }
}

/** A live session, or `undefined` once it has expired. */
export async function getSession(token: string): Promise<Session | undefined> {
  if (!token) return undefined;
  requireDatabase();

  const rows = (await db().execute(
    sql`select token, ip, budget, used_tokens, turns, created_at
        from sessions
        where token = ${token}
          and created_at >= now() - make_interval(mins => ${ttlMinutes()})`,
  )) as unknown as SessionDbRow[];

  const row = rows[0];
  return row ? toSession(row) : undefined;
}

/**
 * Charge a turn to its session and to the address's daily spend, atomically.
 *
 * Returns the updated session so the caller can report the post-charge `remaining` and `turn`.
 * Null means the token vanished (expired mid-turn) — the reply is still delivered, because the
 * provider has already been paid for it.
 */
export async function chargeSession(token: string, tokens: number, costUsd: number): Promise<Session | null> {
  requireDatabase();

  return db().transaction(async (tx) => {
    const updated = (await tx.execute(
      sql`update sessions
          set used_tokens = used_tokens + ${Math.max(0, Math.trunc(tokens))},
              turns = turns + 1
          where token = ${token}
          returning token, ip, budget, used_tokens, turns, created_at`,
    )) as unknown as SessionDbRow[];

    const row = updated[0];
    if (!row) return null;

    if (costUsd > 0) {
      await tx.execute(
        sql`insert into ip_daily_caps (ip, day, sessions, cost_usd)
            values (${row.ip}, current_date, 0, ${String(costUsd)})
            on conflict (ip, day) do update
              set cost_usd = ip_daily_caps.cost_usd + ${String(costUsd)}`,
      );
    }

    return toSession(row);
  });
}

/** Remaining budget for a session. The Python original had this as a property. */
export function remainingOf(session: Session): number {
  return Math.max(0, session.budget - session.usedTokens);
}

export function asPublicSession(session: Session): PublicSession {
  return {
    session_token: session.token,
    budget: session.budget,
    remaining: remainingOf(session),
  };
}

export function chatModel(): string {
  return process.env.HKS_CHAT_MODEL ?? process.env.TEXT_GENERATION_MODEL ?? "deepseek/deepseek-v4.1-flash-1017";
}

export function chatOutputMode(): string {
  return process.env.HKS_CHAT_OUTPUT_MODE ?? "json";
}
