import { describe, expect, it } from "vitest";
import { estimateCostUsd, MODELS, ROLE_SETTINGS, type TokenUsage } from "./models";

// The two models the agent uses, what each call to them is allowed to take, and what a call costs. The model
// ids are exact strings from docs/handover.md and the Anthropic API: a typo is a 404 on every message.

const usage = (over: Partial<TokenUsage> = {}): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...over });

describe("MODELS", () => {
  it("are Haiku 4.5 for extraction and Sonnet 5.5 for replies, by exact id", () => {
    expect(MODELS.extraction).toBe("claude-haiku-4-5-20251001");
    expect(MODELS.reply).toBe("claude-sonnet-5-5");
  });
});

describe("the lead card writer (Day 4)", () => {
  it("uses the strong model, as a reply does, because it writes a reply staff may send in the customer's language", () => {
    expect(MODELS.summary).toBe(MODELS.reply);
    expect(ROLE_SETTINGS.summary).toMatchObject({ model: MODELS.reply, effort: "low" });
    expect(ROLE_SETTINGS.summary.temperature).toBeUndefined(); // Sonnet 5.5 refuses a non-default value
  });

  it("has room for the JSON and a tamil-script reply, and a deadline that fits a staff member waiting", () => {
    expect(ROLE_SETTINGS.summary.maxTokens).toBeGreaterThanOrEqual(1500);
    expect(ROLE_SETTINGS.summary.attemptTimeoutMs).toBeLessThan(ROLE_SETTINGS.summary.totalTimeoutMs);
    expect(ROLE_SETTINGS.summary.totalTimeoutMs).toBeLessThanOrEqual(25_000);
  });
});

describe("ROLE_SETTINGS", () => {
  it("extraction is deterministic and short: Haiku, temperature 0, no effort setting (Haiku 4.5 refuses one)", () => {
    expect(ROLE_SETTINGS.extraction).toMatchObject({ model: MODELS.extraction, temperature: 0, maxTokens: 1024 });
    expect(ROLE_SETTINGS.extraction.effort).toBeUndefined();
  });

  it("replies run Sonnet 5.5 at low effort and send no sampling parameters (it refuses non-default ones)", () => {
    expect(ROLE_SETTINGS.reply).toMatchObject({ model: MODELS.reply, effort: "low" });
    expect(ROLE_SETTINGS.reply.temperature).toBeUndefined();
    // room for the reply and for the thinking that counts against max_tokens, and Tamil takes more tokens than English
    expect(ROLE_SETTINGS.reply.maxTokens).toBeGreaterThanOrEqual(1500);
  });

  it("every role has a per-try timeout shorter than its overall deadline, and the reply one fits the 25 second turn limit", () => {
    for (const role of ["extraction", "reply"] as const) {
      const s = ROLE_SETTINGS[role];
      expect(s.attemptTimeoutMs).toBeGreaterThan(0);
      expect(s.attemptTimeoutMs).toBeLessThan(s.totalTimeoutMs);
    }
    expect(ROLE_SETTINGS.reply.totalTimeoutMs).toBeLessThanOrEqual(25_000);
  });
});

describe("estimateCostUsd", () => {
  it("prices Haiku input and output per million tokens", () => {
    expect(estimateCostUsd(MODELS.extraction, usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }))).toBeCloseTo(1 + 5, 6);
  });

  it("prices Sonnet 5.5 input and output per million tokens", () => {
    expect(estimateCostUsd(MODELS.reply, usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }))).toBeCloseTo(2 + 10, 6);
  });

  it("charges a tenth for tokens read from the cache and a quarter more for tokens written to it", () => {
    expect(estimateCostUsd(MODELS.extraction, usage({ cacheReadTokens: 1_000_000 }))).toBeCloseTo(0.1, 6);
    expect(estimateCostUsd(MODELS.extraction, usage({ cacheWriteTokens: 1_000_000 }))).toBeCloseTo(1.25, 6);
    expect(estimateCostUsd(MODELS.reply, usage({ cacheReadTokens: 1_000_000 }))).toBeCloseTo(0.2, 6);
  });

  it("adds up a typical reply", () => {
    // 800 uncached + 3000 cached-read input tokens, 250 output tokens on Sonnet 5.5
    const cost = estimateCostUsd(MODELS.reply, usage({ inputTokens: 800, cacheReadTokens: 3000, outputTokens: 250 }));
    expect(cost).toBeCloseTo((800 * 2 + 3000 * 0.2 + 250 * 10) / 1_000_000, 8);
  });

  it("is null for names that only exist on every object, not for a real price", () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) expect(estimateCostUsd(name, usage({ inputTokens: 100 }))).toBeNull();
  });

  it("is zero for no usage, and null for a model it has no price for (never a made-up number)", () => {
    expect(estimateCostUsd(MODELS.reply, usage())).toBe(0);
    expect(estimateCostUsd("claude-unknown-9", usage({ inputTokens: 100 }))).toBeNull();
  });
});
