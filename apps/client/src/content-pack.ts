/**
 * The content hot-pack check (`content_db.gd`, PLAN §5.7).
 *
 * Content ships in git and the API can serve a newer pack than the bundle carries. The client asks
 * for `/v1/content/manifest.json` and compares `content_hash` with the manifest it was built from:
 *
 * - **same hash** → nothing to do, silently;
 * - **different hash** → the served pack is the one the author published, so the client should use
 *   it rather than quietly run stale content;
 * - **unreachable** → the bundled pack is the fallback, because offline play is a requirement, not
 *   an error path.
 *
 * The manifest carries one hash for the whole pack and a plain file list, not per-file hashes — so a
 * differing hash means "the pack changed", and the file list is what a pull would need. Narrowing
 * that to the files that actually changed would need the manifest to say so; it does not, and
 * pretending otherwise would mean silently missing an edit.
 */

export interface ContentManifest {
  manifest_schema?: number;
  version?: number;
  content_hash?: string;
  files?: string[];
}

export interface RefreshPlan {
  /** The files the served pack lists. With one aggregate hash, this is the whole pack. */
  files: string[];
  reason: string;
}

export type PackStatus = "checking" | "current" | "pending" | "unreachable";

/** A manifest, or null for anything that is not one. */
export function parseManifest(raw: unknown): ContentManifest | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;

  const record = raw as Record<string, unknown>;
  const files = Array.isArray(record["files"])
    ? record["files"].filter((entry): entry is string => typeof entry === "string")
    : undefined;

  const manifest: ContentManifest = {};
  if (typeof record["content_hash"] === "string") manifest.content_hash = record["content_hash"];
  if (typeof record["version"] === "number") manifest.version = record["version"];
  if (typeof record["manifest_schema"] === "number") manifest.manifest_schema = record["manifest_schema"];
  if (files !== undefined) manifest.files = files;

  // A manifest with no hash cannot be compared, which makes it useless for this purpose.
  return manifest.content_hash === undefined ? null : manifest;
}

/** What a client should do about a served manifest, or null when there is nothing to do. */
export function planRefresh(
  bundled: ContentManifest,
  served: ContentManifest | null,
): RefreshPlan | null {
  if (served === null) return null;
  if (served.content_hash === undefined) return null;
  if (served.content_hash === bundled.content_hash) return null;

  const files = served.files ?? [];
  if (files.length === 0) {
    // A hash with no file list describes a pack that cannot be fetched.
    return null;
  }

  return {
    files,
    reason: `served ${served.content_hash} differs from bundled ${bundled.content_hash ?? "(none)"}`,
  };
}

export type ManifestResult =
  | { ok: true; manifest: ContentManifest; status: "current" | "pending" }
  | { ok: false; status: "unreachable"; reason: string };

/**
 * Ask the API for its manifest.
 *
 * Never throws: a pack check that fails must not delay or break a boot, since the bundled content is
 * always a valid place to start.
 */
export async function fetchManifest(
  options: {
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    bundled?: ContentManifest;
  } = {},
): Promise<ManifestResult> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const base = options.baseUrl ?? "";
  const timeoutMs = options.timeoutMs ?? 2500;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await doFetch(`${base}/v1/content/manifest.json`, { signal: controller.signal });
    if (!response.ok) return { ok: false, status: "unreachable", reason: `http ${response.status}` };

    const manifest = parseManifest(await response.json().catch(() => null));
    if (manifest === null) return { ok: false, status: "unreachable", reason: "not a manifest" };

    const plan = planRefresh(options.bundled ?? {}, manifest);
    return { ok: true, manifest, status: plan === null ? "current" : "pending" };
  } catch (error) {
    return {
      ok: false,
      status: "unreachable",
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
