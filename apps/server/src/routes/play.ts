import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createFileRoute } from "@tanstack/react-router";

/**
 * GET /play — the player demo, served by the API itself.
 *
 * A static directory cannot answer an extension-less path, so `/play` needs a handler even though
 * `/play/index.html` and `/play/assets/*` are ordinary static files. Serving the entry point here is
 * what makes the demo **one deployable thing**: the bundle calls `/v1` on its own origin, so a static
 * host on its own could never run it without a public API beside it.
 *
 * The two candidates are the two places the same file legitimately lives: `public/play/` in dev, and
 * `dist/client/play/` in a build (the API's build copies `public/` into the server output, which is
 * how `/admin/` already ships).
 */
const CANDIDATES = ["public/play/index.html", "dist/client/play/index.html"];

export const Route = createFileRoute("/play")({
  server: {
    handlers: {
      GET: async () => {
        for (const candidate of CANDIDATES) {
          try {
            const html = await readFile(join(process.cwd(), candidate), "utf8");
            return new Response(html, {
              headers: {
                "content-type": "text/html; charset=utf-8",
                // A demo exists to show the build you just made; a cached one shows the previous.
                "cache-control": "no-store",
              },
            });
          } catch {
            // Not here — try the other location.
          }
        }

        // Actionable, not a bare 404: this is the state a fresh clone is in.
        return new Response(
          [
            "<!doctype html><title>demo not assembled</title>",
            "<h1>The game is not assembled yet</h1>",
            "<p>From the repository root: <code>bun run demo:build</code>, then reload this page.</p>",
          ].join("\n"),
          { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
        );
      },
    },
  },
});
