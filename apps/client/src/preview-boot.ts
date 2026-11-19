/* Preview boot: fetch the *draft* pack before anything derives content from it.
 *
 * This module exists for its import order. `main.ts` builds its lookups and derives its start
 * location at module scope, so a preview pack has to be here *before* that body runs. A top-level
 * await in a dependency does exactly that: ES evaluates this module to completion first, so
 * `previewPack` is settled by the time `main.ts` reads it — no async refactor of the boot needed.
 *
 * The token arrives by `postMessage`, never in the URL: a bearer credential in `location.search`
 * would land in browser history, the referrer of every subresource, and the iframe's own address.
 * The studio posts it as soon as the frame loads; this waits for it.
 *
 * A failed preview keeps the game playable with the bundled pack **and says so**: the failure is
 * posted back to the studio, because a blank canvas tells the author nothing while "running the
 * published pack instead" tells them exactly what they are looking at.
 */

import {
  eventMessage,
  fetchPreviewPack,
  isPreviewCommand,
  readPreviewOptions,
  type PreviewPack,
} from "./preview";

const search = typeof globalThis.location === "undefined" ? "" : globalThis.location.search;
const options = readPreviewOptions(search);

/** True when the studio embedded this client rather than a player opening it. */
export const previewEnabled = options.preview;

/** How long to wait for the studio's `auth` message before giving up on the draft pack. */
const AUTH_TIMEOUT_MS = 4000;

function waitForToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      if (!isPreviewCommand(event.data) || event.data.type !== "auth") return;
      clearTimeout(timer);
      globalThis.removeEventListener("message", onMessage);
      resolve(event.data.token);
    };

    const timer = setTimeout(() => {
      globalThis.removeEventListener("message", onMessage);
      reject(new Error("the studio did not hand over a token"));
    }, AUTH_TIMEOUT_MS);

    globalThis.addEventListener("message", onMessage);
  });
}

/** Tell the studio that the preview failed, so it can say so instead of showing published content. */
function reportFailure(message: string): void {
  const parent: Window | undefined = globalThis.parent;
  // A top-level page is its own parent: nothing to report to, and posting to itself would loop.
  if (parent === undefined || parent === globalThis.window) return;
  parent.postMessage(eventMessage({ type: "error", message }), "*");
}

let pack: PreviewPack | null = null;
let error: string | null = null;

if (previewEnabled) {
  try {
    const token = await waitForToken();
    pack = await fetchPreviewPack({ token });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    console.error(`preview pack unavailable, running the bundled pack: ${error}`);
    reportFailure(error);
  }
}

/** The draft pack, or null for an ordinary player build (or a preview that could not load). */
export const previewPack: PreviewPack | null = pack;

/** Why the preview pack could not load, when it could not. */
export const previewFailure: string | null = error;
