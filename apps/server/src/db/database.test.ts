import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import postgres from "postgres";

import { aggregate, logEvent } from "@/lib/usage";
import { listEntries, parseVerdict, resolve } from "@/lib/factcheck";
import { chargeSession, createSession, getSession, remainingOf, sessionAllowed } from "@/lib/sessions";
import { db, dbSchema, rawSql } from "@/db/client";
import { factcheckEntries } from "@/db/schema";

/**
 * Database integration tests: the usage ledger, the fact-check queue and the session/cap store.
 *
 * These run against the **shared remote database**, so they do not use `public`: the suite creates
 * a throwaway schema, points every connection at it via `HKS_DB_SCHEMA`, and drops it afterwards.
 * The last test asserts that `public` was untouched, because "the tests are isolated" is exactly the
 * sort of claim that quietly stops being true.
 *
 * Skipped when `DATABASE_URL` is unset, so `bun test` still works offline.
 */

const enabled = Boolean(process.env["DATABASE_URL"]);
const schemaName = `hks_test_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;

let admin!: ReturnType<typeof postgres>;
let publicRowsBefore = -1;

async function applyMigrations(): Promise<void> {
  const dir = join(process.cwd(), "drizzle");
  const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
  if (files.length === 0) throw new Error("no migration files found — run `bun run db:generate`");

  for (const file of files) {
    const text = await readFile(join(dir, file), "utf8");
    // drizzle separates statements with this marker rather than with semicolons we could split on.
    for (const statement of text.split("--> statement-breakpoint")) {
      if (statement.trim().length > 0) await rawSql().unsafe(statement);
    }
  }
}

beforeAll(async () => {
  if (!enabled) return;

  admin = postgres(process.env["DATABASE_URL"]!, { max: 1, onnotice: () => {} });

  // Counted before anything runs, so the isolation assertion has a baseline.
  const [{ count }] = await admin`select count(*)::int as count from public.usage_events`;
  publicRowsBefore = Number(count);

  await admin.unsafe(`create schema "${schemaName}"`);
  // Must be set before the first db() call, because the client caches its pool on globalThis.
  process.env["HKS_DB_SCHEMA"] = schemaName;

  await applyMigrations();
});

afterAll(async () => {
  if (!enabled) return;
  await admin.unsafe(`drop schema if exists "${schemaName}" cascade`);
  await admin.end({ timeout: 5 }).catch(() => {});
});

describe.skipIf(!enabled)("usage ledger", () => {
  // Each test owns the table outright. Sharing rows between tests means every assertion has to
  // account for what the previous test wrote — which is how the first version of this suite ended
  // up asserting 5 rows against 6.
  beforeEach(async () => {
    const sql = rawSql();
    await sql`truncate usage_events restart identity`;
  });

  test("the client honours the schema override", async () => {
    expect(dbSchema()).toBe(schemaName);
    const rows = await rawSql()<{ sp: string }[]>`select current_setting('search_path') as sp`;
    expect(rows[0]!.sp).toBe(schemaName);
  });

  test("logEvent never throws, even when the write is impossible", async () => {
    // A rejection list is legal; a broken write path is not what this asserts. It asserts the
    // contract callers rely on: logging cannot take a chat turn down.
    await expect(
      logEvent("chat", { session: "s_null", npc: "npc_x", tokens: 10, cost_usd: 0.001 }),
    ).resolves.toBeUndefined();
  });

  test("aggregate sums the month by kind and ranks rejections and sessions", async () => {
    await logEvent("chat", {
      session: "sess_a",
      npc: "npc_ch01_ken",
      tokens: 800,
      cost_usd: 0.0002,
      latency_ms: 1200,
      rejected: ["not permitted: give", "unknown action: dance"],
    });
    await logEvent("chat", {
      session: "sess_a",
      npc: "npc_ch01_ken",
      tokens: 600,
      cost_usd: 0.0003,
      latency_ms: 1600,
      rejected: ["unknown action: dance"],
    });
    await logEvent("playground", {
      npc: "npc_ch01_ken",
      tokens: 900,
      cost_usd: 0.0004,
      latency_ms: 1500,
      cached_tokens: 700,
    });
    await logEvent("image", { path: "art/props/x.png", cost_usd: 0.028 });
    await logEvent("fact_check", { npc: "npc_ch01_ken", cost_usd: 0.0002 });

    const summary = await aggregate();

    // chat + playground share one bucket; image and fact-check are their own.
    expect(summary.chat_cost_usd).toBeCloseTo(0.0009, 8);
    expect(summary.image_cost_usd).toBeCloseTo(0.028, 8);
    expect(summary.factcheck_cost_usd).toBeCloseTo(0.0002, 8);
    expect(summary.turns).toBe(3);
    expect(summary.tokens).toBe(800 + 600 + 900);

    // percentile_disc over (1200, 1500, 1600) at 0.95 is the largest value.
    expect(summary.p95_latency_ms).toBe(1600);

    expect(summary.top_rejected[0]).toEqual({ reason: "unknown action: dance", count: 2 });
    expect(summary.top_rejected).toHaveLength(2);

    expect(summary.sessions[0]).toEqual({ session: "sess_a", turns: 2, cost_usd: 0.0005 });
    expect(summary.month).toMatch(/^\d{4}-\d{2}$/);

    // Five writes above, all in this schema — the isolation claim, checked where it can be counted.
    const sql = rawSql();
    const rows = await sql<{ count: number }[]>`select count(*)::int as count from usage_events`;
    expect(Number(rows[0]!.count)).toBe(5);
  });
});

describe.skipIf(!enabled)("fact-check queue", () => {
  test("entries queued open come before resolved ones", async () => {
    const now = Date.now();
    await db().insert(factcheckEntries).values([
      {
        id: `fc_test_open_${now}`,
        ts: new Date(now),
        npcId: "npc_ch01_ken",
        playerInput: "hello",
        reply: "resolved line",
        verdict: "ok",
        reason: "fine",
        status: "dismissed",
        costUsd: "0.0001",
      },
      {
        id: `fc_test_open2_${now}`,
        ts: new Date(now + 1000),
        npcId: "npc_ch01_ken",
        playerInput: "hello",
        reply: "open line",
        verdict: "questionable",
        reason: "unsupported",
        status: "open",
        costUsd: "0.0002",
      },
    ]);

    const entries = await listEntries();
    expect(entries[0]!.status).toBe("open");
    expect(entries.at(-1)!.status).toBe("dismissed");
    // The wire shape the admin consumes, unchanged by the storage move.
    expect(entries[0]).toMatchObject({
      npc_id: "npc_ch01_ken",
      player_input: "hello",
      verdict: "questionable",
      status: "open",
    });
    expect(typeof entries[0]!.ts).toBe("string");
    expect(typeof entries[0]!.cost_usd).toBe("number");
  });

  test("resolve updates one row and refuses bad input", async () => {
    const [entry] = (await listEntries()).filter((row) => row.status === "open");
    expect(entry).toBeDefined();

    await expect(resolve(entry!.id, "maybe")).rejects.toThrow(/bad status/);
    expect(await resolve("fc_does_not_exist", "dismissed")).toBeNull();

    const resolved = await resolve(entry!.id, "confirmed");
    expect(resolved?.status).toBe("confirmed");
    // And it is persisted, not just echoed.
    const reloaded = await listEntries();
    expect(reloaded.find((row) => row.id === entry!.id)?.status).toBe("confirmed");
  });

  test("public was never written to", async () => {
    const [{ count }] = await admin`select count(*)::int as count from public.usage_events`;
    expect(Number(count)).toBe(publicRowsBefore);
  });
});

describe("verdict parsing", () => {
  test("accepts a bare JSON verdict", () => {
    expect(parseVerdict('{"verdict":"contradiction","reason":"the shop closed in 1958"}')).toEqual({
      verdict: "contradiction",
      reason: "the shop closed in 1958",
    });
  });

  test("strips a fenced block", () => {
    expect(parseVerdict('```json\n{"verdict":"ok","reason":"fine"}\n```')).toEqual({
      verdict: "ok",
      reason: "fine",
    });
  });

  test("an undeclared verdict becomes questionable", () => {
    expect(parseVerdict('{"verdict":"excellent"}').verdict).toBe("questionable");
  });

  test("prose becomes questionable rather than throwing", () => {
    const parsed = parseVerdict("I think it looks fine to me.");
    expect(parsed.verdict).toBe("questionable");
    expect(parsed.reason).toContain("unparsable");
  });
});

describe.skipIf(!enabled)("sessions and caps", () => {
  // The store reads its limits from the environment on every call, so each test states the limits it
  // depends on and the previous value is restored afterwards.
  const ENV_KEYS = [
    "HKS_SESSION_BUDGET",
    "HKS_PER_IP_DAILY_SESSIONS",
    "HKS_PER_IP_DAILY_COST_USD",
    "HKS_MAX_SESSIONS",
    "HKS_SESSION_TTL_MINUTES",
  ] as const;

  let saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    const sql = rawSql();
    await sql`truncate sessions`;
    await sql`truncate ip_daily_caps`;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("a new session carries the configured budget and starts empty", async () => {
    process.env["HKS_SESSION_BUDGET"] = "500";

    const created = await createSession("10.0.0.1");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.session.budget).toBe(500);
    expect(created.session.usedTokens).toBe(0);
    expect(created.session.turns).toBe(0);
    expect(created.session.token).toMatch(/^[0-9a-f]{48}$/);

    // And it is readable back, which is the property the Map could not offer across instances.
    const found = await getSession(created.session.token);
    expect(found?.token).toBe(created.session.token);
    expect(found?.ip).toBe("10.0.0.1");
    expect(await getSession("no-such-token")).toBeUndefined();
  });

  test("charging accrues to the session and to the address's spend", async () => {
    process.env["HKS_SESSION_BUDGET"] = "1000";
    const created = await createSession("10.0.0.2");
    if (!created.ok) throw new Error("session was not created");

    const first = await chargeSession(created.session.token, 300, 0.0001);
    expect(first?.usedTokens).toBe(300);
    expect(first?.turns).toBe(1);

    const second = await chargeSession(created.session.token, 250, 0.0002);
    expect(second?.usedTokens).toBe(550);
    expect(second?.turns).toBe(2);
    expect(remainingOf(second!)).toBe(450);

    const sql = rawSql();
    const rows = await sql<{ cost_usd: string }[]>`
      select cost_usd::text as cost_usd from ip_daily_caps
      where ip = ${"10.0.0.2"} and day = current_date`;
    expect(Number(rows[0]!.cost_usd)).toBeCloseTo(0.0003, 10);
  });

  test("concurrent charges add up instead of overwriting", async () => {
    const created = await createSession("10.0.0.3");
    if (!created.ok) throw new Error("session was not created");

    // Read-modify-write would lose most of these; `used_tokens = used_tokens + n` cannot.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => chargeSession(created.session.token, 100, 0)),
    );

    const highest = Math.max(...results.map((row) => row?.usedTokens ?? 0));
    expect(highest).toBe(800);

    const settled = await getSession(created.session.token);
    expect(settled?.usedTokens).toBe(800);
    expect(settled?.turns).toBe(8);
  });

  test("the daily session cap refuses the address's next session", async () => {
    process.env["HKS_PER_IP_DAILY_SESSIONS"] = "2";

    expect((await createSession("10.0.0.4")).ok).toBe(true);
    expect((await createSession("10.0.0.4")).ok).toBe(true);

    const refused = await createSession("10.0.0.4");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("daily_cap");

    expect(await sessionAllowed("10.0.0.4")).toBe(false);
    // A different address is unaffected.
    expect(await sessionAllowed("10.0.0.5")).toBe(true);
    expect((await createSession("10.0.0.5")).ok).toBe(true);
  });

  test("a cap of zero refuses even a first-time address", async () => {
    process.env["HKS_PER_IP_DAILY_SESSIONS"] = "0";

    // The guarded upsert only applied its WHERE to the conflict arm, so a brand-new address used to
    // walk straight past a zero limit via the INSERT.
    expect(await sessionAllowed("10.0.0.9")).toBe(false);

    const refused = await createSession("10.0.0.9");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("daily_cap");
  });

  test("the daily cost cap refuses an address that has spent its day", async () => {
    process.env["HKS_PER_IP_DAILY_COST_USD"] = "0.0005";
    const created = await createSession("10.0.0.6");
    if (!created.ok) throw new Error("session was not created");

    expect(await sessionAllowed("10.0.0.6")).toBe(true);
    await chargeSession(created.session.token, 10, 0.001);
    // This ceiling was documented but never enforced before the move; now it is.
    expect(await sessionAllowed("10.0.0.6")).toBe(false);
  });

  test("a session older than the TTL is gone", async () => {
    process.env["HKS_SESSION_TTL_MINUTES"] = "5";
    const created = await createSession("10.0.0.7");
    if (!created.ok) throw new Error("session was not created");

    const sql = rawSql();
    await sql`update sessions set created_at = now() - interval '10 minutes'
              where token = ${created.session.token}`;

    expect(await getSession(created.session.token)).toBeUndefined();
  });

  test("a full store refuses and rolls the daily cap increment back", async () => {
    process.env["HKS_MAX_SESSIONS"] = "1";

    const first = await createSession("10.0.0.8");
    expect(first.ok).toBe(true);

    const refused = await createSession("10.0.0.8");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("store_full");

    // The session row and the cap increment are one transaction; a refusal must not leave the
    // address charged for a session it never received.
    const sql = rawSql();
    const rows = await sql<{ sessions: number }[]>`
      select sessions from ip_daily_caps where ip = ${"10.0.0.8"} and day = current_date`;
    expect(Number(rows[0]!.sessions)).toBe(1);
  });
});
