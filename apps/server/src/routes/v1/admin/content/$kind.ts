import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { createFileRoute } from "@tanstack/react-router";

import { errorResponse, fail, requireAdmin } from "@/lib/admin";
import { contentDir, loadContent } from "@/lib/content";

/**
 * GET /v1/admin/content/{kind} — the baseline ids, used for clone-from-baseline.
 *
 * `lore` is the one kind that is not an entity table: its files are markdown pages under
 * `content/lore/`, so the list comes from the directory rather than from the pack. The id is the
 * file name without `.md`, which is exactly what an item's `lore_ref` points at.
 */
export const Route = createFileRoute("/v1/admin/content/$kind")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          requireAdmin(request);

          if (params.kind === "lore") {
            let names: string[];
            try {
              names = await readdir(join(contentDir(), "lore"));
            } catch {
              names = []; // no lore authored yet is not an error
            }
            const ids = names
              .filter((name) => name.endsWith(".md"))
              .map((name) => name.slice(0, -".md".length))
              .sort();
            return Response.json({ kind: "lore", entities: ids });
          }

          const { pack } = await loadContent();
          const rows = pack.tables[params.kind];
          if (!rows) fail(400, `unknown kind '${params.kind}'`);
          return Response.json({ kind: params.kind, entities: Object.keys(rows).sort() });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
