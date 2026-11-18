import { createFileRoute } from "@tanstack/react-router";

import { errorResponse, fail, requireAdmin } from "@/lib/admin";
import { loadContent } from "@/lib/content";

/** GET /v1/admin/content/{kind}/{id} — one baseline entity, for cloning into a draft. */
export const Route = createFileRoute("/v1/admin/content/$kind/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          requireAdmin(request);
          const { pack } = await loadContent();
          const entity = pack.tables[params.kind]?.[params.id];
          if (!entity) fail(404, "no such entity");
          return Response.json(entity);
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
