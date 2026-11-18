import { createFileRoute } from "@tanstack/react-router";

import { isRecord } from "@hkstories/core";

import { errorResponse, fail, requireAdmin } from "@/lib/admin";
import { UpstreamError } from "@/lib/completion";
import { check } from "@/lib/factcheck";
import { chatModel } from "@/lib/sessions";
import { logEvent } from "@/lib/usage";

/**
 * POST /v1/admin/factcheck/check — score one line against the draft's lore and queue it.
 *
 * Accepts the unsaved draft, so an author can fact-check a playground reply before the NPC exists
 * as a file. The verdict never rewrites the player's text: it only flags the line for a human.
 */
export const Route = createFileRoute("/v1/admin/factcheck/check")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          requireAdmin(request);

          const apiKey = process.env.OPENROUTER_API_KEY ?? "";
          if (!apiKey) fail(503, "OPENROUTER_API_KEY is not configured");

          const body: unknown = await request.json().catch(() => null);
          if (!isRecord(body)) fail(422, "expected a JSON object");

          const npc = body["npc"];
          if (!isRecord(npc)) fail(422, "npc draft is required");

          const reply = String(body["reply"] ?? "").trim();
          if (!reply) fail(422, "reply is required");

          const playerInput = String(body["player_input"] ?? "");

          let entry;
          try {
            entry = await check({ apiKey, model: chatModel() }, npc, playerInput, reply);
          } catch (error) {
            if (error instanceof UpstreamError) {
              return Response.json(
                { detail: { code: error.code, message: error.message } },
                { status: 502 },
              );
            }
            throw error;
          }

          await logEvent("fact_check", { npc: entry.npc_id, cost_usd: entry.cost_usd });
          return Response.json(entry);
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
