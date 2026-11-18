import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { createFileRoute } from "@tanstack/react-router";

import { isRecord } from "@hkstories/core";

import { draftPath, errorResponse, fail, requireAdmin } from "@/lib/admin";

/**
 * GET / PUT / DELETE /v1/admin/drafts/{kind}/{id}
 *
 * A draft is one JSON file under the admin data directory, which is deliberate: drafts are
 * authoring scratch space that survives a restart but never ships. Publishing copies them into
 * the content pack, where git keeps the history.
 */
export const Route = createFileRoute("/v1/admin/drafts/$kind/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          requireAdmin(request);
          const path = draftPath(params.kind, params.id);
          try {
            return new Response(await readFile(path, "utf8"), {
              headers: { "content-type": "application/json; charset=utf-8" },
            });
          } catch {
            fail(404, "no such draft");
          }
        } catch (error) {
          return errorResponse(error);
        }
      },

      PUT: async ({ request, params }) => {
        try {
          requireAdmin(request);
          const body: unknown = await request.json().catch(() => null);
          if (!isRecord(body)) fail(422, "draft body must be a JSON object");
          if (String(body["id"] ?? "") !== params.id) {
            fail(422, "body id must match the URL id");
          }

          const path = draftPath(params.kind, params.id);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, JSON.stringify(body, null, 2) + "\n", "utf8");
          return Response.json({ saved: true, kind: params.kind, id: params.id });
        } catch (error) {
          return errorResponse(error);
        }
      },

      DELETE: async ({ request, params }) => {
        try {
          requireAdmin(request);
          const path = draftPath(params.kind, params.id);
          await rm(path, { force: true });
          return Response.json({ deleted: true, kind: params.kind, id: params.id });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
