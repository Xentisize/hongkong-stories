import { createFileRoute } from "@tanstack/react-router";

import { evaluate, isRecord, type ConditionState } from "@hkstories/core";

import { errorResponse, fail, requireAdmin } from "@/lib/admin";

/**
 * POST /v1/admin/evaluate_condition — "would this pass, given this save?"
 *
 * Kept for contract parity even though the admin now evaluates through `@hkstories/core`
 * directly: any other client of this API gets the same answer, from the same implementation.
 */
export const Route = createFileRoute("/v1/admin/evaluate_condition")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          requireAdmin(request);
          const body: unknown = await request.json().catch(() => null);
          if (!isRecord(body)) fail(422, "expected a JSON object");

          const state = isRecord(body["state"]) ? (body["state"] as ConditionState) : {};
          const warnings: string[] = [];
          try {
            const passed = evaluate(body["condition"], state, {
              onWarning: (message) => warnings.push(message),
            });
            return Response.json({ pass: passed, warnings });
          } catch (error) {
            // A malformed condition must not 500 the SPA.
            fail(422, `unusable condition: ${String(error)}`);
          }
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
