import { createFileRoute } from "@tanstack/react-router";

import { DB_NOT_READY, hasDatabase } from "@/db/client";
import { preflight, withCors } from "@/lib/cors";
import {
  asPublicSession,
  chatModel,
  chatOutputMode,
  clientIp,
  createSession,
  sessionAllowed,
} from "@/lib/sessions";

/**
 * POST /v1/session — hand the client a session token and its budget (PLAN 7.1, 7.5).
 *
 * Same contract as before the move to Postgres: `429 daily_cap` when an address has used up its
 * day's sessions, `503 session_store_full` when the store refuses a new row. The store is now a
 * table rather than a `Map`, so the token is meaningful to every instance instead of only the one
 * that issued it.
 */
export const Route = createFileRoute("/v1/session")({
  server: {
    handlers: {
      POST: withCors(async ({ request }) => {
        if (!hasDatabase()) {
          return Response.json({ detail: DB_NOT_READY }, { status: 503 });
        }

        const ip = clientIp(request);

        try {
          if (!(await sessionAllowed(ip))) {
            return Response.json({ detail: { code: "daily_cap" } }, { status: 429 });
          }

          const created = await createSession(ip);
          if (!created.ok) {
            // `createSession` re-checks the cap inside its transaction, so this arm is reachable
            // only when two requests raced past the check above.
            if (created.reason === "daily_cap") {
              return Response.json({ detail: { code: "daily_cap" } }, { status: 429 });
            }
            return Response.json({ detail: { code: "session_store_full" } }, { status: 503 });
          }

          return Response.json({
            ...asPublicSession(created.session),
            model: chatModel(),
            output_mode: chatOutputMode(),
          });
        } catch (error) {
          // A session store that is down is a 503, not a 500 with a stack trace attached.
          console.error(`session creation failed: ${String(error)}`);
          return Response.json({ detail: { code: "session_store_unavailable" } }, { status: 503 });
        }
      }),

      OPTIONS: ({ request }) => preflight(request),
    },
  },
});
