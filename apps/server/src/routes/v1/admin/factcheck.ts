import { createFileRoute } from "@tanstack/react-router";

import { DB_NOT_READY, ledgerReady } from "@/db/client";
import { errorResponse, fail, requireAdmin } from "@/lib/admin";
import { listEntries } from "@/lib/factcheck";

/** GET /v1/admin/factcheck — the review queue, open entries first. */
export const Route = createFileRoute("/v1/admin/factcheck")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          requireAdmin(request);
          if (!(await ledgerReady())) fail(503, DB_NOT_READY);
          return Response.json(await listEntries());
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
