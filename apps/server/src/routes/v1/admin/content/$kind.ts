import { createFileRoute } from "@tanstack/react-router";

import { errorResponse, fail, requireAdmin } from "@/lib/admin";
import { loadContent } from "@/lib/content";

/** GET /v1/admin/content/{kind} — the baseline ids, used for clone-from-baseline. */
export const Route = createFileRoute("/v1/admin/content/$kind")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          requireAdmin(request);
          const { pack } = await loadContent();
          const rows = pack.tables[params.kind];
          if (!rows) fail(400, `unknown kind '${params.kind}'`);
          return Response.json({ kind: params.kind, entities: Object.keys(rows).sort() });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
