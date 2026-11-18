import { describe, expect, test } from "bun:test";

import {
  ART_MEDIA,
  ART_STYLES,
  resolveArtMedium,
  resolveArtStyle,
} from "@hkstories/core";

import { TEMPLATES, TARGETS, buildPrompt, isArtKind } from "./templates";

/**
 * Prompt composition with two independent look axes.
 *
 * Two regressions matter here. The subject templates must stay medium-neutral — they used to say
 * "pixel art", which turned into a contradiction the moment a creator could pick hand-drawn or paper
 * craft. And an unknown id on one axis must fall back without dragging the other axis down with it.
 */

describe("buildPrompt", () => {
  test("the pixel style anchors the prompt", () => {
    const prompt = buildPrompt("sprite", "a hawker", { style: "hk16" });
    expect(prompt.startsWith(resolveArtStyle("hk16").master)).toBe(true);
    expect(prompt).toContain("sprite of a hawker");
  });

  test("style and medium both land, style first", () => {
    const prompt = buildPrompt("sprite", "a hawker", { style: "lofi", medium: "chibi" });
    expect(prompt.startsWith(resolveArtStyle("lofi").master)).toBe(true);
    expect(prompt.indexOf("8-bit lo-fi")).toBeLessThan(prompt.indexOf("chibi character design"));
    expect(prompt).toContain("sprite of a hawker");
  });

  test("the natural medium adds nothing", () => {
    const withoutMedium = buildPrompt("sprite", "a hawker", { style: "hk16" });
    const withNatural = buildPrompt("sprite", "a hawker", { style: "hk16", medium: "natural" });
    expect(withNatural).toBe(withoutMedium);
  });

  test("the subject templates are medium-neutral", () => {
    // The style and medium supply the look; a template that claims "pixel art" would fight a
    // paper-craft or hand-drawn medium, which is exactly the bug this guard exists for.
    for (const template of Object.values(TEMPLATES)) {
      expect(template.toLowerCase()).not.toContain("pixel art");
      expect(template.toLowerCase()).not.toContain("pixel-art");
    }
  });

  test("an unknown id falls back per axis", () => {
    const fallback = buildPrompt("prop", "a tin of tea", { style: "vaporwave", medium: "vaporwave" });
    expect(fallback.startsWith(resolveArtStyle(undefined).master)).toBe(true);
    expect(fallback).not.toContain("chibi character design");

    const styleOnly = buildPrompt("prop", "a tin of tea", { style: "vaporwave", medium: "chibi" });
    expect(styleOnly.startsWith(resolveArtStyle(undefined).master)).toBe(true);
    expect(styleOnly).toContain(resolveArtMedium("chibi").master);
  });

  test("every kind keeps the project palette under every combination", () => {
    for (const kind of Object.keys(TARGETS) as Array<keyof typeof TEMPLATES>) {
      for (const style of ART_STYLES) {
        for (const medium of ART_MEDIA) {
          expect(buildPrompt(kind, "a hawker", { style: style.id, medium: medium.id })).toContain(
            "hk_palette_v1",
          );
        }
      }
    }
  });

  test("the description is substituted and trimmed", () => {
    expect(buildPrompt("prop", "  a tin of tea  ", {})).toContain("a tin of tea");
  });

  test("the description slot exists in every template", () => {
    for (const template of Object.values(TEMPLATES)) {
      expect(template).toContain("{desc}");
    }
  });
});

describe("isArtKind", () => {
  test("recognises the kinds the templates cover", () => {
    expect(isArtKind("sprite")).toBe(true);
    expect(isArtKind("stylebible")).toBe(true);
    expect(isArtKind("nope")).toBe(false);
  });
});
