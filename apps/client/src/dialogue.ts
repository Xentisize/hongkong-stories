import { localize, type ConditionState, type Locale } from "@hkstories/core";

import type { NpcFile } from "./content";
import { streamTurn, type ChatFrame, type StreamTurnRequest } from "./net";

/**
 * One conversation with one NPC.
 *
 * The turn lifecycle is the part of the client worth testing without a browser: what a streamed
 * token does, what a completed turn costs, what an unreachable backend falls back to, and when the
 * client must refuse to spend budget at all.
 *
 * There is no artificial typewriter queue here. Tokens arrive over a network, so the visible cadence
 * *is* the stream; adding a reveal timer on top would only add latency to text that is already
 * arriving progressively. The authored fallback line is different — it arrives whole — so the UI
 * reveals it itself if it wants that effect.
 */

export interface DialogueTurn {
  role: "user" | "npc";
  text: string;
  /** True for an authored line shown because the API could not answer. */
  fallback?: boolean;
}

export interface DialogueView {
  turns: DialogueTurn[];
  /** The NPC line being streamed, before it is committed as a turn. */
  typing: string;
  remaining: number;
  busy: boolean;
  /** A code, not a sentence: the UI owns the wording and the locale. */
  error: string | null;
}

/** How many prior lines ride along as history on the next request. */
export const HISTORY_LIMIT = 8;

/** The authored line for an unreachable backend, through the locale chain. */
export function fallbackLine(npc: NpcFile, lang: Locale): string {
  const ladder = npc.scripted_fallback;
  const greeting = ladder?.greeting ? localize(ladder.greeting, lang) : "";
  if (greeting) return greeting;

  const first = ladder?.lines?.[0];
  return first ? localize(first, lang) : "";
}

/**
 * Codes that mean "the pipeline could not answer", as opposed to "this session is gone".
 *
 * Only the first kind shows an authored line: a missing session is worth retrying, and a spent
 * budget is a hard stop — putting words in the character's mouth for either would misrepresent why
 * the turn did not happen.
 */
const RECOVERABLE = new Set([
  "unreachable",
  "no_stream",
  "upstream_error",
  "bad_output",
  "empty_response",
  "no_api_key",
  "session_store_unavailable",
  // The stream closed before `done`: the turn is truncated, which is the same story as a 502.
  "stream_closed",
  // Codes `openSession` produces when there was never a turn to attempt at all.
  "store_unreachable",
  "bad_session_payload",
]);

export function isRecoverable(code: string): boolean {
  return RECOVERABLE.has(code) || code.startsWith("http_5");
}

export interface DialogueOptions {
  npc: NpcFile;
  lang: Locale;
  /** Read lazily: the game state moves while a conversation is open. */
  getState: () => ConditionState;
  sessionToken: string;
  remaining: number;
  /** Injected so the turn logic is testable without a provider. */
  send?: typeof streamTurn;
  onChange?: (view: DialogueView) => void;
  historyLimit?: number;
}

export class Dialogue {
  private turns: DialogueTurn[] = [];
  private typing = "";
  private remaining: number;
  private busy = false;
  private error: string | null = null;
  private closed = false;
  private controller: AbortController | null = null;

  private readonly send: typeof streamTurn;
  private readonly historyLimit: number;

  constructor(private readonly options: DialogueOptions) {
    this.remaining = options.remaining;
    this.send = options.send ?? streamTurn;
    this.historyLimit = options.historyLimit ?? HISTORY_LIMIT;
  }

  get view(): DialogueView {
    return {
      turns: [...this.turns],
      typing: this.typing,
      remaining: this.remaining,
      busy: this.busy,
      error: this.error,
    };
  }

  setSession(sessionToken: string, remaining: number): void {
    this.options.sessionToken = sessionToken;
    this.remaining = remaining;
    this.error = null;
    this.emit();
  }

  /**
   * Abandon the conversation.
   *
   * The stream is aborted and any frame still in flight is dropped: a `done` arriving after the
   * panel closed must not append a line to a conversation nobody can see.
   */
  close(): void {
    this.closed = true;
    this.controller?.abort();
    this.controller = null;
  }

  /** Show the authored line without attempting a request — no session could be opened at all. */
  offline(code = "unreachable"): void {
    if (this.closed) return;
    this.fail(code);
  }

  /**
   * A line the player typed when no request could even be sent.
   *
   * The line still joins the transcript: a conversation panel that silently swallows what the
   * player typed reads as a broken input box, not as a backend that is down.
   */
  offlineTurn(input: string, code = "unreachable"): void {
    if (this.closed || this.busy) return;

    const text = input.trim();
    if (text !== "") this.turns.push({ role: "user", text });
    this.fail(code);
  }

  async say(input: string): Promise<void> {
    const text = input.trim();
    if (text === "" || this.busy) return;

    if (this.remaining <= 0) {
      this.error = "budget_exhausted";
      this.emit();
      return;
    }

    // History is taken before the new line joins it, or the request would carry the player's
    // message twice: once as context, once as `input`.
    const history = this.history();

    this.turns.push({ role: "user", text });
    this.busy = true;
    this.error = null;
    this.typing = "";
    this.emit();

    let settled = false;

    const request: StreamTurnRequest = {
      sessionToken: this.options.sessionToken,
      npcId: this.options.npc.id,
      lang: this.options.lang,
      state: this.options.getState(),
      history,
      input: text,
    };

    const controller = new AbortController();
    this.controller = controller;

    try {
      await this.send(request, {
        signal: controller.signal,
        onFrame: (frame) => {
          if (settled || this.closed) return;

          if (frame.type === "token") {
            this.typing += frame.t;
            this.emit();
            return;
          }

          settled = true;
          if (frame.type === "done") {
            this.turns.push({ role: "npc", text: frame.say });
            this.typing = "";
            this.remaining = frame.usage.remaining;
            this.busy = false;
            this.emit();
            return;
          }

          this.fail(frame.code);
        },
      });
    } catch {
      if (!settled && !this.closed) {
        settled = true;
        this.fail("unreachable");
      }
    }

    this.controller = null;

    // A stream that closes without `done` is a truncated turn, not a completed one.
    if (!settled && !this.closed) {
      settled = true;
      this.fail("stream_closed");
    }
  }

  private fail(code: string): void {
    this.busy = false;
    this.typing = "";
    this.error = code === "unknown_session" ? "session_expired" : code;

    if (isRecoverable(code)) {
      const line = fallbackLine(this.options.npc, this.options.lang);
      // An empty authored line means the content has no ladder; the error alone is the honest answer.
      if (line !== "") this.turns.push({ role: "npc", text: line, fallback: true });
    }

    this.emit();
  }

  private history(): Array<{ role: string; content: string }> {
    return this.turns
      // Authored fallback lines were never the model's output; feeding them back would teach it a
      // voice it did not write.
      .filter((turn) => turn.fallback !== true)
      .slice(-this.historyLimit)
      .map((turn) => ({ role: turn.role === "npc" ? "assistant" : "user", content: turn.text }));
  }

  private emit(): void {
    this.options.onChange?.(this.view);
  }
}

/** A single frame applied to a view — used by tests and by any UI that keeps its own copy. */
export function isDone(frame: ChatFrame): frame is Extract<ChatFrame, { type: "done" }> {
  return frame.type === "done";
}
