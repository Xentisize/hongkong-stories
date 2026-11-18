import { createFileRoute } from "@tanstack/react-router";

import { counts, loadContent } from "@/lib/content";

/**
 * Liveness plus the facts a client or a human needs, matching the Python `/healthz` contract
 * so the existing client keeps working during the port. Never includes the key itself.
 */
export const Route = createFileRoute("/healthz")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const { pack } = await loadContent();
          return Response.json({
            status: "ok",
            content: counts(pack),
            content_hash: pack.contentHash,
            version: pack.version,
            key_present: Boolean(process.env.OPENROUTER_API_KEY),
            runtime: "tanstack-start",
          });
        } catch (error) {
          return Response.json(
            { status: "degraded", detail: String(error), runtime: "tanstack-start" },
            { status: 503 },
          );
        }
      },
    },
  },
});
