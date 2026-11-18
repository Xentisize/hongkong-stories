import { isRecord, type ConditionState } from "@hkstories/core";

/**
 * The client's side of the chat contract.
 *
 * The server answers `/v1/chat` as SSE — `data: {json}\n\n` per frame — because the Python original
 * accepted a WebSocket, read one start frame, streamed tokens and closed. Godot needed
 * `WebSocketPeer` for that only because its `HTTPRequest` cannot stream; a browser can, so fetch
 * streaming is the whole transport.
 *
 * Two details are load-bearing and easy to get wrong:
 *
 * - **Frames split across chunks.** A `data:` line can arrive in two reads, so the parser has to
 *   keep a tail buffer and only emit complete frames.
 * - **UTF-8 split across chunks.** Cantonese is three bytes a character, so a chunk boundary can
 *   land inside one. Decoding each chunk independently corrupts it; `TextDecoder` with
 *   `{ stream: true }` carries the partial sequence instead.
 */

export interface Session {
  session_token: string;
  budget: number;
  remaining: number;
  model: string;
  output_mode: string;
}

export type SessionResult =
  | { ok: true; session: Session }
  | { ok: false; code: string; status: number };

export interface TokenFrame {
  type: "token";
  t: string;
}

export interface DoneFrame {
  type: "done";
  say: string;
  mood: string;
  actions: unknown[];
  rejected: unknown[];
  truncated: boolean;
  model: string;
  usage: { tokens: number; remaining: number; turn: number; max_actions?: number };
}

export interface ErrorFrame {
  type: "error";
  code: string;
  detail?: string;
}

export type ChatFrame = TokenFrame | DoneFrame | ErrorFrame;

export interface TransportOptions {
  /** Injected in tests; defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Empty means same origin, which is what the dev server's proxy provides. */
  baseUrl?: string;
}

export function apiBase(explicit?: string): string {
  if (explicit !== undefined) return explicit;
  const fromEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return fromEnv?.["VITE_HKS_API"] ?? "";
}

/** Split a decoded buffer into complete SSE payloads plus whatever partial tail is left. */
export function parseFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split("\n\n");
  // The last part is either an empty string (buffer ended on a frame boundary) or a partial frame.
  const rest = parts.pop() ?? "";

  const frames: string[] = [];
  for (const part of parts) {
    const payload = part
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");

    if (payload.length > 0) frames.push(payload);
  }

  return { frames, rest };
}

export async function openSession(options: TransportOptions = {}): Promise<SessionResult> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const base = apiBase(options.baseUrl);

  let response: Response;
  try {
    response = await doFetch(`${base}/v1/session`, { method: "POST" });
  } catch {
    return { ok: false, code: "store_unreachable", status: 0 };
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    // The route answers `{detail: {code}}` for a refusal, or `{detail: "..."}` for a 503.
    const detail = isRecord(body) ? body["detail"] : undefined;
    const code = isRecord(detail) && typeof detail["code"] === "string" ? detail["code"] : undefined;
    return { ok: false, code: code ?? `http_${response.status}`, status: response.status };
  }

  if (!isRecord(body) || typeof body["session_token"] !== "string") {
    return { ok: false, code: "bad_session_payload", status: response.status };
  }

  return { ok: true, session: body as unknown as Session };
}

export interface StreamTurnRequest {
  sessionToken: string;
  npcId: string;
  lang: string;
  state: ConditionState;
  history: Array<{ role: string; content: string }>;
  input: string;
}

export interface StreamTurnHandlers {
  onFrame: (frame: ChatFrame) => void;
  signal?: AbortSignal;
}

/** Send one turn and report every frame as it lands. Resolves when the stream closes. */
export async function streamTurn(
  request: StreamTurnRequest,
  handlers: StreamTurnHandlers,
  options: TransportOptions = {},
): Promise<void> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const base = apiBase(options.baseUrl);

  let response: Response;
  try {
    response = await doFetch(`${base}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_token: request.sessionToken,
        npc_id: request.npcId,
        lang: request.lang,
        state: request.state,
        history: request.history,
        input: request.input,
      }),
      signal: handlers.signal,
    });
  } catch (error) {
    handlers.onFrame({ type: "error", code: "unreachable", detail: String(error).slice(0, 200) });
    return;
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detail = isRecord(body) ? body["detail"] : undefined;
    const code = isRecord(detail) && typeof detail["code"] === "string" ? detail["code"] : undefined;
    handlers.onFrame({ type: "error", code: code ?? `http_${response.status}` });
    return;
  }

  const body = response.body;
  if (!body) {
    handlers.onFrame({ type: "error", code: "no_stream" });
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatch = (frames: string[]) => {
    for (const raw of frames) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue; // a malformed frame is not worth killing the turn over
      }
      if (isRecord(parsed) && typeof parsed["type"] === "string") {
        handlers.onFrame(parsed as unknown as ChatFrame);
      }
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;

    // `stream: true` keeps a multi-byte character whole across a chunk boundary.
    buffer += decoder.decode(value, { stream: true });
    const { frames, rest } = parseFrames(buffer);
    buffer = rest;
    dispatch(frames);
  }

  // Flush the decoder and any final frame that arrived without its blank-line terminator.
  const tail = parseFrames(`${buffer}${decoder.decode()}\n\n`);
  dispatch(tail.frames);
}
