import { createFileRoute } from "@tanstack/react-router";

import { errorResponse, fail, requireAdmin } from "@/lib/admin";
import { DB_NOT_READY, ledgerReady } from "@/db/client";
import { aggregate } from "@/lib/usage";

/**
 * GET /v1/admin/usage — month-to-date rollup for the dashboard.
 *
 * Refuses rather than returning zeros when the ledger is unreachable: an all-zero dashboard is
 * indistinguishable from a month with no traffic, which is the worst possible failure mode for a
 * spend view.
 */
export const Route = createFileRoute("/v1/admin/usage")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          requireAdmin(request);
          if (!(await ledgerReady())) fail(503, DB_NOT_READY);
          return Response.json(await aggregate());
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
