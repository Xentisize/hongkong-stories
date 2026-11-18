/* Turning a pack path into something an <img> can show.
 *
 * Content files name their art the way the Godot client does — `res://content/art/items/x.png` —
 * while the web admin reads the same bytes through the server's content route. The mapping lives
 * here so every view agrees, and so the one thing that must never happen (a path escaping the pack)
 * is checked in a single place.
 */

/**
 * The URL a pack path is served at, or `null` when the admin cannot show it.
 *
 * `null` is the honest answer for a path the server would refuse: the UI then draws its fallback
 * tile instead of a broken-image icon or, worse, a request that 400s.
 */
export function contentAssetUrl(path: unknown): string | null {
  if (typeof path !== "string") return null;
  const trimmed = path.trim();
  if (trimmed === "") return null;
  // Absolute paths, other resource roots and traversal attempts are not ours to serve.
  if (trimmed.startsWith("/") || trimmed.includes("..")) return null;

  if (trimmed.startsWith("res://content/")) {
    return `/v1/content/file/${trimmed.slice("res://content/".length)}`;
  }
  if (trimmed.startsWith("res://assets/")) {
    return `/v1/assets/file/${trimmed.slice("res://assets/".length)}`;
  }
  if (trimmed.startsWith("art/") || trimmed.startsWith("lore/")) {
    return `/v1/content/file/${trimmed}`;
  }
  return null;
}

/** True when the path names art the admin can display — used to decide "show a thumbnail" at all. */
export function hasArtwork(path: unknown): boolean {
  return contentAssetUrl(path) !== null;
}
