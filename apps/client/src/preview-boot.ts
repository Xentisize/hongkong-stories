/* Preview boot: fetch the *draft* pack before anything derives content from it.
 *
 * This module exists for its import order. `main.ts` builds its lookups and derives its start
 * location at module scope, so a preview pack has to be here *before* that body runs. A top-level
 * await in a dependency does exactly that: ES evaluates this module to completion first, so
 * `previewPack` is settled by the time `main.ts` reads it — no async refactor of the boot needed.
 *
 * A failed preview keeps the game playable with the bundled pack and reports the failure, because a
 * blank canvas tells the author nothing while an error in the studio tells them everything.
 */

import { fetchPreviewPack, readPreviewOptions, type PreviewPack } from "./preview";

const search = typeof globalThis.location === "undefined" ? "" : globalThis.location.search;
const options = readPreviewOptions(search);

export const previewEnabled = options.preview;
export const previewToken = options.token;
export const previewError: string | null = null;

let pack: PreviewPack | null = null;
let error: string | null = null;

if (previewEnabled) {
  try {
    pack = await fetchPreviewPack({ token: previewToken });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    console.error(`preview pack unavailable, running the bundled pack: ${error}`);
  }
}

/** The draft pack, or null for an ordinary player build (or a preview that could not load). */
export const previewPack: PreviewPack | null = pack;

/** Why the preview pack could not load, when it could not. */
export const previewFailure: string | null = error;
