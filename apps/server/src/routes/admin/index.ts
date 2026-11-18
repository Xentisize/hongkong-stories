import { createFileRoute } from "@tanstack/react-router";

import { serveAdminIndex } from "@/lib/static-admin";

/** GET /admin/ — the SPA's entry document (assets are served statically from public/admin/). */
export const Route = createFileRoute("/admin/")({
  server: {
    handlers: {
      GET: async () => serveAdminIndex(),
    },
  },
});
