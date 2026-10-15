import { describe, expect, it } from "vitest";
import { MODELS } from "../agent/llm/models";
import { CACHE_MINIMUM_TOKENS, DEFAULT_USD_INR, HAIKU_5_5, TARGET_INR_PER_CREDIT } from "./cost-per-message-lib";
import { buildOfflineReport } from "./cost-per-message-offline";

// The offline estimate: the REAL prompts (the builders in agent/prompts, the real-estate pack's fields) with typical messages and knowledge-base text,
// priced with the same table the traces use. No model is called. The token counts are estimates from characters.

const report = buildOfflineReport({ usdInr: DEFAULT_USD_INR });

describe("the offline estimate", () => {
  it("builds the real extraction prompt (rules, examples, the pack's fields: three cached blocks) and the real reply prompt (rules, persona: two)", () => {
    expect(report.extraction.blocks).toHaveLength(3);
    expect(report.reply.blocks).toHaveLength(2);
    for (const block of [...report.extraction.blocks, ...report.reply.blocks]) {
      expect(block.cache).toBe(true);
      expect(block.tokens).toBeGreaterThan(0);
    }
  });

  it("has an English and a Tamil-script scenario, and Tamil costs more (more tokens for the same words)", () => {
    const [english, tamil] = ["English", "Tamil script"].map((name) => report.scenarios.find((s) => s.name === name));
    expect(english).toBeDefined();
    expect(tamil).toBeDefined();
    expect(tamil!.cases.none.total).toBeGreaterThan(english!.cases.none.total);
  });

  it("prices every scenario three ways (no cache, every call a hit, every call a write) and with a regenerate", () => {
    for (const scenario of report.scenarios) {
      expect(scenario.cases.none.total).toBeGreaterThan(0);
      expect(scenario.cases.hit.total).toBeLessThanOrEqual(scenario.cases.none.total);
      expect(scenario.cases.write.total).toBeGreaterThanOrEqual(scenario.cases.hit.total);
      expect(scenario.regenerate.none.total).toBeGreaterThan(scenario.cases.none.total);
      expect(scenario.regenerate.none.regenerate).toBeGreaterThan(0);
    }
  });

  it("turns each into rupees at the rate given, per credit (one credit per message, even with a regenerate), against the 0.35 target", () => {
    const at100 = buildOfflineReport({ usdInr: 100 });
    const a = report.scenarios[0].cases.none;
    const b = at100.scenarios[0].cases.none;
    expect(b.perCreditInr / a.perCreditInr).toBeCloseTo(100 / 90, 6);
    expect(a.perCreditInr).toBeCloseTo(a.total * 90, 9);
    expect(report.targetInr).toBe(TARGET_INR_PER_CREDIT);
    expect(typeof report.scenarios[0].cases.none.withinTarget).toBe("boolean");
    expect(report.scenarios[0].regenerate.none.perCreditInr).toBeCloseTo(report.scenarios[0].regenerate.none.total * 90, 9);
  });

  it("breaks the Sonnet reply into its parts (cached prompt, knowledge-base context, conversation history, the rest of the turn, output), and they add up to the reply's cost", () => {
    for (const scenario of report.scenarios) {
      for (const mode of ["none", "hit", "write"] as const) {
        const parts = scenario.replyParts[mode];
        expect(parts.cachedPrompt + parts.knowledge + parts.history + parts.other + parts.output).toBeCloseTo(scenario.cases[mode].reply, 12);
        for (const key of ["cachedPrompt", "knowledge", "history", "output"] as const) expect(parts[key]).toBeGreaterThan(0);
        expect(parts.other).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("the knowledge-base part grows with the chunks, and the other parts do not", () => {
    const small = buildOfflineReport({ usdInr: 90, kbChunks: 1, kbChunkChars: 300 });
    const large = buildOfflineReport({ usdInr: 90, kbChunks: 5, kbChunkChars: 1500 });
    expect(large.scenarios[0].replyParts.none.knowledge).toBeGreaterThan(small.scenarios[0].replyParts.none.knowledge * 3);
    expect(large.scenarios[0].replyParts.none.history).toBeCloseTo(small.scenarios[0].replyParts.none.history, 12);
    expect(large.scenarios[0].replyParts.none.output).toBeCloseTo(small.scenarios[0].replyParts.none.output, 12);
    expect(large.scenarios[0].replyParts.none.cachedPrompt).toBeCloseTo(small.scenarios[0].replyParts.none.cachedPrompt, 12);
  });

  it("reports, per model, which cached blocks are long enough and which would silently not cache", () => {
    expect(report.cacheChecks.map((c) => c.model)).toEqual([MODELS.extraction, MODELS.reply]);
    for (const check of report.cacheChecks) {
      expect(check.minimum).toBe(CACHE_MINIMUM_TOKENS[check.model]);
      expect(check.verdicts.length).toBeGreaterThan(0);
      for (const verdict of check.verdicts) expect(verdict.caches).toBe(verdict.cumulativeTokens >= check.minimum);
      expect(check.cachedTokens).toBeLessThanOrEqual(check.totalCachedPrefixTokens);
      expect(check.borderline).toBe(Math.abs(check.totalCachedPrefixTokens / check.minimum - 1) <= 0.15);
    }
  });

  it("shows what extraction would cost on Haiku 5.5 as a what-if: cheaper than Haiku 4.5, and the model in use is not changed", () => {
    const [scenario] = report.scenarios;
    expect(scenario.haiku55.extractionNone).toBeGreaterThan(0);
    expect(scenario.haiku55.extractionNone).toBeLessThan(scenario.cases.none.extraction);
    expect(scenario.haiku55.totalNone).toBeCloseTo(scenario.haiku55.extractionNone + scenario.cases.none.reply, 12);
    expect(report.whatIfModel).toBe(HAIKU_5_5);
    expect(MODELS.extraction).toBe("claude-haiku-4-5-20251001");
  });

  it("lists its assumptions in words", () => {
    expect(report.assumptions.length).toBeGreaterThanOrEqual(5);
    expect(report.assumptions.join(" ")).toMatch(/characters per token/i);
    expect(report.assumptions.join(" ")).toMatch(/90/);
  });

  it("takes the size of the knowledge-base context as an option: more text costs more", () => {
    const small = buildOfflineReport({ usdInr: 90, kbChunks: 1, kbChunkChars: 300 });
    const large = buildOfflineReport({ usdInr: 90, kbChunks: 5, kbChunkChars: 1500 });
    expect(large.scenarios[0].cases.none.total).toBeGreaterThan(small.scenarios[0].cases.none.total);
    expect(large.reply.userTokens).toBeGreaterThan(small.reply.userTokens);
  });

  it("takes per-model characters-per-token ratios (as calibrated from traces) and uses them", () => {
    const heavier = buildOfflineReport({ usdInr: 90, ratios: { [MODELS.reply]: { latin: 1.5, indic: 0.5 } } });
    expect(heavier.scenarios[0].cases.none.reply).toBeGreaterThan(report.scenarios[0].cases.none.reply);
    expect(heavier.scenarios[0].cases.none.extraction).toBeCloseTo(report.scenarios[0].cases.none.extraction, 12);
  });
});
