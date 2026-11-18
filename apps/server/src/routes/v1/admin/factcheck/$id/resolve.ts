import { createFileRoute } from "@tanstack/react-router";

import { isRecord } from "@hkstories/core";

import { DB_NOT_READY, ledgerReady } from "@/db/client";
import { errorResponse, fail, requireAdmin } from "@/lib/admin";
import { resolve } from "@/lib/factcheck";

/** POST /v1/admin/factcheck/{id}/resolve — a human confirms or dismisses one flagged line. */
export const Route = createFileRoute("/v1/admin/factcheck/$id/resolve")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          requireAdmin(request);
          if (!(await ledgerReady())) fail(503, DB_NOT_READY);

          const body: unknown = await request.json().catch(() => null);
          if (!isRecord(body)) fail(422, "expected a JSON object");

          let entry;
          try {
            entry = await resolve(params.id, String(body["status"] ?? ""));
          } catch (error) {
            // A bad status is the caller's mistake, not a server fault.
            fail(422, String(error instanceof Error ? error.message : error));
          }

          if (!entry) fail(404, "no such fact-check entry");
          return Response.json(entry);
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
