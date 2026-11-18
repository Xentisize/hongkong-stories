import { describe, expect, test } from "bun:test";

import type { ConditionState } from "@hkstories/core";

import { buildMessages, stablePrefix } from "./prompts";

/**
 * Cache-prefix stability (PLAN 7.2, 7.7).
 *
 * The ordering in `buildMessages` is the whole cost strategy: everything that cannot change between
 * turns for a given (npc, lang, event page) sits in the system message so it hits the provider
 * cache, and everything volatile sits in the final user message. If state ever leaks into the
 * prefix, caching silently stops paying — which is exactly the kind of regression that never shows
 * up as a bug, just as a bill.
 *
 * `server/tests/test_prompts.py` asserted this before the Python backend was retired; these are the
 * same assertions against the TypeScript port, so the contract did not leave with it.
 */

function npc(overrides: Record<string, unknown> = {}) {
  return {
    id: "npc_test",
    display_name: { zh_HK: "測試", zh_CN: "测试", en: "Test" },
    persona: { role: "a shopkeeper", voice: "terse", wants: "a quiet day", taboos: ["politics"] },
    lore: "The shop has stood on this street since the fifties.",
    llm: {
      actions_allowed: ["give"],
      items_may_give: ["item_key"],
      flags_may_set: ["helped"],
      vars_may_change: { trust: { min: -1, max: 2 } },
    },
    secrets: [{ id: "s_one", text: "The rent is overdue.", reveal_if: { flag: "asked" } }],
    states: [
      { requires: { flag: "chapter_two" }, persona_patch: { role: "a shopkeeper in hiding" } },
    ],
    ...overrides,
  };
}

const EMPTY: ConditionState = { flags: {}, vars: {}, inventory: {}, talk_counts: {}, quests: {} };

describe("the cacheable prefix", () => {
  test("is identical across differing player state", () => {
    const a = stablePrefix(npc(), "zh_HK");
    const b = stablePrefix(npc(), "zh_HK");
    expect(a).toBe(b);
  });

  test("does not contain anything volatile", () => {
    const prefix = stablePrefix(npc(), "zh_HK");
    // Volatile markers belong to the final user message only.
    expect(prefix).not.toContain("PLAYER SAYS");
    expect(prefix).not.toContain("RIGHT NOW");
    expect(prefix).not.toContain("SECRETS YOU MAY NOW REVEAL");
  });

  test("changes with the locale, because the register instruction is part of it", () => {
    expect(stablePrefix(npc(), "zh_HK")).not.toBe(stablePrefix(npc(), "en"));
  });

  test("carries the persona, lore and permitted actions", () => {
    const prefix = stablePrefix(npc(), "zh_HK");
    expect(prefix).toContain("a shopkeeper");
    expect(prefix).toContain("stood on this street since the fifties");
    expect(prefix).toContain("give: item_key");
  });

  test("states var bounds as min..max, not the Python bug of max twice", () => {
    // The Python prompt formatted these as "-{max}..{max}", telling the model -2..2 while the
    // allowlist enforced -1..2 and rejected what it proposed.
    expect(stablePrefix(npc(), "en")).toContain("trust (-1..2)");
  });
});

describe("message assembly", () => {
  test("a different active event page yields a different system message", () => {
    const calm = buildMessages(npc(), EMPTY, "zh_HK", [], "hello");
    const changed = buildMessages(
      npc(),
      { ...EMPTY, flags: { chapter_two: true } },
      "zh_HK",
      [],
      "hello",
    );
    expect(calm[0]!.content).not.toBe(changed[0]!.content);
    expect(changed[0]!.content).toContain("in hiding");
  });

  test("the same state gives a byte-identical system message on every turn", () => {
    const first = buildMessages(npc(), EMPTY, "zh_HK", [], "hello");
    const second = buildMessages(npc(), EMPTY, "zh_HK", [], "something else entirely");
    expect(first[0]!.content).toBe(second[0]!.content);
  });

  test("history is preserved in order and volatile state stays in the last message", () => {
    const history = [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
    ];
    const messages = buildMessages(npc(), { ...EMPTY, flags: { asked: true } }, "zh_HK", history, "now");

    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages[1]!.content).toBe("earlier question");
    // A revealed secret is state, so it must not touch the system message.
    expect(messages[0]!.content).not.toContain("The rent is overdue");
    expect(messages.at(-1)!.content).toContain("The rent is overdue");
    expect(messages.at(-1)!.content).toContain("now");
  });

  test("an empty player line gets a narrated placeholder instead of silence", () => {
    const messages = buildMessages(npc(), EMPTY, "en", [], "");
    expect(messages.at(-1)!.content).toContain("(The player says nothing");
  });

  test("malformed history is ignored rather than crashing", () => {
    const messages = buildMessages(npc(), EMPTY, "en", [null, 42, { role: "system", content: "x" }], "hi");
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
  });
});
