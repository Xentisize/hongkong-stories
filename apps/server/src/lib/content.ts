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
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Record<
    string,
    unknown
  >;

  const files = Array.isArray(manifest["files"]) ? (manifest["files"] as string[]) : [];
  const entries: Record<string, ContentEntity> = {};
  for (const relative of files) {
    entries[relative] = JSON.parse(await readFile(join(dir, relative), "utf8")) as ContentEntity;
  }

  return { pack: packFromEntries(entries, manifest), manifest };
}

export async function loadContent(): Promise<LoadedContent> {
  return loadContentFrom(contentDir());
}

export function counts(pack: ContentPack): Record<string, number> {
  return Object.fromEntries(
    Object.entries(pack.tables).map(([kind, rows]) => [kind, Object.keys(rows).length]),
  );
}
