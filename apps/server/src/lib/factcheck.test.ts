import { describe, expect, test } from "bun:test";

import {
  MAX_VERDICT_ATTEMPTS,
  VERDICTS,
  buildVerdictMessages,
  parseVerdict,
  scoreLine,
  tryParseVerdict,
  verdictResponseFormat,
} from "./factcheck";

/**
 * The checker's parsing and retry policy.
 *
 * No database and no provider here on purpose: `scoreLine` takes the model call as an argument, so
 * the interesting behaviour — when a second attempt happens, and what a pair of failures becomes —
 * is testable without either.
 */

const npc = {
  id: "npc_ken",
  persona: { role: "a shopkeeper" },
  lore: "The shop has stood on this street since the fifties.",
};

describe("verdict parsing", () => {
  test("accepts a bare JSON verdict", () => {
    expect(tryParseVerdict('{"verdict":"contradiction","reason":"the shop closed in 1958"}')).toEqual({
      verdict: "contradiction",
      reason: "the shop closed in 1958",
    });
  });

  test("accepts one wrapped in a fenced block", () => {
    expect(tryParseVerdict('```json\n{"verdict":"ok","reason":"fine"}\n```')).toEqual({
      verdict: "ok",
      reason: "fine",
    });
  });

  test("an undeclared verdict becomes questionable but keeps the model's reason", () => {
    const parsed = tryParseVerdict('{"verdict":"excellent","reason":"reads well"}');
    expect(parsed?.verdict).toBe("questionable");
    expect(parsed?.reason).toBe("reads well");
  });

  test("prose is unusable, not a verdict", () => {
    expect(tryParseVerdict("I think it looks fine to me.")).toBeNull();
    expect(tryParseVerdict("[1,2,3]")).toBeNull();
    expect(tryParseVerdict('"a string"')).toBeNull();
  });

  test("the defensive form still answers", () => {
    const parsed = parseVerdict("I think it looks fine to me.");
    expect(parsed.verdict).toBe("questionable");
    expect(parsed.reason).toContain("unparsable");
  });
});

describe("scoreLine", () => {
  test("a usable first answer is not retried", async () => {
    const attempts: number[] = [];
    const scored = await scoreLine(async (attempt) => {
      attempts.push(attempt);
      return '{"verdict":"ok","reason":"supported by the lore"}';
    });

    expect(scored).toEqual({ verdict: "ok", reason: "supported by the lore", attempts: 1, parsed: true });
    expect(attempts).toEqual([1]);
  });

  test("prose is retried once, and the second answer is used", async () => {
    const attempts: number[] = [];
    const scored = await scoreLine(async (attempt) => {
      attempts.push(attempt);
      return attempt === 1
        ? "The reply looks consistent with the lore to me."
        : '{"verdict":"questionable","reason":"mentions a date the lore never gives"}';
    });

    expect(attempts).toEqual([1, 2]);
    expect(scored.parsed).toBe(true);
    expect(scored.attempts).toBe(2);
    expect(scored.verdict).toBe("questionable");
    expect(scored.reason).toBe("mentions a date the lore never gives");
  });

  test("two unusable answers fall back, and say so", async () => {
    const scored = await scoreLine(async () => "I cannot answer that in JSON.");

    expect(scored.parsed).toBe(false);
    expect(scored.attempts).toBe(MAX_VERDICT_ATTEMPTS);
    expect(scored.verdict).toBe("questionable");
    // The reason has to distinguish "the checker was unsure" from "the checker never answered",
    // because the second is a bug in the pipeline rather than a line needing review.
    expect(scored.reason).toContain(`after ${MAX_VERDICT_ATTEMPTS} attempts`);
  });
});

describe("verdictResponseFormat", () => {
  const format = verdictResponseFormat() as {
    type: string;
    json_schema: {
      name: string;
      strict: boolean;
      schema: {
        additionalProperties: boolean;
        required: string[];
        properties: { verdict: { enum: string[] }; reason: { type: string } };
      };
    };
  };

  test("wraps a strict schema in the shape the API expects", () => {
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.name).toBe("fact_check_verdict");
    expect(format.json_schema.schema.additionalProperties).toBe(false);
    expect(format.json_schema.schema.required).toEqual(["verdict", "reason"]);
  });

  test("constrains the verdict to the three declared values", () => {
    expect(format.json_schema.schema.properties.verdict.enum).toEqual([...VERDICTS]);
    expect(format.json_schema.schema.properties.reason.type).toBe("string");
  });
});

describe("buildVerdictMessages", () => {
  test("carries the character, the lore and both lines", () => {
    const [system, user] = buildVerdictMessages(npc, "你間舖開咗幾耐？", "我一九五八年開始做嘢。");

    expect(system?.role).toBe("system");
    expect((system?.content ?? "").length).toBeGreaterThan(20);

    const prompt = user?.content ?? "";
    expect(prompt).toContain("a shopkeeper");
    expect(prompt).toContain("stood on this street since the fifties");
    expect(prompt).toContain("你間舖開咗幾耐？");
    expect(prompt).toContain("我一九五八年開始做嘢。");
    // The instruction has to name the shape it wants, schema or no schema.
    expect(prompt).toContain('"verdict"');
  });

  test("absent lore and a silent player are stated, not left blank", () => {
    const [, user] = buildVerdictMessages({ id: "npc_x" }, "", "A line.");
    const prompt = user?.content ?? "";
    expect(prompt).toContain("(none authored)");
    expect(prompt).toContain("(nothing)");
  });
});
