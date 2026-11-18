import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

/**
 * Postgres access.
 *
 * Connected lazily and kept on `globalThis`, matching `lib/sessions.ts`: the dev server reloads
 * modules constantly, and a connection pool created per reload would exhaust the server's
 * connection slots in an afternoon.
 *
 * `HKS_DB_SCHEMA` exists for tests. The remote database is shared, so a test run sets its own
 * schema, and every new connection is pointed at it — no table prefixes, no cleanup races with
 * another run, and a failed run cannot leave rows in `public`.
 */

export type Database = PostgresJsDatabase<typeof schema>;

interface Holder {
  sql?: ReturnType<typeof postgres>;
  db?: Database;
  /** Set once the tables are confirmed: migrations do not run backwards mid-process. */
  ledgerVerified?: boolean;
}

const holderGlobal = globalThis as unknown as { __hksDb?: Holder };

export function databaseUrl(): string {
  return process.env["DATABASE_URL"] ?? "";
}

export function hasDatabase(): boolean {
  return databaseUrl() !== "";
}

export function dbSchema(): string | undefined {
  const schema = process.env["HKS_DB_SCHEMA"];
  return schema && schema.length > 0 ? schema : undefined;
}

export function db(): Database {
  const holder = (holderGlobal.__hksDb ??= {});
  if (holder.db) return holder.db;

  const url = databaseUrl();
  if (!url) throw new Error("DATABASE_URL is not configured");

  const schemaOverride = dbSchema();
  // Test schemas only; validate anyway so an env var cannot inject a startup parameter.
  if (schemaOverride && !/^[a-z_][a-z0-9_]*$/i.test(schemaOverride)) {
    throw new Error(`HKS_DB_SCHEMA is not a safe identifier: ${schemaOverride}`);
  }

  holder.sql = postgres(url, {
    max: 10,
    connect_timeout: 12,
    // Notices are noise for this workload; real errors still throw.
    onnotice: () => {},
    // A startup parameter, not a `SET` issued after connecting: a SET would apply only to whichever
    // pooled connection happened to run it, leaving the rest on the default search_path.
    connection: schemaOverride ? { options: `-c search_path=${schemaOverride}` } : undefined,
  });

  holder.db = drizzle(holder.sql, { schema });
  return holder.db;
}

/** Raw connection, for migrations and the test harness that needs DDL. */
export function rawSql(): ReturnType<typeof postgres> {
  db();
  return holderGlobal.__hksDb!.sql!;
}

export const DB_NOT_READY =
  "the database is not ready — set DATABASE_URL in .env and run `bun run db:migrate` in apps/server";

/** True when the tables exist; lets the API answer 503 with a fix rather than a 500. */
export async function ledgerReady(): Promise<boolean> {
  const holder = (holderGlobal.__hksDb ??= {});
  if (holder.ledgerVerified) return true;
  if (!hasDatabase()) return false;

  try {
    const rows = await db().execute(
      sql`select to_regclass(${'usage_events'}) is not null as usage_ok,
                 to_regclass(${'factcheck_entries'}) is not null as factcheck_ok`,
    );
    const row = (rows as unknown as Array<{ usage_ok: boolean; factcheck_ok: boolean }>)[0];
    const ready = Boolean(row?.usage_ok && row?.factcheck_ok);
    if (ready) holder.ledgerVerified = true;
    return ready;
  } catch {
    return false;
  }
}
