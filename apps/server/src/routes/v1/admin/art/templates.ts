import { createFileRoute } from "@tanstack/react-router";

import { isRecord, resolveArtMedium, resolveArtStyle } from "@hkstories/core";

import { errorResponse, mergedPack, requireAdmin } from "@/lib/admin";
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
      GET: async ({ request }) => {
        try {
          requireAdmin(request);

          // The style is what every prompt will actually be anchored with, so the studio shows the
          // resolved one — including a draft choice, since that is what the next render would use.
          const { pack } = await mergedPack();
          const settingsDoc = pack.tables["settings"]?.["game"];
          const art = isRecord(settingsDoc) && isRecord(settingsDoc["art"]) ? settingsDoc["art"] : {};
          const style = resolveArtStyle(art["style"]);
          const medium = resolveArtMedium(art["medium"]);

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

          return Response.json({
            // The look the studio shows: both axes, their six rules, and the fragment each
            // contributes — the fragment is what lets the preview show the prompt as sent.
            style: {
              id: style.id,
              name: style.name,
              summary: style.summary,
              rules: style.rules,
              master: style.master,
            },
            medium: {
              id: medium.id,
              name: medium.name,
              summary: medium.summary,
              rules: medium.rules,
              master: medium.master,
            },
            kinds,
          });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
