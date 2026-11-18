import { describe, expect, test } from "bun:test";

import type { ConditionState } from "@hkstories/core";

import {
  activeChapter,
  chapterDone,
  chapterEntry,
  chapterTransition,
  nextChapter,
  orderChapters,
  planAdvance,
  questDone,
  type ChapterDoc,
} from "./chapters";

/**
 * Chapter resolution.
 *
 * Policy, not plumbing: which chapter is active is *derived* from the save, which is why nothing has
 * to store a chapter index that could drift from the quests it claims to aggregate.
 */

const CH01: ChapterDoc = {
  id: "ch01",
  quests: ["ch01"],
  locations: ["loc_street"],
  entry: { location: "loc_street", spawn: "default" },
  transitions: [{ to: "ch02", requires: { quest_done: "ch01" } }],
};

const CH02: ChapterDoc = {
  id: "ch02",
  quests: ["ch02"],
  locations: ["loc_market"],
  entry: { location: "loc_market", spawn: "from_street" },
  transitions: [{ to: "ch03", requires: { quest_done: "ch02" } }],
};

const CH03: ChapterDoc = {
  id: "ch03",
  quests: ["ch03"],
  locations: ["loc_lane"],
  entry: { location: "loc_lane" },
  transitions: [],
};

const ALL = [CH03, CH01, CH02]; // deliberately unordered

const state = (quests: Record<string, { done?: boolean }> = {}): ConditionState => ({
  flags: {},
  vars: {},
  inventory: {},
  talk_counts: {},
  quests,
});

/** Conditions are `{ quest_done: id }` in these fixtures. */
const evaluate =
  (current: ConditionState) =>
  (condition: unknown): boolean => {
    const record = condition as { quest_done?: string } | null;
    const questId = record?.quest_done;
    return typeof questId === "string" && questDone(current, questId);
  };

describe("ordering", () => {
  test("chapters sort by id, so progress does not depend on manifest order", () => {
    expect(orderChapters(ALL).map((chapter) => chapter.id)).toEqual(["ch01", "ch02", "ch03"]);
  });

  test("a chapter with no id is not a chapter", () => {
    expect(orderChapters([{}, CH01])).toHaveLength(1);
  });
});

describe("the active chapter", () => {
  test("is the first with an unfinished quest", () => {
    expect(activeChapter(ALL, state())?.id).toBe("ch01");
  });

  test("follows the saved quests", () => {
    expect(activeChapter(ALL, state({ ch01: { done: true } }))?.id).toBe("ch02");
    expect(activeChapter(ALL, state({ ch01: { done: true }, ch02: { done: true } }))?.id).toBe("ch03");
  });

  test("is the last chapter once everything is done — the finale is where you end up", () => {
    const finished = state({ ch01: { done: true }, ch02: { done: true }, ch03: { done: true } });
    expect(activeChapter(ALL, finished)?.id).toBe("ch03");
  });

  test("a pack with no chapters has no active chapter", () => {
    expect(activeChapter([], state())).toBeNull();
  });

  test("a chapter with no quests is never done, so it cannot be skipped silently", () => {
    expect(chapterDone({ id: "ch_x", quests: [] }, state())).toBe(false);
  });
});

describe("transitions", () => {
  test("the first passing transition wins", () => {
    const passing = chapterTransition(CH01, evaluate(state({ ch01: { done: true } })));
    expect(passing?.to).toBe("ch02");
  });

  test("a gate that does not pass yet yields nothing", () => {
    expect(chapterTransition(CH01, evaluate(state()))).toBeNull();
  });

  test("no condition means no gate", () => {
    const open: ChapterDoc = { id: "x", transitions: [{ to: "y" }] };
    expect(chapterTransition(open, () => false)?.to).toBe("y");
  });

  test("a transition with no target is not a transition", () => {
    expect(chapterTransition({ id: "x", transitions: [{ to: "" }] }, () => true)).toBeNull();
  });

  test("a terminal chapter has nowhere to go", () => {
    expect(chapterTransition(CH03, () => true)).toBeNull();
  });
});

describe("entries", () => {
  test("resolve to a concrete spawn", () => {
    expect(chapterEntry(CH01)).toEqual({ location: "loc_street", spawn: "default" });
    expect(chapterEntry(CH02)).toEqual({ location: "loc_market", spawn: "from_street" });
  });

  test("an omitted spawn is the default point", () => {
    expect(chapterEntry(CH03)).toEqual({ location: "loc_lane", spawn: "default" });
  });

  test("no entry means no arrival point, not an empty location", () => {
    expect(chapterEntry({ id: "x" })).toBeNull();
    expect(chapterEntry({ id: "x", entry: { location: "" } })).toBeNull();
    expect(chapterEntry(null)).toBeNull();
  });
});

describe("succession", () => {
  test("the next chapter follows the id order", () => {
    expect(nextChapter(ALL, "ch01")?.id).toBe("ch02");
    expect(nextChapter(ALL, "ch03")).toBeNull();
    expect(nextChapter(ALL, "ch99")).toBeNull();
  });

  test("the whole chain is walkable: each transition targets the chapter that follows", () => {
    for (const chapter of orderChapters(ALL)) {
      const transition = chapterTransition({ ...chapter, transitions: chapter.transitions ?? [] }, () => true);
      if (transition === null) continue;
      expect(transition.to).toBe(nextChapter(ALL, String(chapter.id))?.id);
    }
  });
});

describe("advancing", () => {
  const plan = (currentId: string, quests: Record<string, { done?: boolean }> = {}) => {
    const current = state(quests);
    return planAdvance(ALL, currentId, current, evaluate(current));
  };

  test("a declared transition moves the player when its condition passes", () => {
    const advance = plan("ch01", { ch01: { done: true } });
    expect(advance?.target.id).toBe("ch02");
    expect(advance?.transition?.to).toBe("ch02");
  });

  test("nothing moves while the transition's condition is unsatisfied", () => {
    expect(plan("ch01")).toBeNull();
  });

  test("a terminal chapter never advances, however finished its quest is", () => {
    // ch03 declares no transition: finishing its quest is not the same as leaving it.
    expect(plan("ch03", { ch01: { done: true }, ch02: { done: true }, ch03: { done: true } })).toBeNull();
  });

  test("an authored departure line rides along", () => {
    const withText: ChapterDoc = {
      ...CH01,
      transitions: [{ to: "ch02", requires: { quest_done: "ch01" }, text: { en: "the tape ends" } }],
    };
    const current = state({ ch01: { done: true } });
    const advance = planAdvance([withText, CH02], "ch01", current, evaluate(current));

    expect(advance?.text).toEqual({ en: "the tape ends" });
  });

  test("a save already further along adopts the chapter its quests imply", () => {
    // No transition passes (ch01 is recorded as current, its quest is done, so ch01->ch02 would
    // fire) — the recovery path is for a chapter whose own transition does not fire.
    const recorded: ChapterDoc = { ...CH01, transitions: [{ to: "ch02", requires: { flag: "never" } }] };
    const current = state({ ch01: { done: true }, ch02: { done: true } });
    const advance = planAdvance([recorded, CH02, CH03], "ch01", current, evaluate(current));

    expect(advance?.target.id).toBe("ch03");
    expect(advance?.transition).toBeNull();
  });

  test("recovery never moves a player backwards", () => {
    const current = state({ ch01: { done: true } });
    // Recorded as ch02 but only ch01 is done: staying put, not rewinding to ch01.
    expect(planAdvance([CH01, CH02, CH03], "ch02", current, evaluate(current))).toBeNull();
  });
});
