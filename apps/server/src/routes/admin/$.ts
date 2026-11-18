import { createFileRoute } from "@tanstack/react-router";

import { serveAdminIndex } from "@/lib/static-admin";

/**
 * GET /admin/* — SPA fallback.
 *
 * The admin keeps its views in memory rather than in the URL today, so nothing currently depends on
 * deep links. Serving the shell for unknown sub-paths costs nothing and means adding a router later
 * does not also require discovering this route.
 */
export const Route = createFileRoute("/admin/$")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { pathname } = new URL(request.url);
        const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);

        // A path with an extension is a file request, not an application route. Answering a missing
        // asset with the HTML shell would return 200 and a content-type the browser cannot execute,
        // turning a clear 404 into a confusing MIME error.
        if (lastSegment.includes(".")) {
          return Response.json({ detail: "not found" }, { status: 404 });
        }

        return serveAdminIndex();
      },
    },
  },
});
