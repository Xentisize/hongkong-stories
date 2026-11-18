/* Where a referenced file lives: inside the content pack, or beside it in `assets/`.
 *
 * Content spells its references four ways — `res://content/art/...`, `res://assets/tiles/...`,
 * a content-relative `art/props/...`, and an asset-relative `audio/...` — because the Godot client
 * resolves `res://` while the web client resolves pack-relative paths. A bundle has to find the
 * bytes for every one of them and put them back where they came from, so the spelling is classified
 * once, here, instead of in each exporter.
 *
 * Deliberately not a schema walk: any string that classifies and ends in a known media extension is
 * treated as a file reference. That way a new field that references art is picked up by the export
 * the day it is authored, rather than the day someone remembers to teach the exporter about it.
 */

export type AssetRoot = "content" | "assets";

export interface AssetLocation {
  root: AssetRoot;
  /** Path inside that root, e.g. `art/props/prop_tv.png` or `tiles/p1_tiles.png`. */
  path: string;
}

/** Prefix a bare (not `res://`) reference uses, and the root it therefore lives under. */
const BARE_ROOTS: ReadonlyArray<[string, AssetRoot]> = [
  ["art/", "content"],
  ["lore/", "content"],
  ["audio/", "assets"],
  ["tiles/", "assets"],
  ["sprites/", "assets"],
  ["fonts/", "assets"],
];

/** Extensions that make a string a candidate file reference rather than prose. */
const MEDIA_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".wav",
  ".ogg",
  ".mp3",
  ".ttf",
  ".otf",
  ".md",
  ".json",
];

/**
 * Classify one reference, or `null` when it is not a path we can resolve.
 *
 * Absolute paths and `..` are refused rather than normalised: a bundle writer that accepts them
 * would happily copy a file from outside the project into a game someone else downloads.
 */
export function locateAsset(reference: unknown): AssetLocation | null {
  if (typeof reference !== "string") return null;
  const ref = reference.trim();
  if (ref === "" || ref.startsWith("/") || ref.includes("..")) return null;

  if (ref.startsWith("res://")) {
    const inside = ref.slice("res://".length);
    if (inside.startsWith("content/")) return { root: "content", path: inside.slice("content/".length) };
    if (inside.startsWith("assets/")) return { root: "assets", path: inside.slice("assets/".length) };
    return null; // res://engine/... and friends are not files a bundle carries
  }

  for (const [prefix, root] of BARE_ROOTS) {
    if (ref.startsWith(prefix)) return { root, path: ref };
  }
  return null;
}

/** True when a string looks like a file we would carry: a resolvable path with a media extension. */
export function isAssetReference(reference: unknown): boolean {
  if (locateAsset(reference) === null) return false;
  const path = (reference as string).trim().toLowerCase();
  return MEDIA_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/** One distinct reference, and where the bytes are. */
export interface CollectedAsset extends AssetLocation {
  /** The string exactly as the content wrote it, so the bundle can explain what needed it. */
  ref: string;
}

/**
 * Every asset reference in a document tree, deduplicated and sorted.
 *
 * Sorted by `root` then `path` so an export produces the same index for the same content — a
 * bundle whose asset list reshuffles between runs is a bundle nobody can diff.
 */
export function collectAssetRefs(value: unknown): CollectedAsset[] {
  const found = new Map<string, CollectedAsset>();

  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      if (!isAssetReference(node)) return;
      const location = locateAsset(node);
      if (location === null) return;
      const key = `${location.root}/${location.path}`;
      if (!found.has(key)) found.set(key, { ...location, ref: node });
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const inner of Object.values(node as Record<string, unknown>)) walk(inner);
    }
  };

  walk(value);
  return [...found.values()].sort(
    (a, b) => a.root.localeCompare(b.root) || a.path.localeCompare(b.path),
  );
}
