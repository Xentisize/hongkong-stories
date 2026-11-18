/**
 * The asset-existence check for the content gate.
 *
 * `validatePack` is pure by design — it has no filesystem — so it cannot know whether a referenced
 * texture exists. Both clients skip a texture they cannot load, which means a dangling reference
 * surfaces as "the art looks wrong" rather than "the content is wrong". This is the missing half,
 * kept pure (the caller supplies `exists`) so it can be tested without a fixture tree.
 */

import { collectAssetRefs, type ContentEntity } from "@hkstories/core";

export interface MissingAsset {
  /** Bundle-style path: `content/art/props/x.png` or `assets/tiles/y.png`. */
  path: string;
  /** The reference exactly as the content wrote it, so the author can find the line. */
  ref: string;
}

/**
 * Every referenced file that is not where it says it is.
 *
 * `exists` receives the *repo-relative* path (`content/…` or `assets/…`), so the caller decides
 * where those two roots live — the same function serves the repo, a bundle import, and a test.
 */
export function missingAssets(
  documents: Record<string, ContentEntity>,
  exists: (path: string) => boolean,
): MissingAsset[] {
  const missing: MissingAsset[] = [];
  for (const asset of collectAssetRefs(documents)) {
    const path = `${asset.root}/${asset.path}`;
    if (!exists(path)) missing.push({ path, ref: asset.ref });
  }
  return missing;
}
