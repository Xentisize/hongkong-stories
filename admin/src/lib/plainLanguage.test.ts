import { describe, expect, test } from "bun:test";

import { explainIssue, explainIssues, shipVerdict } from "./plainLanguage";

/**
 * Validation in plain language.
 *
 * Two things must never happen: an unknown message must not be dressed up as if it were understood,
 * and errors must not be reordered behind warnings (they are what blocks shipping).
 */

const issue = (level: string, path: string, message: string) => ({ level, path, message });

describe("explainIssue", () => {
  test("a legend typo becomes a sentence about the map", () => {
    const plain = explainIssue(issue("warn", "locations/x.legend/q", "'q' is not in legend"));
    expect(plain.plain).toContain("地圖上有一個字");
    expect(plain.hint).toBeTruthy();
  });

  test("a door past the edge explains itself", () => {
    expect(explainIssue(issue("error", "locations/x.exits/1", "rect escapes the map")).plain).toContain("伸到地圖出面");
  });

  test("an unknown message is quoted, not invented", () => {
    const plain = explainIssue(issue("error", "npcs/a", "something nobody wrote a rule for"));
    expect(plain.plain).toBe("something nobody wrote a rule for");
    expect(plain.hint).toBeUndefined();
  });

  test("the path and level survive translation", () => {
    const plain = explainIssue(issue("error", "locations/x", "unknown transform 'rot45'"));
    expect(plain.level).toBe("error");
    expect(plain.path).toBe("locations/x");
  });
});

describe("explainIssues", () => {
  test("errors come first", () => {
    const sorted = explainIssues([
      issue("warn", "a", "'q' is not in legend"),
      issue("error", "b", "rect escapes the map"),
    ]);
    expect(sorted.map((entry) => entry.level)).toEqual(["error", "warn"]);
  });
});

describe("shipVerdict", () => {
  test("errors block shipping and are counted", () => {
    expect(shipVerdict([issue("error", "a", "x")], 3)).toEqual({ ok: false, line: "有 1 樣嘢要修好先出貨 / 1 thing(s) must be fixed before shipping" });
  });

  test("a clean pack with nothing pending says so", () => {
    expect(shipVerdict([], 0)).toEqual({ ok: true, line: "冇待發佈嘅改動 / nothing waiting to ship" });
  });

  test("warnings do not block, and pending changes are counted", () => {
    expect(shipVerdict([issue("warn", "a", "x")], 2).ok).toBe(true);
    expect(shipVerdict([issue("warn", "a", "x")], 2).line).toContain("2 樣改動準備好");
  });
});

describe("the flag that nothing sets", () => {
  test("becomes a sentence about a step that can never happen", () => {
    const plain = explainIssue(issue("warn", "flags", "'door_open' is read by a condition but nothing can set it"));
    expect(plain.plain).toContain("door_open");
    expect(plain.plain).toContain("卡住");
    expect(plain.hint).toContain("設定呢個旗標");
  });
});
