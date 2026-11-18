import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createFileRoute } from "@tanstack/react-router";

import { validatePack } from "@hkstories/core";

import { draftExtension, draftFiles, errorResponse, mergedPack, requireAdmin } from "@/lib/admin";
import { contentDir, counts, loadContent } from "@/lib/content";
import { regenerateManifest } from "@/lib/manifest";

/**
 * POST /v1/admin/publish — fold accepted drafts into the shipped pack (PLAN 9.2, 5.7).
 *
 * Order is the safety property: **validate first, write second**. Nothing reaches the content
 * pack unless the merged pack validates, so a bad draft cannot half-publish. The manifest is then
 * regenerated in-process and its version bumped, which is what makes every booted client hot-pack
 * the new content on its next launch.
 *
 * The Python version shelled out to `tools/gen_content_manifest.py` via `subprocess` from inside
 * the request handler — a pinned interpreter spawned per publish. That is now an in-process
 * call; the hash algorithm is a wire contract, so it was ported byte-for-byte rather than
 * re-derived.
 *
 * Not transactional: a copy that fails midway leaves the pack partially written (drafts are kept,
 * so a retry finishes the job). Content lives in git, so `git diff` is the real safety net here.
 */
export const Route = createFileRoute("/v1/admin/publish")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          requireAdmin(request);

          const drafts = await draftFiles();

          const merged = await mergedPack();
          // Inheritance problems first: an unresolved chain means a document never became what it
          // says it is, so validating the half-resolved form would report consequences instead of
          // the cause.
          const issues = [...merged.issues, ...validatePack(merged.pack)];
          const errors = issues.filter((issue) => issue.level === "error");
          if (errors.length > 0) {
            // The admin reads `detail`, so the refusal keeps the Python shape.
            return Response.json(
              {
                detail: {
                  message: "validation failed — nothing was published",
                  issues,
                },
              },
              { status: 422 },
            );
          }

          const dir = contentDir();
          let published = 0;
          for (const draft of drafts) {
            const targetDir = join(dir, draft.kind);
            await mkdir(targetDir, { recursive: true });
            // Copied verbatim, so an author's formatting survives publication.
            const text = await readFile(draft.path, "utf8");
            const extension = draftExtension(draft.kind);
            await writeFile(join(targetDir, `${draft.id}.${extension}`), text, "utf8");
            published += 1;
          }

          const manifest = await regenerateManifest(dir, { bump: true });

          for (const draft of drafts) await rm(draft.path, { force: true });

          const { pack } = await loadContent();
          return Response.json({
            published,
            version: manifest.version,
            content_hash: manifest.content_hash,
            counts: counts(pack),
          });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
