import { describe, expect, test } from "bun:test";

import { SayExtractor } from "./say-extractor";

/** Mirrors the cases `server/tests/test_extractors.py` pinned, so the port cannot drift. */

function feedAll(chunks: string[]): string {
  const extractor = new SayExtractor();
  return chunks.map((chunk) => extractor.feed(chunk)).join("");
}

describe("streaming across chunk boundaries", () => {
  test("reassembles a line split mid-word", () => {
    expect(feedAll(['{"say": "line one', ' two"}'])).toBe("line one two");
  });

  test("holds back a split escape sequence", () => {
    const extractor = new SayExtractor();
    expect(extractor.feed('{"say": "line one\\')).toBe("line one");
    expect(extractor.feed('nline two"}')).toBe("\nline two");
    expect(extractor.done).toBe(true);
  });

  test("holds back an incomplete unicode escape", () => {
    const extractor = new SayExtractor();
    expect(extractor.feed('{"say": "a\\u4f')).toBe("a");
    expect(extractor.feed('60b"}')).toBe("你b");
  });

  test("survives a chunk boundary inside the key", () => {
    expect(feedAll(['{"sa', 'y": "hi"}'])).toBe("hi");
  });

  test("survives a chunk boundary between key and value", () => {
    expect(feedAll(['{"say"', ': ', '"hi"}'])).toBe("hi");
  });
});

describe("escaping", () => {
  test("decodes a unicode escape", () => {
    expect(feedAll(['{"say": "\\u4f60\\u597d"}'])).toBe("你好");
  });

  test("handles an escaped quote inside the line", () => {
    expect(feedAll(['{"say": "she said \\"no\\" twice"}'])).toBe('she said "no" twice');
  });

  test("handles a literal backslash", () => {
    expect(feedAll(['{"say": "C:\\\\path"}'])).toBe("C:\\path");
  });

  test("stops at the closing quote and ignores the rest of the object", () => {
    const extractor = new SayExtractor();
    expect(extractor.feed('{"say": "done", "actions": [{"type":"give"}]}')).toBe("done");
    expect(extractor.feed(" more garbage")).toBe("");
  });
});

describe("robustness", () => {
  test("ignores content before the field", () => {
    expect(feedAll(['{"mood": "warm", "say": "hi"}'])).toBe("hi");
  });

  test("returns nothing until the field starts", () => {
    expect(feedAll(['{"mood"'])).toBe("");
  });

  test("passes CJK through unescaped", () => {
    expect(feedAll(['{"say": "你食咗飯未呀？"}'])).toBe("你食咗飯未呀？");
  });

  test("an empty line yields nothing and is finished", () => {
    const extractor = new SayExtractor();
    expect(extractor.feed('{"say": ""')).toBe("");
    expect(extractor.feed('}')).toBe("");
    expect(extractor.done).toBe(true);
  });
});
