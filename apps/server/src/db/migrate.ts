#!/usr/bin/env bun
/**
 * Apply the committed SQL migrations in `drizzle/`.
 *
 * Run from the repo root: `bun run db:migrate`.
 *
 * Two decisions worth knowing:
 *
 * - **Absent DATABASE_URL is not an error.** Content, the manifest, the gates and the whole tool
 *   chain work without a database; only sessions, chat charging and the two ledgers need one. A
 *   checkout that just wants to author or inspect content should not be blocked by a migration it
 *   cannot run.
 * - **Migrations are a step, not a side effect.** Nothing here fires from a request handler, so a
 *   deploy decides when the schema changes. The runner is idempotent: `drizzle/__drizzle_migrations`
 *   records what has been applied, so re-running is a no-op.
 *
 * `HKS_DB_SCHEMA` is honoured through the shared client, which sets `search_path` as a connection
 * startup parameter — that is how the test suite migrates its throwaway schema.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { db, dbSchema, hasDatabase } from "./client";

/**
 * Fill missing keys from the repo-root `.env`.
 *
 * `bun run db:migrate` from the root spawns this inside `apps/server`, which has no `.env` of its
 * own — so without this the command found no DATABASE_URL, skipped, and **exited 0**, which reads
 * exactly like a successful migration. Real environment variables always win, so a container that
 * injects DATABASE_URL is unaffected.
 */
function loadRootEnv(): void {
  const envPath = join(resolve(import.meta.dir, "..", "..", "..", ".."), ".env");
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const at = trimmed.indexOf("=");
    const key = trimmed.slice(0, at).trim();
    const value = trimmed
      .slice(at + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadRootEnv();

if (!hasDatabase()) {
  console.log(
    "no DATABASE_URL — skipping migrations. Sessions, chat charging and the ledgers need one; " +
      "content and tooling do not.",
  );
  process.exit(0);
}

const folder = join(import.meta.dir, "..", "..", "drizzle");
const schema = dbSchema();

// `drizzle.__drizzle_migrations` has a fixed two-part name, so it is *not* scoped by search_path:
// pointing HKS_DB_SCHEMA at a fresh schema would read the default schema's history, print "already
// up to date", and leave the new schema with no tables. The test suite sidesteps this by applying
// the SQL files itself, so refuse the combination instead of reporting a state that is not true.
if (schema) {
  console.error(
    `HKS_DB_SCHEMA='${schema}' is not supported by db:migrate — the migration journal is not ` +
      "schema-scoped. Run migrations against the default schema and let tests migrate their own.",
  );
  process.exit(1);
}

/** Rows in the journal table; 0 when the schema has never been migrated. */
async function appliedCount(): Promise<number> {
  try {
    const rows = (await db().execute(
      sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
    )) as unknown as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
  } catch {
    return 0; // no journal yet
  }
}

try {
  const before = await appliedCount();
  await migrate(db(), { migrationsFolder: folder });
  const after = await appliedCount();

  const pending = after - before;
  const where = schema ? ` in schema '${schema}'` : "";
  if (pending > 0) {
    console.log(`${pending} migration(s) applied${where} (${after} total) — ${folder}`);
  } else {
    console.log(`already up to date${where} (${after} migration(s) on record)`);
  }
  process.exit(0);
} catch (error) {
  console.error(`migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
