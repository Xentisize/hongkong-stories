import { describe, expect, test } from "bun:test";

import { asLocalized, todoLocales, writeLocale } from "./localized";

/**
 * Localized writes, held to what the publish gate checks.
 *
 * The two mistakes this module exists to prevent are the ones a spread produces: writing `""` into
 * a locale key (an error: present but blank) and leaving a `_todo` acknowledgement behind after the
 * gap it acknowledged has been filled (which then excuses the *next* missing locale).
 */

describe("asLocalized", () => {
  test("keeps locale strings and drops list-shaped keys", () => {
    expect(asLocalized({ zh_HK: "鐵皮罐", en: "Tin", _todo: ["en"] })).toEqual({
      zh_HK: "鐵皮罐",
      en: "Tin",
    });
  });

  test("seeds a bare string at the canonical locale", () => {
    expect(asLocalized("Tin of tea")).toEqual({ zh_HK: "Tin of tea" });
    expect(asLocalized("   ")).toEqual({});
  });

  test("anything else reads as empty", () => {
    expect(asLocalized(undefined)).toEqual({});
    expect(asLocalized(7)).toEqual({});
  });
});

describe("writeLocale", () => {
  test("adds a locale without touching the others", () => {
    expect(writeLocale({ zh_HK: "甲" }, "en", "A")).toEqual({ zh_HK: "甲", en: "A" });
  });

  test("blank text drops the key instead of writing an empty string", () => {
    expect(writeLocale({ zh_HK: "甲", en: "A" }, "en", "  ")).toEqual({ zh_HK: "甲" });
  });

  test("filling a locale retires its _todo entry", () => {
    const field = { zh_HK: "甲", _todo: ["zh_CN", "en"] };
    expect(writeLocale(field, "en", "A")).toEqual({ zh_HK: "甲", en: "A", _todo: ["zh_CN"] });
  });

  test("the last retired entry drops _todo entirely", () => {
    expect(writeLocale({ zh_HK: "甲", _todo: ["en"] }, "en", "A")).toEqual({ zh_HK: "甲", en: "A" });
  });

  test("clearing a locale leaves the acknowledgement alone", () => {
    const field = { _todo: ["en"] };
    expect(writeLocale(field, "zh_HK", "")).toEqual({ _todo: ["en"] });
    expect(todoLocales(writeLocale(field, "zh_HK", ""))).toEqual(["en"]);
  });

  test("a non-string _todo is not rewritten", () => {
    expect(writeLocale({ zh_HK: "甲", _todo: "en" }, "en", "A")).toEqual({ zh_HK: "甲", en: "A" });
  });

  test("the input table is not mutated", () => {
    const field = { zh_HK: "甲" };
    writeLocale(field, "en", "A");
    expect(field).toEqual({ zh_HK: "甲" });
  });
});
