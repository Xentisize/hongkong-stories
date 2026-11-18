import { createFileRoute } from "@tanstack/react-router";

import { isRecord, toKey, validateActions, type ConditionState } from "@hkstories/core";

import { errorResponse, fail, requireAdmin } from "@/lib/admin";
import { UpstreamError, completeChat } from "@/lib/completion";
import { buildMessages } from "@/lib/prompts";
import { chatModel } from "@/lib/sessions";
import { logEvent } from "@/lib/usage";

/**
 * POST /v1/admin/playground — chat with a DRAFT npc through the real pipeline (PLAN 9.2).
 *
 * The SPA posts the unsaved draft itself, so this works for an author mid-edit and never needs the
 * draft to be on disk. Per turn the response carries real prompt/completion/cached tokens, cost,
 * latency, and the actions the model TRIED that the allowlist rejected — surfaced explicitly,
 * never hidden.
 *
 * Usage-log persistence is not wired yet: `usage.log_event` lives in the ledger slice that follows
 * this one, so a playground turn is currently not counted toward the dashboard.
 */
export const Route = createFileRoute("/v1/admin/playground")({
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
          if (!isRecord(npc) || !toKey(npc["id"] ?? "")) fail(422, "npc draft is required");

          const state = (isRecord(body["state"]) ? body["state"] : {}) as ConditionState;
          const lang = toKey(body["lang"] ?? "zh_HK");
          const history = Array.isArray(body["history"]) ? body["history"] : [];
          const playerInput = String(body["input"] ?? "").trim();

          const messages = buildMessages(npc, state, lang, history, playerInput);

          const npcLlm = isRecord(npc["llm"]) ? npc["llm"] : {};
          const model = toKey(npcLlm["model"] ?? "") || chatModel();
          const temperature = Number(npcLlm["temperature"] ?? 0.85);
          const maxTokens = Number(npcLlm["max_tokens"] ?? 320);

          const started = performance.now();
          let result;
          try {
            result = await completeChat({ apiKey, model, messages, temperature, maxTokens });
          } catch (error) {
            if (error instanceof UpstreamError) {
              return Response.json(
                { detail: { code: error.code, message: error.message } },
                { status: 502 },
              );
            }
            throw error;
          }
          const latencyMs = Math.round((performance.now() - started) * 10) / 10;

          // The model performs; the game decides (§7.3) — same allowlist the client and the chat
          // route use, checked against the draft's own declared permission.
          const verdict = validateActions(
            result.actions,
            { llm: npc["llm"], secrets: npc["secrets"] },
            state,
          );

          const cacheRatio = result.promptTokens > 0 ? result.cachedTokens / result.promptTokens : 0;

          await logEvent("playground", {
            npc: toKey(npc["id"] ?? ""),
            tokens: result.promptTokens + result.completionTokens,
            cost_usd: result.costUsd,
            latency_ms: latencyMs,
            cached_tokens: result.cachedTokens,
            rejected: verdict.rejected.map((entry) => entry.reason),
          });

          return Response.json({
            say: result.say,
            mood: result.mood,
            actions: verdict.accepted,
            rejected: verdict.rejected,
            truncated: result.truncated,
            usage: {
              prompt_tokens: result.promptTokens,
              completion_tokens: result.completionTokens,
              cached_tokens: result.cachedTokens,
              cache_ratio: cacheRatio,
              cost_usd: result.costUsd,
            },
            latency_ms: latencyMs,
            model,
          });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
