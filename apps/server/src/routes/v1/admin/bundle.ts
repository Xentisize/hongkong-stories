import { createFileRoute } from "@tanstack/react-router";

import { errorResponse, requireAdmin } from "@/lib/admin";
import { buildGameBundle } from "@/lib/bundle";

/**
 * GET /v1/admin/bundle — download the game as one portable archive.
 *
 * This is the "export everything" half of the everything-is-data design: `game.json` plus the pack
 * and every media file it references, hashed. The import side is `tools/import_bundle.ts`, and the
 * two share one definition of the format (`packages/core/src/bundle.ts`), so an archive from the
 * admin and one from a terminal verify identically.
 *
 * An incomplete bundle is a refusal, not a download: if a referenced file is missing, the archive
 * would look fine and play with nothing drawn there. The issues use the same `{level, path,
 * message}` shape as validation, so the admin's error list needs no special case.
 */
export const Route = createFileRoute("/v1/admin/bundle")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          requireAdmin(request);

          const built = await buildGameBundle();
          if (built.missing.length > 0) {
            return Response.json(
              {
                detail: {
                  message: "bundle is incomplete — referenced files are missing",
                  issues: built.missing.map((entry) => ({
                    level: "error",
                    path: entry.path,
                    message: `needed by ${entry.refs.join(", ")}`,
                  })),
                },
              },
              { status: 422 },
            );
          }

          return new Response(built.zip, {
            headers: {
              "content-type": "application/zip",
              // The filename carries the resolved hash, so two downloads are distinguishable in a
              // downloads folder without opening either archive.
              "content-disposition": `attachment; filename="game-${built.manifest.content.resolved_hash}.zip"`,
              "cache-control": "no-store",
              "x-hks-content-hash": built.manifest.content.resolved_hash,
            },
          });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
