import { isRecord, npcReplyResponseFormat, parseNpcReplyJSON } from "@hkstories/core";

/**
 * Chat completions against OpenRouter, with REAL provider usage (PLAN 7.5, 9.2).
 *
 * Two modes, because the two callers want opposite things:
 *  - `completeChat` is the structured path (playground): `response_format` from the shared zod
 *    schema, parsed into say/mood/actions.
 *  - `completeProse` is the fact-checker: **no** `response_format`, because constraining the reply
 *    to the NPC shape would shape the verdict wrong. It returns the raw text and the caller parses
 *    defensively — an unparsable verdict becomes `questionable`, which is exactly what a review
 *    queue is for.
 *
 * Both report real prompt/completion/cached tokens, which a non-streaming response includes. The
 * streaming `/v1/chat` path cannot, which is why it estimates instead.
 */

const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

/** PLAN 7.5 price model, ported from `server/app/usage.py` so the dashboard and this agree. */
const PRICE_PER_M_IN = 0.15;
const PRICE_PER_M_OUT = 0.6;
const PRICE_PER_M_CACHED = 0.003;

export function estimateCost(promptTokens: number, cachedTokens: number, completionTokens: number): number {
  const fresh = Math.max(promptTokens - cachedTokens, 0);
  return (
    (fresh * PRICE_PER_M_IN + cachedTokens * PRICE_PER_M_CACHED + completionTokens * PRICE_PER_M_OUT) /
    1_000_000
  );
}

export class UpstreamError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface CompleteChatOptions {
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature: number;
  maxTokens: number;
  timeoutMs?: number;
}

export interface ChatCompletion {
  say: string;
  mood: string;
  /** Raw, unvalidated actions: the caller runs them through the allowlist. */
  actions: unknown[];
  truncated: boolean;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export interface ProseCompletion {
  raw: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
}

interface RawResult {
  content: string;
  truncated: boolean;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
}

async function callChat(
  options: CompleteChatOptions,
  responseFormat: unknown | null,
): Promise<RawResult> {
  if (!options.apiKey) throw new UpstreamError("no_api_key", "OPENROUTER_API_KEY is not configured");

  const payload: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
    temperature: options.temperature,
    max_tokens: options.maxTokens,
  };
  if (responseFormat) payload["response_format"] = responseFormat;

  let response: Response;
  try {
    response = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
  } catch (error) {
    throw new UpstreamError("upstream_unreachable", `chat request failed: ${String(error)}`);
  }

  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 400);
    throw new UpstreamError(`upstream_http_${response.status}`, body);
  }

  const body = (await response.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };

  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
  const content = choice?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new UpstreamError("empty_response", "the model returned no content");
  }

  const promptTokens = Number(body.usage?.prompt_tokens ?? 0);
  const completionTokens = Number(body.usage?.completion_tokens ?? 0);
  const cachedTokens = Number(body.usage?.prompt_tokens_details?.cached_tokens ?? 0);

  return {
    content,
    truncated: choice?.finish_reason === "length",
    promptTokens,
    completionTokens,
    cachedTokens,
    // The §7.5 model rather than the provider's own figure: the dashboard aggregates with this,
    // and two cost sources that disagree are worse than one estimate everywhere.
    costUsd: estimateCost(promptTokens, cachedTokens, completionTokens),
  };
}

export async function completeChat(options: CompleteChatOptions): Promise<ChatCompletion> {
  const result = await callChat(options, npcReplyResponseFormat());

  const parsed = parseNpcReplyJSON(result.content);
  if (!parsed.ok) throw new UpstreamError("bad_output", parsed.error);

  return {
    say: parsed.reply.say,
    mood: parsed.reply.mood,
    actions: parsed.reply.actions,
    truncated: result.truncated,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    cachedTokens: result.cachedTokens,
    costUsd: result.costUsd,
  };
}

export async function completeProse(options: CompleteChatOptions): Promise<ProseCompletion> {
  const result = await callChat(options, null);
  return {
    raw: result.content,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    cachedTokens: result.cachedTokens,
    costUsd: result.costUsd,
  };
}

/**
 * Provider usage from one streamed chunk, or `null` for every chunk that does not carry it.
 *
 * A non-streaming response includes `usage` in its body; a stream only mentions it in the final
 * chunk, and only when the request asked with `usage: { include: true }`. So the caller keeps its
 * estimate until this returns something — a stream that ends early, or an upstream that ignores the
 * request, must still be charged rather than logged as zero.
 *
 * Read before `choices` is inspected: the usage chunk carries no choice at all.
 */
export interface StreamUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export function usageFromStreamChunk(chunk: unknown): StreamUsage | null {
  if (!isRecord(chunk)) return null;

  const usage = chunk["usage"];
  if (!isRecord(usage)) return null;

  // A count is only a count when it is a number. `Number(null)` is `0` and `Number("many")` is
  // `NaN`, and either would let a malformed block through as "zero tokens" — which charges the turn
  // as free. Absent or malformed means "no usage", so the caller keeps its estimate.
  const count = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;

  const promptTokens = count(usage["prompt_tokens"]);
  const completionTokens = count(usage["completion_tokens"]);
  // A usage block with neither count is noise, not information.
  if (promptTokens === null && completionTokens === null) return null;

  const details = isRecord(usage["prompt_tokens_details"]) ? usage["prompt_tokens_details"] : {};

  return {
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    cachedTokens: count(details["cached_tokens"]) ?? 0,
  };
}

/**
 * A completion constrained by a caller-supplied `response_format`, returning the raw text.
 *
 * The caller still parses it. A schema raises the odds of usable JSON but does not guarantee it —
 * a server that trusts the schema without checking has no defence on the turn the model ignores it.
 */
export async function completeStructured(
  options: CompleteChatOptions,
  responseFormat: unknown,
): Promise<ProseCompletion> {
  const result = await callChat(options, responseFormat);
  return {
    raw: result.content,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    cachedTokens: result.cachedTokens,
    costUsd: result.costUsd,
  };
}
