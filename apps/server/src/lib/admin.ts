import { createHash, timingSafeEqual } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  isRecord,
  packFromEntries,
  resolveInheritance,
  toKey,
  type ContentEntity,
  type ContentPack,
  type Issue,
} from "@hkstories/core";

import { contentDir, loadEntriesFrom } from "@/lib/content";

/**
 * Admin authentication, CORS and the draft overlay, ported from `server/app/routers/admin.py`.
 *
 * Single-operator model (PLAN 9.3): one bearer token in the backend env, compared in constant
 * time. No accounts, no password database, no session store to leak. Admin routes are the only
 * place that can reach the OpenRouter key's effects, so they never accept a model id or URL from
 * the client — model slugs stay server-side constants.
 */

/** Entity kinds that can be drafted. `settings` is a singleton, but the machinery is the same. */
export const DRAFT_KINDS = [
  "npcs",
  "items",
  "locations",
  "quests",
  "settings",
  "chapters",
  "lore",
] as const;

/**
 * What a draft of this kind is written as.
 *
 * Lore is the exception in the pack: one markdown page per era, not an entity table. Storing it as
 * `.md` keeps publish a verbatim copy instead of a JSON round-trip that would reformat an author's
 * prose.
 */
export function draftExtension(kind: string): "json" | "md" {
  return kind === "lore" ? "md" : "json";
}

/** `vite dev` runs with cwd = apps/server. */
export function repoRoot(): string {
  return resolve(process.cwd(), "..", "..");
}

export function adminDataDir(): string {
  // Defaults next to the server that owns it. It used to be <repo>/server/data, which after the
  // Python backend was retired would have quietly recreated that directory on first write.
  return process.env.HKS_ADMIN_DATA_DIR ?? join(repoRoot(), "apps", "server", "data");
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
  return join(adminDataDir(), "drafts", kind, `${id}.${draftExtension(kind)}`);
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
    const suffix = `.${draftExtension(kind)}`;
    for (const name of await readdir(dir)) {
      if (!name.endsWith(suffix)) continue;
      const path = join(dir, name);
      files.push({
        kind,
        id: name.slice(0, -suffix.length),
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
 * which is the whole point of the draft area. Authoring-time inheritance is resolved here, once,
 * so every consumer downstream (the validator, publish, the clients, a bundle export) only ever
 * sees flat documents and never has to know `extends` exists.
 */
export interface MergedPack {
  pack: ContentPack;
  /**
   * `extends` problems found while resolving the pack and its drafts.
   *
   * Errors here block publish exactly like validation errors: a chain that does not resolve would
   * otherwise ship a document silently missing everything it asked for.
   */
  issues: Issue[];
}

/**
 * Overlay already-parsed drafts onto the pack's entries, keyed by path.
 *
 * Paths, not tables: a document's identity is its file, and `extends` resolves over files. A draft
 * replaces the baseline document at the same kind and id; one with no usable id cannot be placed,
 * and is left for the validator to complain about rather than dropped here in silence.
 */
export function overlayDrafts(
  entries: Record<string, ContentEntity>,
  drafts: Array<{ kind: string; entity: unknown }>,
): Record<string, ContentEntity> {
  const merged: Record<string, ContentEntity> = { ...entries };

  for (const draft of drafts) {
    if (!isRecord(draft.entity)) continue;
    const id = toKey(draft.entity["id"] ?? "");
    if (id === "") continue;
    merged[`${draft.kind}/${id}.json`] = draft.entity;
  }

  return merged;
}

export async function mergedPack(): Promise<MergedPack> {
  const { entries, manifest } = await loadEntriesFrom(contentDir());

  const drafts: Array<{ kind: string; entity: unknown }> = [];
  for (const draft of await draftFiles()) {
    // Lore is markdown, not an entity table: it has no `id` field and the validator never sees it.
    if (draftExtension(draft.kind) !== "json") continue;

    let entity: unknown;
    try {
      entity = JSON.parse(await readFile(draft.path, "utf8"));
    } catch {
      continue; // a half-written draft must not break validation of the rest
    }
    drafts.push({ kind: draft.kind, entity });
  }

  const resolved = resolveInheritance(overlayDrafts(entries, drafts));

  return { pack: packFromEntries(resolved.entries, manifest), issues: resolved.issues };
}
