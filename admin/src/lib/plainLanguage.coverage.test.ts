import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { RULES } from "./plainLanguage";

/**
 * Does the translation still point at messages that exist?
 *
 * `plainLanguage` matches validator text with regexes. The failure this guards against is silent:
 * someone rewrites a validator message, its rule never matches again, and the studio quietly starts
 * showing schema jargon — with every test still green. So the rules are checked against the real
 * source: each must match at least one message the validator can emit.
 */

const validator = readFileSync(
  join(import.meta.dir, "..", "..", "..", "packages", "core", "src", "validate.ts"),
  "utf8",
);

/** Quoted and template literals that look like messages rather than identifiers or paths. */
const messages: string[] = [
  ...validator.matchAll(/"([^"\n]{8,})"|'([^'\n]{8,})'|`([^`\n]{8,})`/g),
]
  .map((match) => (match[1] ?? match[2] ?? match[3] ?? "").trim())
  .filter((text) => /\s/.test(text) && /[a-z]/i.test(text));

describe("plainLanguage rules", () => {
  test("the validator source was readable", () => {
    expect(messages.length).toBeGreaterThan(20);
  });

  test("every rule still matches something the validator emits", () => {
    const dead = RULES.filter((rule) => !messages.some((message) => rule.match.test(message))).map(
      (rule) => rule.match.source,
    );
    // A dead rule is not a style problem: it means the studio shows raw schema text for that case.
    expect(dead).toEqual([]);
  });

  test("a reworded message is the way this test is meant to fail", () => {
    // Guard the guard: a message the rules do not know must not be silently "covered" by a lax regex.
    const unknown = "the validator said something entirely new";
    expect(RULES.some((rule) => rule.match.test(unknown))).toBe(false);
  });
});
