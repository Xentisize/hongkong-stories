import { readFile } from "node:fs/promises";

import { createFileRoute } from "@tanstack/react-router";

import { draftFiles, errorResponse, requireAdmin } from "@/lib/admin";
import { loadContent } from "@/lib/content";
import { canonical } from "@/lib/manifest";

/**
 * GET /v1/admin/publish_preview — the diff publish would apply (PLAN 9.2).
 *
 * Read-only, so the confirmation dialog can list what will ship. An entity the baseline has never
 * seen is `added`; one that exists but differs from the draft is `changed`.
 *
 * This compares drafts against the **baseline**, not against `mergedPack()`: the merged pack has
 * the drafts already applied, so every comparison would come back identical.
 */
export const Route = createFileRoute("/v1/admin/publish_preview")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          requireAdmin(request);

          const baseline = (await loadContent()).pack;
          const added: Array<{ kind: string; id: string }> = [];
          const changed: Array<{ kind: string; id: string }> = [];

          for (const draft of await draftFiles()) {
            const entry = { kind: draft.kind, id: draft.id };
            const current = baseline.tables[draft.kind]?.[draft.id];

            if (current === undefined) {
              added.push(entry);
              continue;
            }

            let written: unknown;
            try {
              written = JSON.parse(await readFile(draft.path, "utf8"));
            } catch {
              continue; // unreadable draft: validate reports it rather than preview guessing
            }
            if (canonical(written) !== canonical(current)) changed.push(entry);
          }

          return Response.json({ added, changed });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
