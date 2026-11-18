import { describe, expect, test } from "bun:test";

import type { ConditionState } from "@hkstories/core";

import { openSession, parseFrames, streamTurn, type ChatFrame } from "./net";

/**
 * The chat transport.
 *
 * Two of these tests exist because the failure they prevent is invisible until it happens in
 * Cantonese: a frame split across two reads, and a three-byte character split across two reads. The
 * boundary test sweeps every split offset rather than trusting one hand-picked position.
 */

const STATE: ConditionState = { flags: {}, vars: {}, inventory: {}, talk_counts: {}, quests: {} };

function streamOf(chunks: Uint8Array[], init: ResponseInit = { status: 200 }): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    init,
  );
}

const fetchReturning =
  (response: Response) =>
  (async () => response) as unknown as typeof fetch;

const jsonFetch =
  (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

const REQUEST = {
  sessionToken: "tok",
  npcId: "npc_ken",
  lang: "zh_HK",
  state: STATE,
  history: [],
  input: "你好",
};

async function collect(response: Response): Promise<ChatFrame[]> {
  const events: ChatFrame[] = [];
  await streamTurn(REQUEST, { onFrame: (event) => events.push(event) }, {
    fetchImpl: fetchReturning(response),
    baseUrl: "",
  });
  return events;
}

describe("parseFrames", () => {
  test("emits complete frames and keeps the partial tail", () => {
    const parsed = parseFrames('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"');
    expect(parsed.frames).toEqual(['{"a":1}', '{"b":2}']);
    expect(parsed.rest).toBe('data: {"c"');
  });

  test("tolerates a missing space after the colon and ignores other fields", () => {
    const parsed = parseFrames('event: ping\ndata:{"a":1}\n\n');
    expect(parsed.frames).toEqual(['{"a":1}']);
    expect(parsed.rest).toBe("");
  });

  test("an empty buffer yields nothing", () => {
    expect(parseFrames("")).toEqual({ frames: [], rest: "" });
  });
});

describe("openSession", () => {
  test("returns the session", async () => {
    const result = await openSession({
      fetchImpl: jsonFetch({ session_token: "abc", budget: 60000, remaining: 60000, model: "m", output_mode: "json" }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.session.session_token).toBe("abc");
  });

  test("surfaces the refusal code the route sent", async () => {
    const result = await openSession({ fetchImpl: jsonFetch({ detail: { code: "daily_cap" } }, 429) });
    expect(result).toEqual({ ok: false, code: "daily_cap", status: 429 });
  });

  test("a plain detail string becomes an http code", async () => {
    const result = await openSession({ fetchImpl: jsonFetch({ detail: "the database is not ready" }, 503) });
    expect(result).toEqual({ ok: false, code: "http_503", status: 503 });
  });

  test("an unreachable API is reported, not thrown", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await openSession({ fetchImpl: failing })).toEqual({
      ok: false,
      code: "store_unreachable",
      status: 0,
    });
  });

  test("a 200 with the wrong shape is refused", async () => {
    const result = await openSession({ fetchImpl: jsonFetch({ nonsense: true }) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("bad_session_payload");
  });
});

describe("streamTurn", () => {
  const DONE = {
    type: "done",
    say: "根叔應你一句。",
    mood: "warm",
    actions: [],
    rejected: [],
    truncated: false,
    model: "m",
    usage: { tokens: 42, remaining: 990, turn: 1 },
  };

  test("reports tokens in order and then the done frame", async () => {
    const body =
      frame({ type: "token", t: "根" }) +
      frame({ type: "token", t: "叔" }) +
      frame(DONE);

    const events = await collect(streamOf([new TextEncoder().encode(body)]));
    expect(events.map((event) => event.type)).toEqual(["token", "token", "done"]);
    expect(events[2]).toMatchObject({ usage: { remaining: 990 } });
  });

  test("a frame split across two reads still parses — at every offset", async () => {
    const body = frame({ type: "token", t: "根" }) + frame({ type: "token", t: "叔" }) + frame(DONE);
    const bytes = new TextEncoder().encode(body);

    for (let split = 1; split < bytes.length; split += 1) {
      const events = await collect(streamOf([bytes.slice(0, split), bytes.slice(split)]));
      if (events.length !== 3) throw new Error(`split at ${split} produced ${events.length} frames`);
    }
    expect(true).toBe(true);
  });

  test("a multi-byte character split across reads is not corrupted", async () => {
    const body = frame({ type: "token", t: "根叔，你好" }) + frame(DONE);
    const bytes = new TextEncoder().encode(body);

    // One byte into the first three-byte character: decoding each chunk alone would mangle it.
    const cut = new TextEncoder().encode('data: {"type":"token","t":"').length + 1;
    const events = await collect(streamOf([bytes.slice(0, cut), bytes.slice(cut)]));

    expect(events[0]).toEqual({ type: "token", t: "根叔，你好" });
  });

  test("a non-2xx answer becomes an error frame with the route's code", async () => {
    const response = new Response(JSON.stringify({ detail: { code: "unknown_session" } }), { status: 400 });
    const events = await collect(response);
    expect(events).toEqual([{ type: "error", code: "unknown_session" }]);
  });

  test("an unreachable API becomes an error frame", async () => {
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const events: ChatFrame[] = [];
    await streamTurn(REQUEST, { onFrame: (event) => events.push(event) }, { fetchImpl: failing, baseUrl: "" });
    expect(events[0]).toMatchObject({ type: "error", code: "unreachable" });
  });

  test("a malformed frame is skipped without losing the rest", async () => {
    const body = 'data: {not json}\n\n' + frame(DONE);
    const events = await collect(streamOf([new TextEncoder().encode(body)]));
    expect(events.map((event) => event.type)).toEqual(["done"]);
  });
});
