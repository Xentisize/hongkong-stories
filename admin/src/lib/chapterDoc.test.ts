import { describe, expect, test } from "bun:test";

import { blankChapterDoc } from "./chapterDoc";

/**
 * A new chapter's skeleton.
 *
 * The thing worth pinning down is that it starts *empty and valid-shaped*: the aggregation lists
 * exist (so the form has something to fill) but name nothing, because a guessed quest or location
 * would validate just enough to look finished.
 */

describe("blankChapterDoc", () => {
  test("carries the id and the document version", () => {
    const doc = blankChapterDoc("ch_new");
    expect(doc.schema_version).toBe(1);
    expect(doc.id).toBe("ch_new");
  });

  test("starts with nothing aggregated", () => {
    const doc = blankChapterDoc("ch_new");
    expect(doc.title).toEqual({});
    expect(doc.quests).toEqual([]);
    expect(doc.locations).toEqual([]);
    expect(doc.transitions).toEqual([]);
  });

  test("has an entry block the author only has to pick into", () => {
    const doc = blankChapterDoc("ch_new");
    expect(doc.entry).toEqual({ location: "", spawn: "default" });
  });

  test("does not invent a splash image", () => {
    expect(blankChapterDoc("ch_new").splash).toBeUndefined();
  });

  test("two chapters made in a row are distinct documents", () => {
    expect(blankChapterDoc("ch_a").id).not.toBe(blankChapterDoc("ch_b").id);
  });
});
