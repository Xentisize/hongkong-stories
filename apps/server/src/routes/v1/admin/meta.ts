import { createFileRoute } from "@tanstack/react-router";

import { errorResponse, requireAdmin } from "@/lib/admin";
import { counts, loadContent } from "@/lib/content";

/** GET /v1/admin/meta — the content version the SPA shows in its status bar. */
export const Route = createFileRoute("/v1/admin/meta")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          requireAdmin(request);
          const { pack } = await loadContent();
          return Response.json({
            content_version: pack.version,
            content_hash: pack.contentHash,
            counts: counts(pack),
          });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
