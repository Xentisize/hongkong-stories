import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config: migrations are generated into `drizzle/` and committed, so applying them is
 * a deploy step (`bun run db:migrate`) rather than DDL fired from a request handler.
 *
 * Bun loads `.env` automatically, so `DATABASE_URL` is present for both commands.
 */
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env["DATABASE_URL"] ?? "" },
  strict: true,
  verbose: true,
});
