import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { createFileRoute } from "@tanstack/react-router";

import { isRecord } from "@hkstories/core";

import { draftExtension, draftPath, errorResponse, fail, requireAdmin } from "@/lib/admin";

/**
 * GET / PUT / DELETE /v1/admin/drafts/{kind}/{id}
 *
 * A draft is one file under the admin data directory, which is deliberate: drafts are authoring
 * scratch space that survives a restart but never ships. Publishing copies them into the content
 * pack, where git keeps the history.
 *
 * The body shape follows the kind. Entities are JSON objects whose `id` must match the URL; a lore
 * page is markdown text, stored and returned verbatim so an author's formatting survives the round
 * trip.
 */
export const Route = createFileRoute("/v1/admin/drafts/$kind/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          requireAdmin(request);
          const path = draftPath(params.kind, params.id);
          let text: string;
          try {
            text = await readFile(path, "utf8");
          } catch {
            fail(404, "no such draft");
          }

          if (draftExtension(params.kind) === "md") {
            return new Response(text, {
              headers: { "content-type": "text/markdown; charset=utf-8" },
            });
          }
          return new Response(text, {
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        } catch (error) {
          return errorResponse(error);
        }
      },

      PUT: async ({ request, params }) => {
        try {
          requireAdmin(request);
          const path = draftPath(params.kind, params.id);

          if (draftExtension(params.kind) === "md") {
            // Verbatim: a markdown draft has no id field to check, so the URL id is the contract.
            const text = await request.text();
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, text, "utf8");
            return Response.json({ saved: true, kind: params.kind, id: params.id });
          }

          const body: unknown = await request.json().catch(() => null);
          if (!isRecord(body)) fail(422, "draft body must be a JSON object");
          if (String(body["id"] ?? "") !== params.id) {
            fail(422, "body id must match the URL id");
          }

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
