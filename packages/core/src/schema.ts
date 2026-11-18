/**
 * The NPC reply contract (§7.3).
 *
 * One zod schema is now three things at once:
 *   - the runtime validator for a model turn;
 *   - the TypeScript type every consumer gets for free;
 *   - the JSON Schema sent to OpenRouter as `response_format`.
 *
 * Before this, the same contract existed as a hand-written JSON Schema dict (`llm/schema.py`),
 * a Python `parse_output` that re-validated by hand, and a GDScript extractor that peeked at the
 * `say` field mid-stream. Divergence between those three was a live failure mode.
 *
 * `strict` + `additionalProperties: false` is what makes streaming JSON worth the trouble: the
 * model cannot wander into a shape the validator does not expect, so a malformed turn is a
 * transport failure we can fall back from rather than a silent state mutation.
 *
 * `mood` and action types are English enums in every locale — only `say` is localized, which
 * keeps the action validator locale-independent (§7.7).
 */

import { z } from "zod";

import { MAX_ACTIONS_PER_TURN } from "./actions";

/** Delivery tone, not content. */
export const MOODS = [
  "neutral",
  "warm",
  "gruff",
  "wistful",
  "amused",
  "wary",
  "sad",
] as const;

/** The action vocabulary a model may request. Permission is a separate, per-NPC matter. */
export const ACTION_TYPES = [
  "give",
  "take",
  "set_flag",
  "var",
  "reveal_secret",
  "open_shop",
] as const;

/**
 * One requested action. Deliberately loose: a `give` carries `item`, a `var` carries `name` and
 * `value`, and the schema does not model that discrimination because the *allowlist*, not the
 * schema, is what enforces per-NPC permission. A discriminated union here would reject a
 * well-formed `give` for omitting `var`'s fields.
 */
export const NpcActionSchema = z.strictObject({
  type: z.enum(ACTION_TYPES),
  item: z.string().optional(),
  flag: z.string().optional(),
  name: z.string().optional(),
  value: z.number().optional(),
  count: z.number().int().optional(),
  secret: z.string().optional(),
});

export const NpcReplySchema = z.strictObject({
  say: z.string(),
  mood: z.enum(MOODS),
  actions: z.array(NpcActionSchema).max(MAX_ACTIONS_PER_TURN),
});

export type NpcAction = z.infer<typeof NpcActionSchema>;
export type NpcReply = z.infer<typeof NpcReplySchema>;
export type Mood = (typeof MOODS)[number];

/**
 * Keywords OpenAI-style strict structured output does not support. zod emits numeric bounds
 * (`minimum`/`maximum`) for `z.number().int()`, which the hand-written schema never had; sending
 * them risks a provider rejecting the request outright. Dropping them keeps the wire contract
 * equivalent to the one that ships today.
 */
const UNSUPPORTED_STRICT_KEYWORDS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);

function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupported);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (UNSUPPORTED_STRICT_KEYWORDS.has(key)) continue;
      out[key] = stripUnsupported(value);
    }
    return out;
  }
  return node;
}

/**
 * The `response_format` payload for OpenRouter.
 *
 * Generated from the schema above so the wire contract cannot drift from the validator. The
 * `$schema` key is stripped because some providers reject unknown top-level keys.
 */
export function npcReplyResponseFormat(): Record<string, unknown> {
  const generated = z.toJSONSchema(NpcReplySchema, { target: "draft-7" }) as Record<
    string,
    unknown
  >;
  const { $schema: _ignored, ...rest } = generated;
  return {
    type: "json_schema",
    json_schema: {
      name: "npc_reply",
      strict: true,
      schema: stripUnsupported(rest),
    },
  };
}

/** Validate a model turn. Returns the typed value or the issues that made it unusable. */
export function parseNpcReply(
  value: unknown,
): { ok: true; reply: NpcReply } | { ok: false; error: string } {
  const result = NpcReplySchema.safeParse(value);
  if (result.success) return { ok: true, reply: result.data };
  const first = result.error.issues[0];
  const where = first?.path.join(".") || "(root)";
  return { ok: false, error: `${where}: ${first?.message ?? "invalid reply"}` };
}

/**
 * Parse a raw model string. Streaming callers usually validate a partial object instead; this is
 * for the non-streaming playground turn and for tests.
 */
export function parseNpcReplyJSON(
  raw: string,
): { ok: true; reply: NpcReply } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `malformed JSON: ${(error as Error).message}` };
  }
  return parseNpcReply(parsed);
}
