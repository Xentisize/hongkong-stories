/* The preview bridge: the pieces the studio embeds the game with, kept engine-free.
 *
 * The studio runs the real client in an iframe against the **draft** pack, then talks to it. Two
 * halves live here so they can be tested without Phaser, a DOM or a server:
 *
 *   - reading `?preview=1&token=…` and fetching the draft pack from the admin route;
 *   - the message protocol the parent and the game exchange (`select`, `hover`, `place`, `pick`,
 *     `goto`, `playFrom`, `pause`).
 *
 * The boot wiring in `main.ts` is deliberately *not* here: the client currently derives its lookups
 * from bundled `import.meta.glob` JSON at module scope, so switching to the fetched pack needs the
 * boot to become async — a change that belongs in one piece, not half-applied.
 */

export interface PreviewOptions {
  /** True when the game was embedded by the studio rather than opened as a player. */
  preview: boolean;
  /** The admin bearer token the preview pack is fetched with. */
  token: string;
}

/** `?preview=1&token=…` — anything else is an ordinary player build. */
export function readPreviewOptions(search: string): PreviewOptions {
  const params = new URLSearchParams(search);
  const preview = params.get("preview") === "1" || params.get("preview") === "true";
  return { preview, token: preview ? (params.get("token") ?? "").trim() : "" };
}

export interface PreviewPack {
  tables: Record<string, Record<string, unknown>>;
  issues: Array<{ level: string; path: string; message: string }>;
}

/**
 * Fetch the pack the author is editing.
 *
 * Throws rather than falling back to the bundled pack: a preview that silently showed published
 * content while the author edits a draft would be worse than a visible failure, because it looks
 * like it worked.
 */
export async function fetchPreviewPack({
  baseUrl = "",
  token,
  fetchImpl = globalThis.fetch,
}: {
  baseUrl?: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<PreviewPack> {
  const response = await fetchImpl(`${baseUrl}/v1/admin/preview/pack`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`preview pack failed: ${response.status}`);
  }
  const body = (await response.json()) as Partial<PreviewPack>;
  return { tables: body.tables ?? {}, issues: body.issues ?? [] };
}

/* ---------- the message protocol ---------- */
//
// Defined in core, because the studio speaks it too; re-exported here so the client's own modules
// and tests keep one import path.

export {
  commandMessage,
  eventMessage,
  isPreviewCommand,
  isPreviewEvent,
  type PreviewCommand,
  type PreviewEvent,
} from "@hkstories/core";
