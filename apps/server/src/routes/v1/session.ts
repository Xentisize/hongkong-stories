import { createFileRoute } from "@tanstack/react-router";

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
 * Same contract as the Python route: refused with 429 `daily_cap` once an address has burned
 * through its day's sessions, and the response shape is unchanged so the existing Godot client
 * keeps working through the port.
 */
export const Route = createFileRoute("/v1/session")({
  server: {
    handlers: {
      POST: withCors(async ({ request }) => {
        const ip = clientIp(request);

        if (!sessionAllowed(ip)) {
          return Response.json({ detail: { code: "daily_cap" } }, { status: 429 });
        }

        const session = createSession(ip);
        if (!session) {
          return Response.json({ detail: { code: "session_store_full" } }, { status: 503 });
        }

        return Response.json({
          ...asPublicSession(session),
          model: chatModel(),
          output_mode: chatOutputMode(),
        });
      }),

      OPTIONS: ({ request }) => preflight(request),
    },
  },
});
