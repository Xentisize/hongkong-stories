import { createFileRoute } from "@tanstack/react-router";

import {
  MAX_ACTIONS_PER_TURN,
  evaluate,
  isRecord,
  npcReplyResponseFormat,
  parseNpcReplyJSON,
  toKey,
  validateActions,
  type ConditionState,
} from "@hkstories/core";

import { loadContent } from "@/lib/content";
import { buildMessages } from "@/lib/prompts";
import { SayExtractor } from "@/lib/say-extractor";
import { asPublicSession, chatModel, getSession, remainingOf } from "@/lib/sessions";

/**
 * POST /v1/chat — one streaming conversation turn (PLAN 7.1).
 *
 * **SSE, not WebSocket.** The Python route accepted a socket, read exactly one `start` frame,
 * streamed tokens, sent `done` and closed. There was never a second receive and never a
 * mid-turn cancel, so it was a streaming request wearing a socket costume. EventSource/fetch
 * streaming is protocol-identical here and removes the need for a WebSocket server entirely.
 *
 * The frame JSON is unchanged, so a client port only has to swap transport:
 *   data: {"type":"token","t":"..."}
 *   data: {"type":"done", ...}
 *   data: {"type":"error","code":"..."}
 *
 * Every failure path ends in an `error` frame rather than a dropped stream, because the client's
 * fallback ladder keys on it: a silent close would leave the player staring at "thinking" (§7.4).
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Streaming has no reliable provider usage, so cost/latency work off an estimate (§7.5). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sse(chunk: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`);
}

/** Emit a single error frame and close — the contract the client's fallback ladder expects. */
function errorStream(code: string, detail?: string): Response {
  const payload = detail ? { type: "error", code, detail: detail.slice(0, 200) } : { type: "error", code };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(sse(payload));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

export const Route = createFileRoute("/v1/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        if (!isRecord(body)) return errorStream("bad_request", "expected a JSON body");

        const session = getSession(toKey(body["session_token"] ?? ""));
        if (!session) return errorStream("unknown_session");
        if (remainingOf(session) <= 0) return errorStream("budget_exceeded");

        const apiKey = process.env.OPENROUTER_API_KEY ?? "";
        if (!apiKey) return errorStream("no_api_key");

        const npcId = toKey(body["npc_id"] ?? "");
        const { pack } = await loadContent();
        const npc = pack.tables["npcs"]?.[npcId];
        if (!npc) return errorStream("unknown_npc");

        const lang = toKey(body["lang"] ?? "zh_HK");
        const state = (isRecord(body["state"]) ? body["state"] : {}) as ConditionState;
        const playerInput = String(body["input"] ?? "").trim();
        const prefetch = Boolean(body["prefetch"]);

        const messages = buildMessages(npc, state, lang, body["history"], playerInput);
        const promptTokens = estimateTokens(messages.map((message) => message.content).join(""));
        // Refuse before spending money, not after.
        if (promptTokens > remainingOf(session)) return errorStream("budget_exceeded");

        const model = toKey((isRecord(npc["llm"]) ? npc["llm"]["model"] : undefined) ?? "") || chatModel();
        const npcLlm = isRecord(npc["llm"]) ? npc["llm"] : {};
        const temperature = Number(npcLlm["temperature"] ?? envNumber("HKS_TEMPERATURE", 0.85));
        const maxTokens = Number(npcLlm["max_tokens"] ?? envNumber("HKS_MAX_TOKENS", 320));
        const timeoutMs = envNumber("HKS_UPSTREAM_TIMEOUT", 30) * 1000;

        const upstream = await fetch(OPENROUTER_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages,
            temperature,
            max_tokens: maxTokens,
            stream: true,
            response_format: npcReplyResponseFormat(),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        }).catch(() => null);

        if (!upstream || !upstream.ok || !upstream.body) {
          const detail = upstream ? `upstream_http_${upstream.status}` : "upstream_unreachable";
          return errorStream(detail, upstream ? (await upstream.text().catch(() => "")).slice(0, 200) : "");
        }

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const extractor = new SayExtractor();
            const decoder = new TextDecoder();
            let buffer = "";
            let raw = "";
            let finishReason = "";

            try {
              for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
                buffer += decoder.decode(chunk, { stream: true });

                let newline = buffer.indexOf("\n");
                while (newline !== -1) {
                  const line = buffer.slice(0, newline).trim();
                  buffer = buffer.slice(newline + 1);
                  newline = buffer.indexOf("\n");

                  if (!line.startsWith("data:")) continue;
                  const payload = line.slice(5).trim();
                  if (payload === "[DONE]") continue;

                  let parsed: unknown;
                  try {
                    parsed = JSON.parse(payload);
                  } catch {
                    continue;
                  }
                  if (!isRecord(parsed)) continue;

                  const choice = Array.isArray(parsed["choices"]) ? parsed["choices"][0] : undefined;
                  if (!isRecord(choice)) continue;
                  if (typeof choice["finish_reason"] === "string" && choice["finish_reason"]) {
                    finishReason = choice["finish_reason"];
                  }

                  const delta = choice["delta"];
                  const content = isRecord(delta) ? delta["content"] : undefined;
                  if (typeof content !== "string" || content === "") continue;

                  raw += content;
                  const text = extractor.feed(content);
                  if (text) controller.enqueue(sse({ type: "token", t: text }));
                }
              }

              if (!raw.trim()) {
                controller.enqueue(sse({ type: "error", code: "empty_response" }));
                controller.close();
                return;
              }

              const parsedReply = parseNpcReplyJSON(raw);
              if (!parsedReply.ok) {
                controller.enqueue(sse({ type: "error", code: "bad_output", detail: parsedReply.error }));
                controller.close();
                return;
              }

              const reply = parsedReply.reply;
              // The model performs; the game decides (§7.3). Core's allowlist is the same one
              // the client and the admin use, checked against the NPC's declared permission.
              const verdict = validateActions(reply.actions, { llm: npc["llm"], secrets: npc["secrets"] }, state);

              const used = promptTokens + estimateTokens(reply.say);
              session.usedTokens += Math.max(0, used);
              session.turns += 1;

              controller.enqueue(
                sse({
                  type: "done",
                  say: reply.say,
                  mood: reply.mood,
                  actions: verdict.accepted,
                  rejected: verdict.rejected,
                  prefetch,
                  truncated: finishReason === "length",
                  model,
                  usage: {
                    tokens: used,
                    remaining: asPublicSession(session).remaining,
                    turn: session.turns,
                    max_actions: MAX_ACTIONS_PER_TURN,
                  },
                }),
              );
              controller.close();
            } catch (error) {
              // A transport surprise must degrade, never drop the stream silently.
              controller.enqueue(sse({ type: "error", code: "upstream_error", detail: String(error) }));
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no",
          },
        });
      },
    },
  },
});
