import { createHash, timingSafeEqual } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { isRecord, toKey, type ContentEntity, type ContentPack } from "@hkstories/core";

import { loadContent } from "@/lib/content";

/**
 * Admin authentication, CORS and the draft overlay, ported from `server/app/routers/admin.py`.
 *
 * Single-operator model (PLAN 9.3): one bearer token in the backend env, compared in constant
 * time. No accounts, no password database, no session store to leak. Admin routes are the only
 * place that can reach the OpenRouter key's effects, so they never accept a model id or URL from
 * the client — model slugs stay server-side constants.
 */

export const DRAFT_KINDS = ["npcs", "items", "locations", "quests"] as const;

/** `vite dev` runs with cwd = apps/server. */
export function repoRoot(): string {
  return resolve(process.cwd(), "..", "..");
}

export function adminDataDir(): string {
  return process.env.HKS_ADMIN_DATA_DIR ?? join(repoRoot(), "server", "data");
}

/** An error the route layer turns into a status code instead of a 500. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(detail);
  }
}

export function fail(status: number, detail: string): never {
  throw new HttpError(status, detail);
}

export function jsonError(status: number, detail: string): Response {
  return Response.json({ detail }, { status });
}

/** Map a thrown value onto a response, keeping the Python route's status codes. */
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return jsonError(error.status, error.detail);
  return jsonError(500, String(error));
}

/**
 * Constant-time bearer check.
 *
 * Both sides are hashed first so the comparison is fixed-length: `timingSafeEqual` throws on
 * differing lengths, and comparing raw tokens would leak the configured token's length by
 * timing alone.
 */
export function requireAdmin(request: Request): void {
  const configured = process.env.HKS_ADMIN_TOKEN ?? "";
  if (!configured) fail(503, "admin API is not configured");

  const header = request.headers.get("authorization") ?? "";
  const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";

  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(configured).digest();
  if (!timingSafeEqual(a, b)) fail(401, "invalid admin token");
}

// --- drafts -----------------------------------------------------------------------------

/** Path rules copied verbatim: the id becomes a filename, so it must not escape the folder. */
export function draftPath(kind: string, id: string): string {
  if (!(DRAFT_KINDS as readonly string[]).includes(kind)) {
    fail(400, `unknown kind '${kind}'`);
  }
  if (!id || id.includes("/") || id.startsWith(".")) fail(400, "bad id");
  return join(adminDataDir(), "drafts", kind, `${id}.json`);
}

export interface DraftFile {
  kind: string;
  id: string;
  path: string;
  /** Seconds since the epoch, matching the Python `st_mtime`. */
  updated: number;
}

export async function draftFiles(): Promise<DraftFile[]> {
  const base = join(adminDataDir(), "drafts");

  let kindNames: string[];
  try {
    const entries = await readdir(base, { withFileTypes: true });
    kindNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return []; // no drafts yet
  }

  const files: DraftFile[] = [];
  for (const kind of kindNames) {
    const dir = join(base, kind);
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      files.push({
        kind,
        id: name.slice(0, -".json".length),
        path,
        updated: Math.floor((await stat(path)).mtimeMs / 1000),
      });
    }
  }

  files.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return files;
}

/**
 * The pack as it would ship: the baseline overlaid with drafts.
 *
 * Validation runs against this, so an author can see the effect of a draft before publishing —
 * which is the whole point of the draft area.
 */
export async function mergedPack(): Promise<ContentPack> {
  const { pack } = await loadContent();

  const tables: Record<string, Record<string, ContentEntity>> = {};
  for (const [kind, rows] of Object.entries(pack.tables)) tables[kind] = { ...rows };

  for (const draft of await draftFiles()) {
    let entity: unknown;
    try {
      entity = JSON.parse(await readFile(draft.path, "utf8"));
    } catch {
      continue; // a half-written draft must not break validation of the rest
    }
    if (!isRecord(entity)) continue;
    const id = toKey(entity["id"] ?? "");
    if (!id) continue;
    (tables[draft.kind] ??= {})[id] = entity;
  }

  return { tables, version: pack.version, contentHash: pack.contentHash };
}
