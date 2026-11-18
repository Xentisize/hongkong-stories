import { describe, expect, test } from "bun:test";
import { deflateSync, inflateSync } from "node:zlib";

import {
  MAX_SAVE_BYTES,
  SAVE_SCHEMA_VERSION,
  decodeSave,
  emptySave,
  encodeSave,
  toConditionState,
  type SavePayload,
} from "./save";

/**
 * Save-code interoperability.
 *
 * The format belongs to `save.gd`, so the two decisive tests use Node's zlib rather than this
 * module's own codec: one builds a code the way Godot does and decodes it here, the other encodes
 * here and parses it with an independent inflater. A round-trip through only my own encoder would
 * pass while being incompatible with the client that already shipped.
 */

function godotEncode(payload: unknown): string {
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  const packed = deflateSync(raw);

  const sized = new Uint8Array(4 + packed.length);
  new DataView(sized.buffer).setUint32(0, raw.length, true); // encode_u32, little-endian
  sized.set(packed, 4);

  return Buffer.from(sized).toString("base64"); // Marshalls.raw_to_base64
}

function godotDecode(code: string): { declaredSize: number; payload: unknown } {
  const sized = Buffer.from(code, "base64");
  const declaredSize = sized.readUInt32LE(0);
  const raw = inflateSync(sized.subarray(4));
  return { declaredSize, payload: JSON.parse(new TextDecoder().decode(raw)) };
}

const PAYLOAD: SavePayload = {
  schema_version: SAVE_SCHEMA_VERSION,
  content_version: 7,
  flags: { door_open: true, met_ken: true },
  vars: { trust: 3 },
  inventory: { item_key: 1, item_album: 1 },
  held_item: "item_key",
  quests: { ch01: { node: "n3", done: false } },
  talk_counts: { npc_ch01_ken: 4 },
  visited: { loc_ssp_market_street: true },
  npc_memory: { npc_ch01_ken: ["一九五八年"] },
  time_of_day: "dusk",
  current_location: "loc_ssp_market_street",
  player_position: [312.5, 244.25],
  playtime_sec: 1234.5,
};

describe("reading a code written the way Godot writes it", () => {
  test("decodes a payload this module never encoded", async () => {
    const result = await decodeSave(godotEncode(PAYLOAD));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Cantonese and floats both have to survive: the JSON is UTF-8 in the compressed body.
    expect(result.save.npc_memory["npc_ch01_ken"]).toEqual(["一九五八年"]);
    expect(result.save.player_position).toEqual([312.5, 244.25]);
    expect(result.save.held_item).toBe("item_key");
    expect(result.save).toMatchObject({ content_version: 7, time_of_day: "dusk", playtime_sec: 1234.5 });
  });

  test("tolerates a code that came back through a chat app", async () => {
    const code = godotEncode(PAYLOAD);
    const wrapped = `${code.slice(0, 40)}\n  ${code.slice(40)}  `;
    const result = await decodeSave(wrapped);
    expect(result.ok).toBe(true);
  });
});

describe("writing a code Godot can read", () => {
  test("uses the little-endian length prefix and a zlib body", async () => {
    const code = await encodeSave(PAYLOAD);
    const { declaredSize, payload } = godotDecode(code);

    const utf8Length = new TextEncoder().encode(JSON.stringify(PAYLOAD)).length;
    expect(declaredSize).toBe(utf8Length);
    expect(payload).toEqual(PAYLOAD);
  });

  test("round-trips through this module", async () => {
    const result = await decodeSave(await encodeSave(PAYLOAD));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.save).toEqual(PAYLOAD);
  });
});

describe("mangled codes", () => {
  test("refuses what is not base64", async () => {
    expect(await decodeSave("not a code!!!")).toMatchObject({ ok: false });
  });

  test("refuses a code too short to carry a length", async () => {
    const result = await decodeSave(Buffer.from([1, 2]).toString("base64"));
    expect(result).toMatchObject({ ok: false, reason: "too short to carry a length prefix" });
  });

  test("refuses a zero or implausible declared length before inflating anything", async () => {
    const zero = Buffer.alloc(8);
    expect(await decodeSave(zero.toString("base64"))).toMatchObject({ ok: false });

    const huge = Buffer.alloc(8);
    huge.writeUInt32LE(MAX_SAVE_BYTES + 1, 0);
    expect(await decodeSave(huge.toString("base64"))).toMatchObject({
      ok: false,
      reason: "declared length is implausible",
    });
  });

  test("refuses a body that is not a zlib stream", async () => {
    const sized = new Uint8Array([10, 0, 0, 0, 1, 2, 3, 4, 5, 6]);
    const result = await decodeSave(Buffer.from(sized).toString("base64"));
    expect(result).toMatchObject({ ok: false });
  });

  test("refuses a body shorter than the prefix promises", async () => {
    // A code truncated in transit: the prefix still claims the full payload.
    const code = await encodeSave(PAYLOAD);
    const sized = Buffer.from(code, "base64");
    const honest = Buffer.concat([sized.subarray(0, 4), inflateSync(sized.subarray(4))]);
    honest.writeUInt32LE(honest.length + 100, 0); // prefix now lies
    const packed = deflateSync(honest.subarray(4));
    const lying = Buffer.concat([honest.subarray(0, 4), packed]);

    const result = await decodeSave(lying.toString("base64"));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("the prefix declared");
  });

  test("refuses a payload that is not a JSON object", async () => {
    const array = godotEncode([1, 2, 3]);
    expect(await decodeSave(array)).toMatchObject({ ok: false, reason: "the payload is not an object" });

    const sized = new Uint8Array(4 + deflateSync(Buffer.from("not json")).length);
    new DataView(sized.buffer).setUint32(0, 8, true);
    sized.set(deflateSync(Buffer.from("not json")), 4);
    expect(await decodeSave(Buffer.from(sized).toString("base64"))).toMatchObject({ ok: false });
  });

  test("refuses a save schema from the future", async () => {
    const result = await decodeSave(godotEncode({ ...PAYLOAD, schema_version: SAVE_SCHEMA_VERSION + 1 }));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("newer than this build");
  });
});

describe("from_dict parity", () => {
  test("fills the defaults for a payload that predates fields", async () => {
    const result = await decodeSave(godotEncode({ schema_version: 1 }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.save).toMatchObject({
      flags: {},
      inventory: {},
      held_item: "",
      quests: {},
      time_of_day: "day",
      current_location: "",
      player_position: [0, 0],
      playtime_sec: 0,
    });
  });

  test("drops a held item the inventory does not contain", async () => {
    const lost = await decodeSave(godotEncode({ ...PAYLOAD, inventory: {}, held_item: "item_key" }));
    expect(lost.ok).toBe(true);
    if (lost.ok) expect(lost.save.held_item).toBe("");

    const held = await decodeSave(godotEncode({ ...PAYLOAD, inventory: { item_key: 1 }, held_item: "item_key" }));
    expect(held.ok).toBe(true);
    if (held.ok) expect(held.save.held_item).toBe("item_key");
  });

  test("survives a non-array player position", async () => {
    const result = await decodeSave(godotEncode({ ...PAYLOAD, player_position: "somewhere" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.save.player_position).toEqual([0, 0]);
  });
});

describe("the condition projection", () => {
  test("carries exactly what conditions read", () => {
    const state = toConditionState(PAYLOAD);
    expect(Object.keys(state).sort()).toEqual([
      "flags",
      "held_item",
      "inventory",
      "quests",
      "talk_counts",
      "time_of_day",
      "vars",
      "visited",
    ]);
    expect(state.vars).toEqual({ trust: 3 });
  });

  test("an empty save is a usable origin", async () => {
    const result = await decodeSave(await encodeSave(emptySave()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(toConditionState(result.save).flags).toEqual({});
  });
});
