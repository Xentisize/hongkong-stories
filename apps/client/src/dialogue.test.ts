import { describe, expect, test } from "bun:test";

import type { ConditionState } from "@hkstories/core";

import type { NpcFile } from "./content";
import { HISTORY_LIMIT, Dialogue, fallbackLine, isRecoverable } from "./dialogue";
import type { ChatFrame, StreamTurnRequest } from "./net";

/**
 * The conversation state machine.
 *
 * The transport is injected, so these cases are about policy rather than plumbing: when a turn is
 * committed, what rides along as history, when the client refuses to spend budget, and which
 * failures earn an authored line instead of an error.
 */

const STATE: ConditionState = { flags: {}, vars: {}, inventory: {}, talk_counts: {}, quests: {} };

const NPC: NpcFile = {
  id: "npc_ken",
  display_name: { zh_HK: "根叔", zh_CN: "根叔", en: "Uncle Ken" },
  scripted_fallback: {
    greeting: { zh_HK: "啊？大聲啲啦後生仔。", zh_CN: "啊？大声点。", en: "Eh? Speak up." },
    lines: [{ zh_HK: "第一句。", zh_CN: "第一句。", en: "First line." }],
  },
};

type Emit = (frame: ChatFrame) => void;

/** A transport whose behaviour each test scripts, recording the requests it was given. */
function scripted(steps: (request: StreamTurnRequest, emit: Emit) => Promise<void> | void) {
  const calls: StreamTurnRequest[] = [];
  const send = (async (request: StreamTurnRequest, handlers: { onFrame: Emit }) => {
    calls.push(request);
    await steps(request, handlers.onFrame);
  }) as unknown as typeof import("./net").streamTurn;
  return { send, calls };
}

const done = (say: string, remaining = 990): ChatFrame => ({
  type: "done",
  say,
  mood: "warm",
  actions: [],
  rejected: [],
  truncated: false,
  model: "m",
  usage: { tokens: 10, remaining, turn: 1 },
});

function makeDialogue() {
  const views: number[] = [];
  const { send, calls } = scripted(async (_request, emit) => {
    emit({ type: "token", t: "根" });
    emit({ type: "token", t: "叔" });
    emit(done("根叔應你一句。"));
  });

  const dialogue = new Dialogue({
    npc: NPC,
    lang: "zh_HK",
    getState: () => STATE,
    sessionToken: "tok",
    remaining: 1000,
    send,
    onChange: () => views.push(1),
  });

  return { dialogue, calls, views };
}

describe("a completed turn", () => {
  test("streams tokens, then commits the model's line", async () => {
    const { dialogue } = makeDialogue();
    await dialogue.say("你好");

    const view = dialogue.view;
    expect(view.turns).toEqual([
      { role: "user", text: "你好" },
      { role: "npc", text: "根叔應你一句。" },
    ]);
    expect(view.typing).toBe("");
    expect(view.busy).toBe(false);
    expect(view.error).toBeNull();
  });

  test("takes the remaining budget from the done frame, not from a guess", async () => {
    const { send } = scripted(async (_request, emit) => emit(done("好。", 4242)));
    const dialogue = new Dialogue({
      npc: NPC,
      lang: "zh_HK",
      getState: () => STATE,
      sessionToken: "tok",
      remaining: 5000,
      send,
    });

    await dialogue.say("喂");
    expect(dialogue.view.remaining).toBe(4242);
  });

  test("emits a view on every change, so a UI can be dumb", async () => {
    const { dialogue, views } = makeDialogue();
    await dialogue.say("你好");
    // One on submit, one per token, one on commit.
    expect(views.length).toBeGreaterThanOrEqual(4);
  });
});

describe("history", () => {
  test("is taken before the new line joins it", async () => {
    const { dialogue, calls } = makeDialogue();
    await dialogue.say("第一句");
    await dialogue.say("第二句");

    // The second request must not carry the player's new message twice.
    expect(calls[1]!.history).toEqual([
      { role: "user", content: "第一句" },
      { role: "assistant", content: "根叔應你一句。" },
    ]);
    expect(calls[1]!.input).toBe("第二句");
  });

  test("is capped, and maps the NPC side to the assistant role", async () => {
    const { dialogue, calls } = makeDialogue();
    for (let index = 0; index < HISTORY_LIMIT; index += 1) await dialogue.say(`第${index}句`);

    const history = calls.at(-1)!.history;
    expect(history.length).toBe(HISTORY_LIMIT);
    expect(history.every((entry, at) => entry.role === (at % 2 === 0 ? "user" : "assistant"))).toBe(true);
  });
});

describe("refusals", () => {
  test("an empty line is not a turn", async () => {
    const { dialogue, calls } = makeDialogue();
    await dialogue.say("   ");
    expect(calls).toHaveLength(0);
    expect(dialogue.view.turns).toEqual([]);
  });

  test("a spent budget refuses without calling the API", async () => {
    const { send, calls } = scripted(async (_request, emit) => emit(done("好。")));
    const dialogue = new Dialogue({
      npc: NPC,
      lang: "zh_HK",
      getState: () => STATE,
      sessionToken: "tok",
      remaining: 0,
      send,
    });

    await dialogue.say("喂");
    expect(calls).toHaveLength(0);
    expect(dialogue.view.error).toBe("budget_exhausted");
    expect(dialogue.view.turns).toEqual([]);
  });

  test("a second line while streaming is ignored", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const { send, calls } = scripted(async (_request, emit) => {
      await gate;
      emit(done("好。"));
    });
    const dialogue = new Dialogue({
      npc: NPC,
      lang: "zh_HK",
      getState: () => STATE,
      sessionToken: "tok",
      remaining: 1000,
      send,
    });

    const first = dialogue.say("一");
    await dialogue.say("二"); // busy: dropped
    release();
    await first;

    expect(calls).toHaveLength(1);
    expect(dialogue.view.turns.filter((turn) => turn.role === "user")).toHaveLength(1);
  });
});

describe("failures", () => {
  test("an expired session is reported for the caller to re-open, with no authored line", async () => {
    const { send } = scripted(async (_request, emit) => emit({ type: "error", code: "unknown_session" }));
    const dialogue = new Dialogue({
      npc: NPC,
      lang: "zh_HK",
      getState: () => STATE,
      sessionToken: "tok",
      remaining: 1000,
      send,
    });

    await dialogue.say("喂");
    expect(dialogue.view.error).toBe("session_expired");
    expect(dialogue.view.turns.some((turn) => turn.role === "npc")).toBe(false);
  });

  test("an unreachable backend shows the authored greeting instead", async () => {
    const { send } = scripted(async (_request, emit) => emit({ type: "error", code: "unreachable" }));
    const dialogue = new Dialogue({
      npc: NPC,
      lang: "zh_HK",
      getState: () => STATE,
      sessionToken: "tok",
      remaining: 1000,
      send,
    });

    await dialogue.say("喂");
    expect(dialogue.view.error).toBe("unreachable");
    expect(dialogue.view.turns.at(-1)).toEqual({
      role: "npc",
      text: "啊？大聲啲啦後生仔。",
      fallback: true,
    });
  });

  test("a stream that closes without done is a truncated turn, not a completed one", async () => {
    const { send } = scripted(async (_request, emit) => {
      emit({ type: "token", t: "根" }); // and then the stream simply ends
    });
    const dialogue = new Dialogue({
      npc: NPC,
      lang: "zh_HK",
      getState: () => STATE,
      sessionToken: "tok",
      remaining: 1000,
      send,
    });

    await dialogue.say("喂");
    expect(dialogue.view.error).toBe("stream_closed");
    expect(dialogue.view.busy).toBe(false);
    expect(dialogue.view.typing).toBe("");
    expect(dialogue.view.turns.at(-1)?.fallback).toBe(true);
  });

  test("a line typed while offline stays in the transcript", () => {
    const { dialogue, calls } = makeDialogue();
    dialogue.offlineTurn("根叔，你間舖幾時開㗎？", "store_unreachable");

    // No request was possible, but the player's words must not disappear.
    expect(calls).toHaveLength(0);
    expect(dialogue.view.turns[0]).toEqual({ role: "user", text: "根叔，你間舖幾時開㗎？" });
    expect(dialogue.view.turns.at(-1)?.fallback).toBe(true);
    expect(dialogue.view.error).toBe("store_unreachable");
  });

  test("closing the conversation drops frames still in flight", async () => {
    let late!: Emit;
    const { send } = scripted(async (_request, emit) => {
      late = emit; // hold the emitter so the frame arrives after close
    });
    const dialogue = new Dialogue({
      npc: NPC,
      lang: "zh_HK",
      getState: () => STATE,
      sessionToken: "tok",
      remaining: 1000,
      send,
    });

    const pending = dialogue.say("喂");
    dialogue.close();
    late(done("遲來的台詞。"));
    await pending;

    expect(dialogue.view.turns.some((turn) => turn.text === "遲來的台詞。")).toBe(false);
  });

  test("an authored fallback line never becomes model history", async () => {
    let call = 0;
    const { send, calls } = scripted(async (_request, emit) => {
      call += 1;
      if (call === 1) emit({ type: "error", code: "upstream_error" });
      else emit(done("好。"));
    });
    const dialogue = new Dialogue({
      npc: NPC,
      lang: "zh_HK",
      getState: () => STATE,
      sessionToken: "tok",
      remaining: 1000,
      send,
    });

    await dialogue.say("一");
    await dialogue.say("二");

    expect(calls[1]!.history).toEqual([{ role: "user", content: "一" }]);
  });
});

describe("the offline ladder", () => {
  test("walks the locale chain", () => {
    expect(fallbackLine(NPC, "zh_HK")).toBe("啊？大聲啲啦後生仔。");
    expect(fallbackLine(NPC, "en")).toBe("Eh? Speak up.");
    // A missing translation in the requested locale falls back down the chain rather than to "".
    expect(fallbackLine({ ...NPC, scripted_fallback: { greeting: { en: "Only English." } } }, "zh_HK")).toBe(
      "Only English.",
    );
  });

  test("falls through to the first authored line, then to nothing", () => {
    expect(
      fallbackLine({ ...NPC, scripted_fallback: { lines: NPC.scripted_fallback!.lines } }, "zh_HK"),
    ).toBe("第一句。");
    expect(fallbackLine({ ...NPC, scripted_fallback: {} }, "zh_HK")).toBe("");
    expect(fallbackLine({ ...NPC, scripted_fallback: undefined }, "zh_HK")).toBe("");
  });

  test("distinguishes a broken pipeline from a spent budget", () => {
    expect(isRecoverable("unreachable")).toBe(true);
    expect(isRecoverable("upstream_error")).toBe(true);
    expect(isRecoverable("http_502")).toBe(true);
    expect(isRecoverable("stream_closed")).toBe(true);
    // No session was ever created: the authored line is all the player can be shown.
    expect(isRecoverable("store_unreachable")).toBe(true);
    expect(isRecoverable("bad_session_payload")).toBe(true);
    expect(isRecoverable("budget_exceeded")).toBe(false);
    expect(isRecoverable("unknown_session")).toBe(false);
  });
});
