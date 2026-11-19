import { describe, expect, test } from "bun:test";

import { attachPreviewBridge, type BridgeSource } from "./preview-bridge";
import { commandMessage, isPreviewEvent } from "./preview";

/**
 * The in-game half of the bridge.
 *
 * What matters: the studio learns the game is ready, a click lands as a selection carrying the tile
 * and whoever stands there, a command is honoured only from the right channel, and disposing really
 * detaches (a leaked listener would fire into a dead iframe).
 */

function harness(overrides: Partial<BridgeSource> = {}) {
  const posted: unknown[] = [];
  const target = new EventTarget();
  const source: BridgeSource = {
    canvas: () => target,
    toTile: (x) => (x < 0 ? null : [x, 2]),
    // Forwarded drags arrive as the frame's own pixels; round them so assertions stay exact.
    toLocalTile: (x, y) => (x < 0 ? null : [Math.round(x / 10), Math.round(y / 10)]),
    entityAt: (tile) => (tile[0] === 3 ? { type: "npc", id: "npc_chan" } : null),
    location: () => "loc_ssp",
    post: (message) => posted.push(message),
    ...overrides,
  };
  return { source, posted, target };
}

function click(target: EventTarget, clientX: number, clientY = 10) {
  const event = new Event("pointerdown");
  Object.assign(event, { clientX, clientY });
  target.dispatchEvent(event);
}

function command(message: unknown) {
  const event = new MessageEvent("message", { data: message });
  globalThis.dispatchEvent(event);
}

describe("attachPreviewBridge", () => {
  test("announces readiness with the running scene", () => {
    const { source, posted } = harness();
    const stop = attachPreviewBridge(source);
    const first = posted[0];
    expect(isPreviewEvent(first)).toBe(true);
    expect(first).toMatchObject({ type: "ready", location: "loc_ssp" });
    stop();
  });

  test("a click becomes a selection with the tile and what stands there", () => {
    const { source, posted, target } = harness();
    const stop = attachPreviewBridge(source);
    posted.length = 0;

    click(target, 3);
    expect(posted[0]).toMatchObject({ type: "selected", tile: [3, 2], entityType: "npc", entityId: "npc_chan" });

    click(target, 5);
    expect(posted[1]).toMatchObject({ type: "selected", tile: [5, 2], entityType: null, entityId: null });
    stop();
  });

  test("a click outside the map reports nothing", () => {
    const { source, posted, target } = harness();
    const stop = attachPreviewBridge(source);
    posted.length = 0;
    click(target, -1);
    expect(posted).toHaveLength(0);
    stop();
  });

  test("commands from the studio are honoured, foreign channels ignored", () => {
    const calls: string[] = [];
    const { source } = harness({
      onPause: () => calls.push("pause"),
      onResume: () => calls.push("resume"),
      onGoto: (id, spawn) => calls.push(`goto:${id}:${spawn ?? ""}`),
    });
    const stop = attachPreviewBridge(source);

    command(commandMessage({ type: "pause" }));
    command(commandMessage({ type: "resume" }));
    command(commandMessage({ type: "goto", location: "loc_kln", spawn: "door" }));
    command({ channel: "elsewhere", type: "pause" });
    command({ type: "pause" });

    expect(calls).toEqual(["pause", "resume", "goto:loc_kln:door"]);
    stop();
  });

  test("disposing detaches both listeners", () => {
    const calls: string[] = [];
    const { source, posted, target } = harness({ onPause: () => calls.push("pause") });
    const stop = attachPreviewBridge(source);
    stop();
    posted.length = 0;

    click(target, 3);
    command(commandMessage({ type: "pause" }));

    expect(posted).toHaveLength(0);
    expect(calls).toEqual([]);
  });
});

describe("placement mode", () => {
  test("a pick arms the game: the next click answers with a tile, not a selection", () => {
    const picked: Array<[number, number]> = [];
    const { source, posted, target } = harness({ onPick: (tile) => picked.push(tile) });
    const stop = attachPreviewBridge(source);
    posted.length = 0;

    command(commandMessage({ type: "pick", entity: "npc_chan" }));

    click(target, 2); // press does not select while armed
    expect(posted).toHaveLength(0);

    const up = new Event("pointerup");
    Object.assign(up, { clientX: 4, clientY: 9 });
    target.dispatchEvent(up);

    expect(picked).toEqual([[4, 2]]);
    expect(posted[0]).toMatchObject({ type: "picked", tile: [4, 2] });
    stop();
  });

  test("the mode disarms itself, so the following click selects again", () => {
    const { source, posted, target } = harness();
    const stop = attachPreviewBridge(source);
    command(commandMessage({ type: "pick" }));

    const up = new Event("pointerup");
    Object.assign(up, { clientX: 1, clientY: 1 });
    target.dispatchEvent(up);
    posted.length = 0;

    click(target, 3);
    expect(posted[0]).toMatchObject({ type: "selected", tile: [3, 2] });
    stop();
  });
});

describe("hovering while armed", () => {
  test("nothing is reported until placement is armed", () => {
    const { source, posted, target } = harness();
    const stop = attachPreviewBridge(source);
    posted.length = 0;

    const move = new Event("pointermove");
    Object.assign(move, { clientX: 4, clientY: 4 });
    target.dispatchEvent(move);
    expect(posted).toHaveLength(0);
    stop();
  });

  test("an armed pointer reports the tile it is over, once per cell", () => {
    const { source, posted, target } = harness();
    const stop = attachPreviewBridge(source);
    command(commandMessage({ type: "pick" }));
    posted.length = 0;

    const move = (x: number) => {
      const event = new Event("pointermove");
      Object.assign(event, { clientX: x, clientY: 7 });
      target.dispatchEvent(event);
    };

    move(4);
    move(4); // same cell: no second message
    move(5);

    expect(posted).toEqual([
      expect.objectContaining({ type: "hovered", tile: [4, 2] }),
      expect.objectContaining({ type: "hovered", tile: [5, 2] }),
    ]);
    stop();
  });

  test("disarming resets, so the same cell reports again next time", () => {
    const { source, posted, target } = harness();
    const stop = attachPreviewBridge(source);
    const move = (x: number) => {
      const event = new Event("pointermove");
      Object.assign(event, { clientX: x, clientY: 7 });
      target.dispatchEvent(event);
    };

    command(commandMessage({ type: "pick" }));
    move(4);
    const up = new Event("pointerup");
    Object.assign(up, { clientX: 4, clientY: 7 });
    target.dispatchEvent(up); // places, which disarms

    posted.length = 0;
    command(commandMessage({ type: "pick" }));
    move(4);
    expect(posted[0]).toMatchObject({ type: "hovered", tile: [4, 2] });
    stop();
  });
});

describe("a drag forwarded from the studio", () => {
  test("hovering reports the tile under the frame-local point, once per cell", () => {
    const { source, posted, target } = harness();
    const stop = attachPreviewBridge(source);
    posted.length = 0;

    command(commandMessage({ type: "hover", x: 42, y: 17 }));
    command(commandMessage({ type: "hover", x: 44, y: 19 })); // same cell
    command(commandMessage({ type: "hover", x: 91, y: 17 }));

    expect(posted).toEqual([
      expect.objectContaining({ type: "hovered", tile: [4, 2] }),
      expect.objectContaining({ type: "hovered", tile: [9, 2] }),
    ]);
    stop();
    void target;
  });

  test("releasing places at that point", () => {
    const picked: Array<[number, number]> = [];
    const { source, posted } = harness({ onPick: (tile) => picked.push(tile) });
    const stop = attachPreviewBridge(source);
    posted.length = 0;

    command(commandMessage({ type: "place", x: 64, y: 31 }));

    expect(picked).toEqual([[6, 3]]);
    expect(posted[0]).toMatchObject({ type: "picked", tile: [6, 3] });
    stop();
  });

  test("a point outside the map places nothing", () => {
    const picked: Array<[number, number]> = [];
    const { source, posted } = harness({ onPick: (tile) => picked.push(tile) });
    const stop = attachPreviewBridge(source);
    posted.length = 0;

    command(commandMessage({ type: "place", x: -5, y: 10 }));

    expect(picked).toEqual([]);
    expect(posted).toHaveLength(0);
    stop();
  });
});
