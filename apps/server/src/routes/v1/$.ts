import { createFileRoute } from "@tanstack/react-router";

import { preflight, withCors } from "@/lib/cors";

/**
 * Unknown `/v1/*` paths answer JSON (PLAN 10.3).
 *
 * Without this the router's default not-found page answers — an HTML document with a `<p>Not
 * Found</p>` — so a game client parsing an error body got a content-type it cannot use, turning a
 * wrong URL into a mystifying parse error. The admin SPA has the same problem in reverse: it reads
 * `detail` off every failure.
 *
 * Static and dynamic sibling routes rank above a splat, so every real endpoint still wins this;
 * the splat only catches what nothing else claimed.
 */
const notFound = () => Response.json({ detail: "not found" }, { status: 404 });

export const Route = createFileRoute("/v1/$")({
  server: {
    handlers: {
      GET: withCors(notFound),
      POST: withCors(notFound),
      PUT: withCors(notFound),
      PATCH: withCors(notFound),
      DELETE: withCors(notFound),
      OPTIONS: ({ request }) => preflight(request),
    },
  },
});
