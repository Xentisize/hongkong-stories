import { createFileRoute } from "@tanstack/react-router";

import { validatePack } from "@hkstories/core";

import { errorResponse, mergedPack, requireAdmin } from "@/lib/admin";

/**
 * POST /v1/admin/validate — the publish gate, over baseline + drafts.
 *
 * The validator is `@hkstories/core`, so this answer is the same one the admin's inline checks
 * and the client's boot-time check produce. Under Python it was a separate implementation kept
 * in step by a shared fixture table; that duplication is gone.
 */
export const Route = createFileRoute("/v1/admin/validate")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          requireAdmin(request);
          const merged = await mergedPack();
          const issues = [...merged.issues, ...validatePack(merged.pack)];
          const errors = issues.filter((issue) => issue.level === "error");
          return Response.json({ ok: errors.length === 0, issues });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
