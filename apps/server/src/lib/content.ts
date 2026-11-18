import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { packFromEntries, type ContentEntity, type ContentPack } from "@hkstories/core";

/**
 * Content access for the server, built on `@hkstories/core`.
 *
 * The Python backend had its own `ContentStore.load`; that loader and its validator were the
 * two things the admin and the client also needed, which is why they now live in the shared
 * core. This module is only the filesystem half: read `manifest.json`, read the files it lists,
 * hand the map to `packFromEntries`.
 */

/** `vite dev` runs with cwd = apps/server, so the pack is two levels up. */
export function contentDir(): string {
  return process.env.HKS_CONTENT_DIR ?? join(process.cwd(), "..", "..", "client", "content");
}

export interface LoadedContent {
  pack: ContentPack;
  /** The manifest exactly as written, which `/v1/content/manifest.json` serves verbatim. */
  manifest: Record<string, unknown>;
}

export async function loadContentFrom(dir: string): Promise<LoadedContent> {
  const { entries, manifest } = await loadEntriesFrom(dir);
  return { pack: packFromEntries(entries, manifest), manifest };
}

/**
 * The pack as a path → document map, plus its manifest.
 *
 * Authoring-time inheritance resolves over *paths* (a document's identity is its file), and
 * `packFromEntries` collapses that to `kind → id → entity`. Resolution has to happen before that
 * collapse, so this is the loader the publish gate uses; `loadContentFrom` is the same read with
 * the tables built for everything that only needs to look things up.
 */
export async function loadEntriesFrom(dir: string): Promise<{
  entries: Record<string, ContentEntity>;
  manifest: Record<string, unknown>;
}> {
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Record<
    string,
    unknown
  >;

  const files = Array.isArray(manifest["files"]) ? (manifest["files"] as string[]) : [];
  const entries: Record<string, ContentEntity> = {};
  for (const relative of files) {
    entries[relative] = JSON.parse(await readFile(join(dir, relative), "utf8")) as ContentEntity;
  }

  return { entries, manifest };
}

export async function loadContent(): Promise<LoadedContent> {
  return loadContentFrom(contentDir());
}

export function counts(pack: ContentPack): Record<string, number> {
  return Object.fromEntries(
    Object.entries(pack.tables).map(([kind, rows]) => [kind, Object.keys(rows).length]),
  );
}

/**
 * The game's shipped art, beside the pack rather than inside it.
 *
 * A location's `atlas` is a Godot resource path (`res://assets/tiles/p1_tiles_2027.png`), which the
 * browser cannot resolve — those files live in `client/assets/`. Both the preview route and the
 * bundle exporter need this root, so it is defined once here.
 */
export function assetsDir(): string {
  return process.env["HKS_ASSETS_DIR"] ?? join(process.cwd(), "..", "..", "client", "assets");
}
