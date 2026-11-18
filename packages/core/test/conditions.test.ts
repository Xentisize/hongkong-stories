/**
 * Acceptance test for the condition evaluator (§5.5, §11).
 *
 * The fixture table is READ, never copied. It is the same file the Godot `--selftest` harness
 * and `server/tests/test_conditions.py` consume, so a case added by an author immediately
 * constrains this module too. Copying it would restore exactly the divergence the table exists
 * to prevent.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { approxEqual, evaluate } from "../src/conditions";
import { pyBool, type ConditionState } from "../src/state";

interface FixtureCase {
  label: string;
  condition: unknown;
  state: ConditionState;
  expected: boolean;
}

const FIXTURE_URL = new URL(
  "../../../client/tests/fixtures/conditions.json",
  import.meta.url,
);
const table = JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as {
  _comment: string;
  cases: FixtureCase[];
};

describe("shared fixture table", () => {
  test("the table still covers the whole vocabulary", () => {
    expect(table.cases.length).toBeGreaterThanOrEqual(30);
  });

  for (const fixture of table.cases) {
    test(fixture.label, () => {
      expect(evaluate(fixture.condition, fixture.state)).toBe(fixture.expected);
    });
  }

  test("no fixture case emits a warning", () => {
    for (const fixture of table.cases) {
      const warnings: string[] = [];
      evaluate(fixture.condition, fixture.state, { onWarning: (m) => warnings.push(m) });
      expect({ label: fixture.label, warnings }).toEqual({ label: fixture.label, warnings: [] });
    }
  });
});

/**
 * Float comparison: the resolved divergence.
 *
 * `server/app/llm/conditions.py` used exact `==`; `client/autoload/conditions.gd` used
 * `is_equal_approx`. Vars are floats accumulated by `add_var`, so accumulation drift made the
 * two twins answer differently for the same save — a silent quest-progression bug. This module
 * fixes the rule at approximate equality, and these tests pin it. The shared table above keeps
 * integer-valued vars only so the existing Python and GDScript suites remain valid while they
 * are retired.
 */
describe("float drift", () => {
  test("the drifted value really is not exactly 1", () => {
    let total = 0;
    for (let i = 0; i < 10; i += 1) total += 0.1;
    expect(total).not.toBe(1);
  });

  test("var == still passes after ten 0.1 additions", () => {
    let total = 0;
    for (let i = 0; i < 10; i += 1) total += 0.1;
    expect(evaluate({ var: "x", op: "==", value: 1 }, { vars: { x: total } })).toBe(true);
    expect(evaluate({ var: "x", op: "!=", value: 1 }, { vars: { x: total } })).toBe(false);
  });

  test("approxEqual rejects a genuinely different value", () => {
    expect(approxEqual(1, 1.5)).toBe(false);
    expect(approxEqual(0, 1e-9)).toBe(true);
  });
});

/**
 * Coercion fidelity. These are the cases where JavaScript truthiness would diverge from the
 * Python twin and produce a different answer for the same authored content.
 */
describe("python-shaped coercion", () => {
  test("empty containers are false, unlike JavaScript", () => {
    expect([]).toBeTruthy();
    expect(pyBool([])).toBe(false);
    expect(pyBool({})).toBe(false);
    expect(pyBool("")).toBe(false);
    expect(pyBool(0)).toBe(false);
    expect(pyBool("false")).toBe(true);
  });

  test("a flag holding an empty list reads as unset", () => {
    expect(evaluate({ flag: "a" }, { flags: { a: [] } })).toBe(false);
  });

  test("has_item accepts a numeric string, as int() did", () => {
    expect(evaluate({ has_item: "k", count: 2 }, { inventory: { k: "3" } })).toBe(true);
  });

  test("a non-object state bucket is treated as empty, not fatal", () => {
    const state = { flags: "corrupt" } as unknown as ConditionState;
    expect(evaluate({ flag: "a" }, state)).toBe(false);
  });
});

describe("diagnostics", () => {
  test("an unknown verb is false and warns", () => {
    const warnings: string[] = [];
    const result = evaluate({ teleport: "x" }, {}, { onWarning: (m) => warnings.push(m) });
    expect(result).toBe(false);
    expect(warnings).toHaveLength(1);
  });

  test("a non-object condition is false and warns", () => {
    const warnings: string[] = [];
    expect(evaluate("nope", {}, { onWarning: (m) => warnings.push(m) })).toBe(false);
    expect(warnings).toHaveLength(1);
  });

  test("an unknown comparison is false and warns", () => {
    const warnings: string[] = [];
    const result = evaluate(
      { var: "x", op: "~=", value: 1 },
      { vars: { x: 1 } },
      { onWarning: (m) => warnings.push(m) },
    );
    expect(result).toBe(false);
    expect(warnings).toHaveLength(1);
  });
});
