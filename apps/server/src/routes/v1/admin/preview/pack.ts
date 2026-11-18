import { createFileRoute } from "@tanstack/react-router";

import { errorResponse, mergedPack, requireAdmin } from "@/lib/admin";

/**
 * GET /v1/admin/preview/pack — the pack the author is *editing*, drafts overlaid.
 *
 * The studio's Build place runs the real Phaser client against this instead of the published
 * bundle, which is what makes the preview WYSIWYG: you see the draft you are typing into, not the
 * last thing you shipped. `mergedPack()` is the same merge the publisher validates, so the preview
 * cannot drift from what shipping would produce.
 *
 * The payload is the pack's tables verbatim — the resolver already applied `extends` — plus the
 * resolution issues, because a preview that hid a broken inheritance chain would be a lie. It is
 * `no-store`: a cached preview is worse than no preview.
 *
 * Auth is the admin bearer token; the client receives it from the studio when it is embedded.
 */
export const Route = createFileRoute("/v1/admin/preview/pack")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          requireAdmin(request);

          const { pack, issues } = await mergedPack();

          return Response.json(
            { tables: pack.tables, issues },
            { headers: { "cache-control": "no-store" } },
          );
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
