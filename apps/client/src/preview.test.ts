import { describe, expect, test } from "bun:test";

import {
  commandMessage,
  eventMessage,
  fetchPreviewPack,
  isPreviewCommand,
  isPreviewEvent,
  readPreviewOptions,
} from "./preview";

/**
 * The preview bridge, minus the engine.
 *
 * The cases that matter: an ordinary player build must not be treated as a preview (it would ask
 * for a token it does not have), a failed fetch must throw rather than fall back to published
 * content, and the message channel must be checked so a random `postMessage` cannot drive the game.
 */

describe("readPreviewOptions", () => {
  test("an ordinary player build is not a preview", () => {
    expect(readPreviewOptions("")).toEqual({ preview: false, token: "" });
    expect(readPreviewOptions("?foo=1&token=abc")).toEqual({ preview: false, token: "" });
  });

  test("the studio's embed flags a preview and carries the token", () => {
    expect(readPreviewOptions("?preview=1&token=abc")).toEqual({ preview: true, token: "abc" });
    expect(readPreviewOptions("?preview=true&token=%20abc%20").token).toBe("abc");
  });
});

describe("fetchPreviewPack", () => {
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  test("asks the admin preview route with the bearer token", async () => {
    const calls: Array<{ url: string; auth: string | null; cache: string | undefined }> = [];
    const pack = await fetchPreviewPack({
      token: "abc",
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), auth: new Headers(init.headers).get("authorization"), cache: init.cache });
        return ok({ tables: { locations: { loc_a: { id: "loc_a" } } }, issues: [] });
      }) as unknown as typeof fetch,
    });

    expect(calls[0]).toEqual({ url: "/v1/admin/preview/pack", auth: "Bearer abc", cache: "no-store" });
    expect(pack.tables.locations).toEqual({ loc_a: { id: "loc_a" } });
  });

  test("a refusal throws instead of pretending the published pack is the draft", async () => {
    await expect(
      fetchPreviewPack({
        token: "",
        fetchImpl: (async () => new Response("no", { status: 401 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("401");
  });

  test("a body without tables reads as an empty pack rather than undefined", async () => {
    const pack = await fetchPreviewPack({
      token: "abc",
      fetchImpl: (async () => ok({})) as unknown as typeof fetch,
    });
    expect(pack).toEqual({ tables: {}, issues: [] });
  });
});

describe("the message protocol", () => {
  test("accepts what it stamps itself", () => {
    expect(isPreviewCommand(commandMessage({ type: "pause" }))).toBe(true);
    expect(isPreviewEvent(eventMessage({ type: "ready", location: "loc_a" }))).toBe(true);
  });

  test("rejects a message from another channel or an unknown verb", () => {
    expect(isPreviewCommand({ type: "pause" })).toBe(false);
    expect(isPreviewCommand({ channel: "hkstories-preview", type: "explode" })).toBe(false);
    expect(isPreviewEvent({ channel: "elsewhere", type: "ready" })).toBe(false);
    expect(isPreviewCommand("pause")).toBe(false);
    expect(isPreviewEvent(null)).toBe(false);
  });

  test("a selection round-trips with its payload intact", () => {
    const message = eventMessage({ type: "selected", tile: [3, 4], entityType: "npc", entityId: "npc_a" });
    expect(isPreviewEvent(message)).toBe(true);
    if (isPreviewEvent(message) && message.type === "selected") {
      expect(message.tile).toEqual([3, 4]);
      expect(message.entityId).toBe("npc_a");
    }
  });
});
