import { createFileRoute } from "@tanstack/react-router";

import { loadContent } from "@/lib/content";
import { preflight, withCors } from "@/lib/cors";

/**
 * GET /v1/content/manifest.json — the content hot-pack check (PLAN 5.7).
 *
 * The file is named `$file` rather than `manifest.json` because the file-route generator splits
 * route ids on dots: `manifest.json.ts` compiled to `/v1/content/manifest/json`, which is not the
 * URL the client asks for. A single-segment param matches `manifest.json` intact.
 *
 * The manifest is served verbatim — the client compares `content_hash` against the version it
 * booted with and pulls a new pack when they differ, so re-serialising it here would only risk
 * diverging from what was published.
 */
export const Route = createFileRoute("/v1/content/$file")({
  server: {
    handlers: {
      GET: withCors(async ({ request }) => {
        const { pathname } = new URL(request.url);
        if (!pathname.endsWith("/manifest.json")) {
          return Response.json({ detail: "not found" }, { status: 404 });
        }

        try {
          const { manifest } = await loadContent();
          return Response.json(manifest, { headers: { "cache-control": "no-cache" } });
        } catch (error) {
          return Response.json({ detail: String(error) }, { status: 503 });
        }
      }),

      OPTIONS: ({ request }) => preflight(request),
    },
  },
});
