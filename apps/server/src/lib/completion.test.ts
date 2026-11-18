import { describe, expect, test } from "bun:test";

import { estimateCost, usageFromStreamChunk } from "./completion";

/**
 * Provider usage read from a streamed chunk.
 *
 * The rule that matters is the fallback: `null` here means "keep estimating", so anything that is
 * not a real usage block must return `null` rather than zeroes. A streamed turn charged as zero
 * would quietly make the budget caps free.
 */

describe("usageFromStreamChunk", () => {
  test("reads a real final chunk, which carries usage and no choice", () => {
    const chunk = {
      id: "gen-123",
      usage: {
        prompt_tokens: 812,
        completion_tokens: 96,
        total_tokens: 908,
        prompt_tokens_details: { cached_tokens: 640 },
      },
    };
    expect(usageFromStreamChunk(chunk)).toEqual({
      promptTokens: 812,
      completionTokens: 96,
      cachedTokens: 640,
    });
  });

  test("an ordinary token chunk has no usage", () => {
    expect(usageFromStreamChunk({ choices: [{ delta: { content: "你" } }] })).toBeNull();
  });

  test("a usage block with no counts is noise, not zero tokens", () => {
    expect(usageFromStreamChunk({ usage: {} })).toBeNull();
    expect(usageFromStreamChunk({ usage: { total_tokens: 908 } })).toBeNull();
  });

  test("a missing or partial cached-token detail reads as zero cached", () => {
    expect(usageFromStreamChunk({ usage: { prompt_tokens: 10, completion_tokens: 2 } })).toEqual({
      promptTokens: 10,
      completionTokens: 2,
      cachedTokens: 0,
    });
  });

  test("one count is enough to be usable", () => {
    expect(usageFromStreamChunk({ usage: { prompt_tokens: 10 } })).toEqual({
      promptTokens: 10,
      completionTokens: 0,
      cachedTokens: 0,
    });
  });

  test("garbage in the fields degrades to zero rather than NaN", () => {
    const usage = usageFromStreamChunk({
      usage: { prompt_tokens: "many", completion_tokens: null, prompt_tokens_details: "nope" },
    });
    expect(usage).toBeNull(); // neither count is a number: nothing usable
  });

  test("non-objects are not usage", () => {
    expect(usageFromStreamChunk(null)).toBeNull();
    expect(usageFromStreamChunk("data: [DONE]")).toBeNull();
    expect(usageFromStreamChunk([{ usage: { prompt_tokens: 1 } }])).toBeNull();
  });

  test("a measured turn costs less than the same tokens estimated as uncached", () => {
    const measured = usageFromStreamChunk({
      usage: { prompt_tokens: 812, completion_tokens: 96, prompt_tokens_details: { cached_tokens: 640 } },
    })!;
    const cost = estimateCost(measured.promptTokens, measured.cachedTokens, measured.completionTokens);
    const uncached = estimateCost(measured.promptTokens, 0, measured.completionTokens);
    // The cached-read price is what makes the prefix caching visible in the ledger at all.
    expect(cost).toBeLessThan(uncached);
    expect(cost).toBeGreaterThan(0);
  });
});
