import {
  bigserial,
  date,
  doublePrecision,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * The mutable state of the game service (PLAN §4).
 *
 * Only *mutable* state lives here. Content stays in git: the 269 authored JSON files are versioned
 * artefacts with review history, and putting them in a database would trade that for a write API
 * nobody asked for. What lands in Postgres is what genuinely cannot live in a file — the append-only
 * usage ledger and the fact-check queue a human edits.
 *
 * `cost_usd` is `numeric`, not a float. Money in binary floating point accumulates error, and the
 * dashboard sums thousands of these rows; the JSON boundary converts to `number` for display where
 * six decimal places are the finest thing anyone reads.
 */

export const usageEvents = pgTable(
  "usage_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    /** `chat`, `playground`, `fact_check`, `image`. */
    type: text("type").notNull(),
    session: text("session"),
    npc: text("npc"),
    tokens: integer("tokens"),
    costUsd: numeric("cost_usd", { precision: 14, scale: 10 }).notNull().default("0"),
    latencyMs: doublePrecision("latency_ms"),
    cachedTokens: integer("cached_tokens"),
    /** Reasons the action allowlist rejected, so the dashboard can rank them. */
    rejected: text("rejected").array(),
    /** Pack-relative path, for image events. */
    path: text("path"),
  },
  (table) => [
    // Every dashboard query is "this month", usually narrowed by type.
    index("usage_events_ts_idx").on(table.ts),
    index("usage_events_type_ts_idx").on(table.type, table.ts),
  ],
);

export const factcheckEntries = pgTable(
  "factcheck_entries",
  {
    id: text("id").primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    npcId: text("npc_id").notNull(),
    playerInput: text("player_input").notNull().default(""),
    reply: text("reply").notNull(),
    verdict: text("verdict").notNull(),
    reason: text("reason").notNull().default(""),
    /** `open` until a human sets it to `dismissed` or `confirmed`. */
    status: text("status").notNull().default("open"),
    costUsd: numeric("cost_usd", { precision: 14, scale: 10 }).notNull().default("0"),
  },
  (table) => [index("factcheck_status_ts_idx").on(table.status, table.ts)],
);

export type UsageEventRow = typeof usageEvents.$inferSelect;
export type FactcheckEntryRow = typeof factcheckEntries.$inferSelect;

/**
 * Anonymous game sessions (PLAN 7.1, 7.5).
 *
 * These lived in a `Map` on `globalThis`, which is why the deployment was pinned to one instance:
 * two processes would each have kept their own map, so a token issued by one was unknown to the
 * other. A table makes the token meaningful across instances, and `used_tokens`/`turns` are only
 * ever changed with `= used_tokens + n` so concurrent charges add up instead of overwriting.
 *
 * Sessions now expire (`HKS_SESSION_TTL_MINUTES`). Under the in-memory version they lasted until a
 * restart, which was never a promise so much as an artefact — a row per abandoned browser tab would
 * otherwise accumulate forever.
 */
export const sessions = pgTable(
  "sessions",
  {
    token: text("token").primaryKey(),
    ip: text("ip").notNull(),
    budget: integer("budget").notNull(),
    usedTokens: integer("used_tokens").notNull().default(0),
    turns: integer("turns").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sessions_created_at_idx").on(table.createdAt)],
);

/**
 * Per-IP daily spend guards (PLAN 7.5, P6) — one row per address per day.
 *
 * Both ceilings are enforced here: session count and accrued cost. The cost ceiling was documented
 * in the README and carried in the config while the in-memory store tracked a `cost` field nothing
 * ever incremented, so it had never actually bounded anything.
 */
export const ipDailyCaps = pgTable(
  "ip_daily_caps",
  {
    ip: text("ip").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    sessions: integer("sessions").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 14, scale: 10 }).notNull().default("0"),
  },
  (table) => [primaryKey({ columns: [table.ip, table.day] })],
);

export type SessionRow = typeof sessions.$inferSelect;
export type IpDailyCapRow = typeof ipDailyCaps.$inferSelect;
