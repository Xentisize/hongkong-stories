import { createFileRoute } from "@tanstack/react-router";

import { draftFiles, errorResponse, requireAdmin } from "@/lib/admin";

/** GET /v1/admin/drafts — the accepted-drafts list in the editor sidebar. */
export const Route = createFileRoute("/v1/admin/drafts")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          requireAdmin(request);
          const files = await draftFiles();
          return Response.json(
            files.map((file) => ({ kind: file.kind, id: file.id, updated: file.updated })),
          );
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
