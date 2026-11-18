import { createFileRoute } from "@tanstack/react-router";

import { PROPOSAL_KINDS, isRecord, parseProposal, toKey } from "@hkstories/core";

import { errorResponse, fail, mergedPack, requireAdmin } from "@/lib/admin";
import { UpstreamError, completeStructured } from "@/lib/completion";
import { chatModel } from "@/lib/sessions";
import { logEvent } from "@/lib/usage";

/**
 * POST /v1/admin/ai/propose — ask the co-pilot for a *proposal*, never for a write.
 *
 * The model returns the steps it intends plus the complete documents it would create or update.
 * Nothing here touches the content pack: the studio shows the plan and the change to the author, and
 * applies it — through the ordinary draft path — only when they approve. That is what keeps an AI
 * edit inside the same validate → undo → publish rules as a hand-typed one, and what makes the
 * rejection case free.
 *
 * The prompt carries an index of what exists (ids per kind), because the most common failure of a
 * model in a content pipeline is inventing a reference to something that does not exist.
 */

const SYSTEM = [
  "You are the co-pilot of a small 2D game builder for people who have never made a game.",
  "You propose content documents; you never explain at length and never write files.",
  "Reply with JSON only: {\"plan\": [\"step\", ...], \"changes\": [{\"kind\", \"id\", \"op\", \"summary\", \"doc\"}]}.",
  `Allowed kinds: ${PROPOSAL_KINDS.join(", ")}.`,
  "op is 'create' or 'update'. doc is the COMPLETE document, not a patch.",
  "Reference only ids that appear in the index you are given, or ids you are creating in the same proposal.",
  "Every change needs a one-line summary in the author's own language, phrased as what the player will see.",
  "Keep the plan to 2-5 short steps. If the request is ambiguous, still produce a sensible, small, playable result.",
].join("\n");

/** A compact index of what exists: ids per kind, capped — enough to avoid invented references. */
function packIndex(tables: Record<string, Record<string, unknown>> | undefined): string {
  if (tables === undefined) return "（未有內容 / empty pack）";
  const lines: string[] = [];
  for (const kind of PROPOSAL_KINDS) {
    if (kind === "settings") continue;
    const table = tables[kind];
    if (table === undefined) continue;
    const ids = Object.keys(table).sort();
    lines.push(`${kind} (${ids.length}): ${ids.slice(0, 60).join(", ")}`);
  }
  return lines.join("\n");
}

export const Route = createFileRoute("/v1/admin/ai/propose")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          requireAdmin(request);

          const apiKey = process.env.OPENROUTER_API_KEY ?? "";
          if (!apiKey) fail(503, "OPENROUTER_API_KEY is not configured");

          const body: unknown = await request.json().catch(() => null);
          if (!isRecord(body)) fail(422, "expected a JSON object");

          const intent = String(body["intent"] ?? "").trim();
          if (intent === "") fail(422, "intent is required");

          const scene = toKey(body["scene"] ?? "");

          // The pack the author is editing, so "add a character to this street" has something to
          // point at. Drafts count: the co-pilot should see what is on screen.
          const { pack } = await mergedPack();
          const tables = pack.tables as Record<string, Record<string, unknown>>;
          const sceneDoc = scene !== "" && isRecord(tables["locations"]?.[scene]) ? tables["locations"][scene] : null;

          const messages = [
            { role: "system" as const, content: SYSTEM },
            {
              role: "user" as const,
              content: [
                `Author's request: ${intent}`,
                sceneDoc === null ? "" : `Current scene (${scene}): ${JSON.stringify(sceneDoc).slice(0, 4000)}`,
                "What exists:",
                packIndex(tables),
              ]
                .filter((line) => line !== "")
                .join("\n\n"),
            },
          ];

          const model = chatModel();
          const started = performance.now();
          let result;
          try {
            result = await completeStructured(
              { apiKey, model, messages, temperature: 0.5, maxTokens: 2000 },
              { type: "json_object" },
            );
          } catch (error) {
            if (error instanceof UpstreamError) {
              return Response.json(
                { detail: { code: error.code, message: error.message } },
                { status: 502 },
              );
            }
            throw error;
          }

          const proposal = parseProposal(result.raw);
          if (proposal === null) {
            // Nothing usable is a refusal, not an empty success: an approval card with no changes
            // would teach the author that the co-pilot "worked" when it did not.
            return Response.json(
              {
                detail: {
                  code: "no_proposal",
                  message: "the model returned no usable proposal",
                  raw: result.raw.slice(0, 400),
                },
              },
              { status: 502 },
            );
          }

          // The ledger records what the call cost and where it happened; the change count is already
          // in the response the studio shows, so it does not belong in the usage schema.
          await logEvent("ai_propose", {
            path: scene === "" ? undefined : `locations/${scene}`,
            tokens: result.promptTokens + result.completionTokens,
            cost_usd: result.costUsd,
            latency_ms: Math.round((performance.now() - started) * 10) / 10,
          });

          return Response.json({
            proposal,
            model,
            cost_usd: result.costUsd,
            usage: {
              prompt_tokens: result.promptTokens,
              completion_tokens: result.completionTokens,
            },
          });
        } catch (error) {
          return errorResponse(error);
        }
      },
    },
  },
});
