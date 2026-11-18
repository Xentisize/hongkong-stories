/**
 * The NPC reply contract (§7.3).
 *
 * The wire format is generated from the validator, so these tests guard both: what the model is
 * told to produce, and what we accept from it. They are the substitute for the flywheel the old
 * code had — a hand-written schema plus a hand-written parser plus a hand-written mid-stream
 * extractor, all of which could drift apart without any test noticing.
 *
 * Note: this pins *structure*, not model behaviour. Whether a given OpenRouter model actually
 * honours the strict schema still needs one live smoke turn before release.
 */

import { describe, expect, test } from "bun:test";

import { MAX_ACTIONS_PER_TURN } from "../src/actions";
import {
  ACTION_TYPES,
  MOODS,
  NpcReplySchema,
  npcReplyResponseFormat,
  parseNpcReply,
  parseNpcReplyJSON,
} from "../src/schema";

const validReply = {
  say: "個箱係我嘅。",
  mood: "wary",
  actions: [],
};

describe("a well-formed reply", () => {
  test("parses and keeps its type", () => {
    const result = parseNpcReply(validReply);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reply.say).toBe("個箱係我嘅。");
  });

  test("actions are optional in practice but the key must be present", () => {
    const missing = { say: "hi", mood: "warm" };
    expect(parseNpcReply(missing).ok).toBe(false);
  });

  test("accepts one action of each declared type", () => {
    for (const type of ACTION_TYPES) {
      const result = parseNpcReply({ ...validReply, actions: [{ type }] });
      expect({ type, ok: result.ok }).toEqual({ type, ok: true });
    }
  });
});

describe("mood", () => {
  test("every declared mood is accepted", () => {
    for (const mood of MOODS) {
      expect(parseNpcReply({ ...validReply, mood }).ok).toBe(true);
    }
  });

  test("an undeclared mood is rejected", () => {
    expect(parseNpcReply({ ...validReply, mood: "furious" }).ok).toBe(false);
  });

  test("a localized mood is rejected — the enum stays English in every locale (§7.7)", () => {
    expect(parseNpcReply({ ...validReply, mood: "溫暖" }).ok).toBe(false);
  });
});

describe("actions", () => {
  test("an undeclared action type is rejected", () => {
    expect(parseNpcReply({ ...validReply, actions: [{ type: "summon_dragon" }] }).ok).toBe(false);
  });

  test("an action without a type is rejected", () => {
    expect(parseNpcReply({ ...validReply, actions: [{ item: "item_k" }] }).ok).toBe(false);
  });

  test("more than the per-turn cap is rejected by the schema", () => {
    const tooMany = Array.from({ length: MAX_ACTIONS_PER_TURN + 1 }, () => ({ type: "give" }));
    expect(parseNpcReply({ ...validReply, actions: tooMany }).ok).toBe(false);
  });

  test("extra unknown fields are rejected, not silently dropped", () => {
    expect(
      parseNpcReply({ ...validReply, actions: [{ type: "give", treasure: "yes" }] }).ok,
    ).toBe(false);
  });

  test("a non-integer count is rejected", () => {
    expect(
      parseNpcReply({ ...validReply, actions: [{ type: "give", count: 1.5 }] }).ok,
    ).toBe(false);
  });
});

describe("strictness at the top level", () => {
  test("an unknown top-level field is rejected", () => {
    expect(parseNpcReply({ ...validReply, mood_extra: 1 }).ok).toBe(false);
  });

  test("say must be a string", () => {
    expect(parseNpcReply({ ...validReply, say: 42 }).ok).toBe(false);
  });

  test("null and garbage are rejected without throwing", () => {
    expect(parseNpcReply(null).ok).toBe(false);
    expect(parseNpcReply("not an object").ok).toBe(false);
    expect(parseNpcReply([]).ok).toBe(false);
  });

  test("the error names the offending path", () => {
    const result = parseNpcReply({ say: "x", mood: "warm", actions: [{ type: "nope" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("actions");
  });
});

describe("raw JSON parsing", () => {
  test("malformed JSON is a transport error, not a crash", () => {
    const result = parseNpcReplyJSON('{"say": "hi"');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("malformed JSON");
  });

  test("valid JSON round-trips", () => {
    const result = parseNpcReplyJSON(JSON.stringify(validReply));
    expect(result.ok).toBe(true);
  });

  test("a CJK reply survives the round trip unescaped", () => {
    const raw = '{"say":"你食咗飯未呀？","mood":"warm","actions":[]}';
    const result = parseNpcReplyJSON(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reply.say).toBe("你食咗飯未呀？");
  });
});

describe("the generated response_format", () => {
  const format = npcReplyResponseFormat() as {
    type: string;
    json_schema: { name: string; strict: boolean; schema: Record<string, unknown> };
  };
  const schema = format.json_schema.schema;

  test("it is a strict named json_schema", () => {
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.name).toBe("npc_reply");
    expect(format.json_schema.strict).toBe(true);
  });

  test("the object is closed and every property is required", () => {
    expect(schema["additionalProperties"]).toBe(false);
    expect(schema["required"]).toEqual(["say", "mood", "actions"]);
  });

  test("the enums match the zod enums exactly", () => {
    const properties = schema["properties"] as Record<string, Record<string, unknown>>;
    expect(properties["mood"]!["enum"]).toEqual([...MOODS]);

    const actions = properties["actions"] as Record<string, unknown>;
    expect(actions["maxItems"]).toBe(MAX_ACTIONS_PER_TURN);

    const items = (actions["items"] as Record<string, unknown>)["properties"] as Record<
      string,
      Record<string, unknown>
    >;
    expect(items["type"]!["enum"]).toEqual([...ACTION_TYPES]);
  });

  test("no $schema key is sent", () => {
    expect(schema["$schema"]).toBeUndefined();
  });

  test("no numeric bounds are sent — strict mode rejects them", () => {
    const serialized = JSON.stringify(schema);
    expect(serialized).not.toContain("minimum");
    expect(serialized).not.toContain("maximum");
  });

  test("what we advertise is what we enforce", () => {
    // Every action type in the wire enum must validate locally, and vice versa.
    for (const type of ACTION_TYPES) {
      expect(NpcReplySchema.safeParse({ ...validReply, actions: [{ type }] }).success).toBe(true);
    }
  });
});
