import { createFileRoute } from "@tanstack/react-router";

import { errorResponse, requireAdmin } from "@/lib/admin";
import { aggregate } from "@/lib/usage";

/** GET /v1/admin/usage — month-to-date rollup for the dashboard. */
export const Route = createFileRoute("/v1/admin/usage")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          requireAdmin(request);
          return Response.json(await aggregate());
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
