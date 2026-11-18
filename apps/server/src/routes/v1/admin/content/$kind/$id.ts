import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createFileRoute } from "@tanstack/react-router";

import { errorResponse, fail, requireAdmin } from "@/lib/admin";
import { contentDir, loadContent } from "@/lib/content";

/**
 * GET /v1/admin/content/{kind}/{id} — one baseline entity, for cloning into a draft.
 *
 * A lore page is answered as text: it is markdown, and wrapping it in JSON would both escape the
 * prose and invite the admin to send it back as a JSON string.
 */
export const Route = createFileRoute("/v1/admin/content/$kind/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          requireAdmin(request);

          if (params.kind === "lore") {
            if (params.id.includes("/") || params.id.includes("..")) fail(400, "bad id");
            let text: string;
            try {
              text = await readFile(join(contentDir(), "lore", `${params.id}.md`), "utf8");
            } catch {
              fail(404, "no such lore file");
            }
            return new Response(text, {
              headers: { "content-type": "text/markdown; charset=utf-8" },
            });
          }

          const { pack } = await loadContent();
          const entity = pack.tables[params.kind]?.[params.id];
          if (!entity) fail(404, "no such entity");
          return Response.json(entity);
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
