import { createFileRoute } from "@tanstack/react-router";

import { errorResponse, requireAdmin } from "@/lib/admin";
import { OUTLINED, TARGETS, TEMPLATES, packPath, type ArtKind } from "@/lib/templates";

/**
 * GET /v1/admin/art/templates — the master prompts, verbatim (PLAN 8.3).
 *
 * The prompts stay server-side data: the studio never sends one back, it only shows what will
 * actually be sent. `templates.ts` says they are "kept as data so the admin can show them verbatim",
 * and this is that route — including the `{desc}` slot the creator's custom prompt fills, and the
 * post-processing each kind gets, so the preview is not a guess.
 */
export const Route = createFileRoute("/v1/admin/art/templates")({
  server: {
    handlers: {
      GET: ({ request }) => {
        try {
          requireAdmin(request);

          const kinds = (Object.keys(TARGETS) as ArtKind[]).map((kind) => {
            const [aspect, target, background] = TARGETS[kind];
            return {
              kind,
              master: TEMPLATES[kind],
              aspect,
              target_px: [target[0], target[1]],
              background,
              outlined: OUTLINED.has(kind),
              // Where a subject lands; `{id}` stands in for the subject_id the caller supplies.
              path_hint: packPath(kind, "{id}"),
            };
          });

          return Response.json({ kinds });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
