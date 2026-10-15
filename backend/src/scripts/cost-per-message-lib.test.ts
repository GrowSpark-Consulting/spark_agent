import { describe, expect, it, vi } from "vitest";
import { MODELS } from "../agent/llm/models";
import {
  CACHE_MINIMUM_TOKENS,
  DEFAULT_USD_INR,
  HAIKU_5_5,
  TARGET_INR_PER_CREDIT,
  breakEvenHitRate,
  breakdownCostUsd,
  cacheVerdicts,
  cachedPrefixTokens,
  calibrateCharsPerToken,
  callCostUsd,
  charsPerToken,
  estimateTokens,
  fetchObservations,
  indiaDay,
  messageCostUsd,
  parseExport,
  priceUsd,
  resolveTraceSource,
  resolveUsdInr,
  summariseTraces,
  toInr,
  type CallSpec,
} from "./cost-per-message-lib";

// The cost maths behind `pnpm cost:per-message` (docs/cost-per-message.md): pricing, what the cache does and does not do, rupees, and reading Langfuse traces.
// Nothing here calls a model or a network: the Langfuse calls use a fake fetch.

const HAIKU = MODELS.extraction;
const SONNET = MODELS.reply;
const M = 1_000_000;

describe("priceUsd", () => {
  it("prices Haiku 4.5 and Sonnet 5.5 per million tokens, cache reads and writes included", () => {
    expect(priceUsd(HAIKU, { inputTokens: M, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeCloseTo(1, 9);
    expect(priceUsd(HAIKU, { inputTokens: 0, outputTokens: M, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeCloseTo(5, 9);
    expect(priceUsd(HAIKU, { inputTokens: 0, outputTokens: 0, cacheReadTokens: M, cacheWriteTokens: 0 })).toBeCloseTo(0.1, 9);
    expect(priceUsd(HAIKU, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: M })).toBeCloseTo(1.25, 9);
    expect(priceUsd(SONNET, { inputTokens: M, outputTokens: M, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeCloseTo(12, 9);
    expect(priceUsd(SONNET, { inputTokens: 0, outputTokens: 0, cacheReadTokens: M, cacheWriteTokens: 0 })).toBeCloseTo(0.1, 9); // 0.05 x input: the pricing page
    expect(priceUsd(SONNET, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: M })).toBeCloseTo(2.5, 9);
  });

  it("prices Haiku 5.5 as a what-if only (it is not a model the agent uses): $0.10 in, $0.50 out, $0.01 cache read, $0.125 cache write", () => {
    expect(Object.values(MODELS)).not.toContain(HAIKU_5_5);
    expect(priceUsd(HAIKU_5_5, { inputTokens: M, outputTokens: M, cacheReadTokens: M, cacheWriteTokens: M })).toBeCloseTo(0.1 + 0.5 + 0.01 + 0.125, 9);
  });

  it("is null for a model it has no price for, never a made-up number", () => {
    expect(priceUsd("claude-unknown-9", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
  });
});

describe("estimateTokens: a separate characters-per-token ratio for each model", () => {
  it("counts the newer tokenizer's models (Sonnet 5.5, Haiku 5.5) about 30% higher than Haiku 4.5 for the same text", () => {
    const text = "a".repeat(10_000);
    const old = estimateTokens(text, HAIKU);
    expect(estimateTokens(text, SONNET)).toBeGreaterThan(old * 1.25);
    expect(estimateTokens(text, SONNET)).toBeLessThan(old * 1.35);
    expect(estimateTokens(text, HAIKU_5_5)).toBe(estimateTokens(text, SONNET));
  });

  it("counts Tamil script as many more tokens than the same number of English letters", () => {
    expect(estimateTokens("வ".repeat(1000), HAIKU)).toBeGreaterThan(estimateTokens("a".repeat(1000), HAIKU) * 2);
  });

  it("counts a mixed text by its parts, and nothing as zero", () => {
    const latin = charsPerToken(HAIKU).latin;
    const indic = charsPerToken(HAIKU).indic;
    expect(estimateTokens("a".repeat(350) + "வ".repeat(120), HAIKU)).toBe(Math.ceil(350 / latin + 120 / indic));
    expect(estimateTokens("", HAIKU)).toBe(0);
  });

  it("uses a ratio given for one model without touching the others", () => {
    expect(estimateTokens("a".repeat(1000), HAIKU, { [HAIKU]: { latin: 2, indic: 1 } })).toBe(500);
    expect(estimateTokens("a".repeat(1000), SONNET, { [HAIKU]: { latin: 2, indic: 1 } })).toBe(Math.ceil(1000 / charsPerToken(SONNET).latin));
  });
});

describe("what the cache silently does not do", () => {
  it("knows the minimums: 4,096 tokens for Haiku 4.5, 512 for Sonnet 5.5 and Haiku 5.5", () => {
    expect(CACHE_MINIMUM_TOKENS[HAIKU]).toBe(4096);
    expect(CACHE_MINIMUM_TOKENS[SONNET]).toBe(512);
    expect(CACHE_MINIMUM_TOKENS[HAIKU_5_5]).toBe(512);
  });

  it("caches the prefix up to the longest breakpoint that reaches the minimum, and nothing when none does", () => {
    const blocks = [
      { tokens: 300, cache: true },
      { tokens: 300, cache: true },
      { tokens: 500, cache: true },
    ];
    expect(cachedPrefixTokens(blocks, 512)).toBe(1100); // 300 is too short alone, 600 is long enough, 1100 is the longest
    expect(cachedPrefixTokens(blocks, 1100)).toBe(1100);
    expect(cachedPrefixTokens(blocks, 1101)).toBe(0);
    expect(cachedPrefixTokens(blocks, 4096)).toBe(0);
  });

  it("counts a block with no breakpoint into the prefix but never as the end of one", () => {
    expect(cachedPrefixTokens([{ tokens: 600, cache: true }, { tokens: 400, cache: false }], 512)).toBe(600);
    expect(cachedPrefixTokens([{ tokens: 600, cache: false }, { tokens: 100, cache: true }], 512)).toBe(700);
    expect(cachedPrefixTokens([{ tokens: 900, cache: false }], 512)).toBe(0);
  });

  it("reports, for each breakpoint, how long the prefix is and whether it would cache", () => {
    expect(
      cacheVerdicts(
        [
          { tokens: 300, cache: true },
          { tokens: 300, cache: true },
          { tokens: 100, cache: false },
        ],
        512,
      ),
    ).toEqual([
      { index: 0, cumulativeTokens: 300, caches: false },
      { index: 1, cumulativeTokens: 600, caches: true },
    ]);
  });
});

describe("one call's cost, with the cache missing, hit or being written", () => {
  const sonnet: CallSpec = { model: SONNET, blocks: [{ tokens: 1000, cache: true }], userTokens: 500, outputTokens: 200 };

  it("without the cache every input token is full price", () => {
    expect(callCostUsd(sonnet, "none")).toBeCloseTo((1500 * 2 + 200 * 10) / M, 9);
  });

  it("with a hit the cached part costs a twentieth of the input price", () => {
    expect(callCostUsd(sonnet, "hit")).toBeCloseTo((500 * 2 + 1000 * 0.1 + 200 * 10) / M, 9);
  });

  it("with a write the cached part costs a quarter MORE than full price: a cache that is never hit loses money", () => {
    expect(callCostUsd(sonnet, "write")).toBeCloseTo((500 * 2 + 1000 * 2.5 + 200 * 10) / M, 9);
    expect(callCostUsd(sonnet, "write")).toBeGreaterThan(callCostUsd(sonnet, "none"));
  });

  it("a prompt under the model's minimum is never cached: hit, write and none cost the same (Haiku 4.5, 3,000 cached-looking tokens)", () => {
    const haiku: CallSpec = { model: HAIKU, blocks: [{ tokens: 3000, cache: true }], userTokens: 300, outputTokens: 100 };
    const none = callCostUsd(haiku, "none");
    expect(callCostUsd(haiku, "hit")).toBe(none);
    expect(callCostUsd(haiku, "write")).toBe(none);
    const long: CallSpec = { ...haiku, blocks: [{ tokens: 4096, cache: true }] };
    expect(callCostUsd(long, "hit")).toBeLessThan(callCostUsd(long, "none"));
  });

  it("the break-even hit rate is where writing on a miss and reading on a hit cost the same as no cache", () => {
    const h = breakEvenHitRate(sonnet);
    expect(h).toBeCloseTo((callCostUsd(sonnet, "write") - callCostUsd(sonnet, "none")) / (callCostUsd(sonnet, "write") - callCostUsd(sonnet, "hit")), 9);
    expect(h).toBeCloseTo(500 / 2400, 6);
    const mixed = h! * callCostUsd(sonnet, "hit") + (1 - h!) * callCostUsd(sonnet, "write");
    expect(mixed).toBeCloseTo(callCostUsd(sonnet, "none"), 9);
  });

  it("has no break-even for a call the cache never touches", () => {
    expect(breakEvenHitRate({ model: HAIKU, blocks: [{ tokens: 100, cache: true }], userTokens: 10, outputTokens: 10 })).toBeNull();
  });
});

describe("the reply's cost by part", () => {
  const reply: CallSpec = { model: SONNET, blocks: [{ tokens: 1000, cache: true }], userTokens: 900, outputTokens: 200 };
  const split = { knowledgeTokens: 500, historyTokens: 300 };

  it.each(["none", "hit", "write"] as const)("the parts add up to the call's cost (%s)", (mode) => {
    const parts = breakdownCostUsd(reply, split, mode);
    expect(parts.cachedPrompt + parts.knowledge + parts.history + parts.other + parts.output).toBeCloseTo(callCostUsd(reply, mode), 12);
    expect(parts.total).toBeCloseTo(callCostUsd(reply, mode), 12);
  });

  it("prices each part: the fixed prompt as cached or not, the knowledge base and the history at the input price, the rest of the turn too, the answer at the output price", () => {
    const none = breakdownCostUsd(reply, split, "none");
    expect(none.cachedPrompt).toBeCloseTo((1000 * 2) / M, 12);
    expect(none.knowledge).toBeCloseTo((500 * 2) / M, 12);
    expect(none.history).toBeCloseTo((300 * 2) / M, 12);
    expect(none.other).toBeCloseTo((100 * 2) / M, 12); // 900 - 500 - 300: the task and the questions to ask
    expect(none.output).toBeCloseTo((200 * 10) / M, 12);
    const hit = breakdownCostUsd(reply, split, "hit");
    expect(hit.cachedPrompt).toBeCloseTo((1000 * 0.1) / M, 12);
    expect(hit.knowledge).toBeCloseTo(none.knowledge, 12);
    expect(breakdownCostUsd(reply, split, "write").cachedPrompt).toBeCloseTo((1000 * 2.5) / M, 12);
  });

  it("a fixed prompt under the minimum is billed as plain input in every mode", () => {
    const short: CallSpec = { ...reply, blocks: [{ tokens: 300, cache: true }] };
    expect(breakdownCostUsd(short, split, "hit").cachedPrompt).toBeCloseTo((300 * 2) / M, 12);
  });

  it("never lets the rest of the turn go negative when the parts are given rounded up", () => {
    expect(breakdownCostUsd(reply, { knowledgeTokens: 600, historyTokens: 400 }, "none").other).toBe(0);
  });
});

describe("one processed message: an extraction, a reply, and perhaps a second reply", () => {
  const turn = {
    extraction: { model: HAIKU, blocks: [{ tokens: 5000, cache: true }], userTokens: 200, outputTokens: 150 } as CallSpec,
    reply: { model: SONNET, blocks: [{ tokens: 1000, cache: true }], userTokens: 600, outputTokens: 250 } as CallSpec,
    regenerateExtraTokens: 400,
  };

  it("is the extraction plus the reply", () => {
    const cost = messageCostUsd(turn, "none", false);
    expect(cost.total).toBeCloseTo(cost.extraction + cost.reply, 12);
    expect(cost.regenerate).toBe(0);
    expect(cost.extraction).toBeCloseTo(callCostUsd(turn.extraction, "none"), 12);
    expect(cost.reply).toBeCloseTo(callCostUsd(turn.reply, "none"), 12);
  });

  it("a regenerated reply is a second reply call with the first reply and the correction added to its input, and still ONE credit", () => {
    const without = messageCostUsd(turn, "none", false);
    const withRegen = messageCostUsd(turn, "none", true);
    const expected = callCostUsd({ ...turn.reply, userTokens: turn.reply.userTokens + 400 }, "none");
    expect(withRegen.regenerate).toBeCloseTo(expected, 12);
    expect(withRegen.total).toBeCloseTo(without.total + expected, 12);
  });

  it("in the write case the second reply, a moment later, reads what the first one wrote", () => {
    const written = messageCostUsd(turn, "write", true);
    const second = callCostUsd({ ...turn.reply, userTokens: turn.reply.userTokens + 400 }, "hit");
    expect(written.regenerate).toBeCloseTo(second, 12);
    expect(written.reply).toBeCloseTo(callCostUsd(turn.reply, "write"), 12);
  });

  it("with all hits it costs less than with none", () => {
    expect(messageCostUsd(turn, "hit", false).total).toBeLessThan(messageCostUsd(turn, "none", false).total);
  });
});

describe("rupees", () => {
  it("converts at the rate given", () => {
    expect(toInr(0.01, 90)).toBeCloseTo(0.9, 9);
    expect(toInr(0, 90)).toBe(0);
  });

  it("states its defaults: 90 rupees to the dollar (an assumption, not a looked-up rate) and a target of 0.35 rupees a credit", () => {
    expect(DEFAULT_USD_INR).toBe(90);
    expect(TARGET_INR_PER_CREDIT).toBe(0.35);
  });

  it("takes the rate from the flag first, then USD_INR_RATE, then the default", () => {
    expect(resolveUsdInr({ flag: "88.5", env: "91" })).toBe(88.5);
    expect(resolveUsdInr({ env: "91" })).toBe(91);
    expect(resolveUsdInr({})).toBe(90);
    expect(resolveUsdInr({ flag: undefined, env: "" })).toBe(90);
  });

  it.each(["abc", "0", "-5", "NaN", "Infinity"])("refuses a rate that is not a positive number (%s)", (bad) => {
    expect(() => resolveUsdInr({ flag: bad })).toThrow(/rate/i);
    expect(() => resolveUsdInr({ env: bad })).toThrow(/rate/i);
  });
});

describe("India days", () => {
  it("names the day in India time, not in UTC", () => {
    expect(indiaDay(new Date("2026-10-14T19:00:00Z"))).toBe("2026-10-15"); // 00:30 in India
    expect(indiaDay(new Date("2026-10-14T18:29:00Z"))).toBe("2026-10-14");
  });
});

const gen = (over: Record<string, unknown> = {}) => ({
  type: "GENERATION",
  name: "extraction_v2",
  model: HAIKU,
  startTime: "2026-10-15T05:00:00Z",
  level: "DEFAULT",
  usageDetails: { input: 1000, output: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  costDetails: { total: 0.002 },
  metadata: { role: "extraction", input_chars: 3500 },
  ...over,
});

describe("reading a Langfuse export (the format is a GUESS from what tracing.ts writes)", () => {
  it("accepts a plain array, or an object holding data or observations", () => {
    expect(parseExport([gen()])).toHaveLength(1);
    expect(parseExport({ data: [gen()] })).toHaveLength(1);
    expect(parseExport({ observations: [gen(), gen()] })).toHaveLength(2);
  });

  it("reads the model, role, tokens, cost, time, and character count of the input", () => {
    const [o] = parseExport([gen({ usageDetails: { input: 10, output: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } })]);
    expect(o).toMatchObject({ model: HAIKU, role: "extraction", usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 }, costUsd: 0.002, failed: false, inputChars: 3500 });
    expect(o.startTime.toISOString()).toBe("2026-10-15T05:00:00.000Z");
  });

  it("takes the role from the name when the metadata has none, and the cost from calculatedTotalCost when there is no costDetails", () => {
    const [o] = parseExport([gen({ name: "reply_v2", metadata: {}, costDetails: undefined, calculatedTotalCost: 0.005 })]);
    expect(o.role).toBe("reply");
    expect(o.costUsd).toBe(0.005);
  });

  it("leaves out anything that is not a generation, and an item with no usable time", () => {
    expect(parseExport([gen({ type: "SPAN" }), gen({ startTime: "not a time" }), gen()])).toHaveLength(1);
  });

  it("refuses something that is not a list of observations, with a message that says what it expected", () => {
    expect(() => parseExport({ nope: 1 })).toThrow(/array|data|observations/i);
    expect(() => parseExport("text")).toThrow(/array|data|observations/i);
  });

  it("marks an ERROR generation as failed", () => {
    expect(parseExport([gen({ level: "ERROR" })])[0].failed).toBe(true);
  });
});

describe("cost per processed message and per credit, from traces", () => {
  const day = [
    gen({ costDetails: { total: 0.002 } }), // message 1
    gen({ name: "reply_v2", model: SONNET, costDetails: { total: 0.006 }, metadata: { role: "reply" } }),
    gen({ costDetails: { total: 0.002 } }), // message 2
    gen({ name: "reply_v2", model: SONNET, costDetails: { total: 0.006 }, metadata: { role: "reply" } }),
    gen({ name: "reply_v2", model: SONNET, costDetails: { total: 0.006 }, metadata: { role: "reply" } }), // message 2 regenerated
    gen({ name: "leadcard_v1", model: SONNET, costDetails: { total: 0.01 }, metadata: { role: "summary" } }), // a handover's card, not a message
    gen({ startTime: "2026-10-14T05:00:00Z", costDetails: { total: 5 } }), // another day
  ];

  it("divides the day's extraction and reply cost by the messages it handled (one extraction each)", () => {
    const s = summariseTraces(parseExport(day), { day: "2026-10-15", usdInr: 90 });
    expect(s.messages).toBe(2);
    expect(s.totalUsd).toBeCloseTo(0.002 * 2 + 0.006 * 3, 9);
    expect(s.perMessageUsd).toBeCloseTo(s.totalUsd / 2, 9);
    expect(s.perMessageInr).toBeCloseTo((s.totalUsd / 2) * 90, 9);
    expect(s.extraReplies).toBe(1);
  });

  it("keeps a handover card's cost apart: it is not a processed message", () => {
    const s = summariseTraces(parseExport(day), { day: "2026-10-15", usdInr: 90 });
    expect(s.otherUsd).toBeCloseTo(0.01, 9);
    expect(s.totalUsd).not.toBeCloseTo(0.002 * 2 + 0.006 * 3 + 0.01, 9);
  });

  it("by default one credit is one processed message; the number of credits taken can be given instead", () => {
    const o = parseExport(day);
    const dflt = summariseTraces(o, { day: "2026-10-15", usdInr: 90 });
    expect(dflt.credits).toBe(2);
    expect(dflt.creditsAssumed).toBe(true);
    const given = summariseTraces(o, { day: "2026-10-15", usdInr: 90, credits: 4 });
    expect(given.credits).toBe(4);
    expect(given.creditsAssumed).toBe(false);
    expect(given.perCreditInr).toBeCloseTo((given.totalUsd / 4) * 90, 9);
  });

  it("says whether a credit costs less than the target", () => {
    const s = summariseTraces(parseExport(day), { day: "2026-10-15", usdInr: 90 });
    expect(s.withinTarget).toBe((s.perCreditInr ?? Infinity) <= TARGET_INR_PER_CREDIT);
    const cheap = summariseTraces(parseExport([gen({ costDetails: { total: 0.0001 } }), gen({ name: "reply_v2", model: SONNET, costDetails: { total: 0.0001 }, metadata: { role: "reply" } })]), { usdInr: 90 });
    expect(cheap.withinTarget).toBe(true);
  });

  it("without a day it takes every observation, and the day filter is in India time", () => {
    expect(summariseTraces(parseExport(day), { usdInr: 90 }).messages).toBe(3);
    const late = gen({ startTime: "2026-10-14T19:00:00Z" }); // 00:30 on the 15th in India
    expect(summariseTraces(parseExport([late]), { day: "2026-10-15", usdInr: 90 }).messages).toBe(1);
    expect(summariseTraces(parseExport([late]), { day: "2026-10-14", usdInr: 90 }).messages).toBe(0);
  });

  it("a failed call costs money but is not a message", () => {
    const s = summariseTraces(parseExport([gen({ level: "ERROR", costDetails: { total: 0.001 } }), gen()]), { usdInr: 90 });
    expect(s.messages).toBe(1);
    expect(s.totalUsd).toBeCloseTo(0.003, 9);
  });

  it("with no messages there is no average, and it says so instead of dividing by zero", () => {
    const s = summariseTraces([], { usdInr: 90 });
    expect(s.messages).toBe(0);
    expect(s.perMessageUsd).toBeNull();
    expect(s.perCreditInr).toBeNull();
    expect(s.withinTarget).toBeNull();
  });

  it("prices a generation that has no cost from its tokens, and says how many it had to", () => {
    const s = summariseTraces(parseExport([gen({ costDetails: undefined, usageDetails: { input: M, output: 0 } })]), { usdInr: 90 });
    expect(s.totalUsd).toBeCloseTo(1, 9);
    expect(s.recomputed).toBe(1);
  });

  it("reports how much of the input came from the cache, per model", () => {
    const s = summariseTraces(parseExport([gen({ usageDetails: { input: 100, output: 10, cache_read_input_tokens: 300, cache_creation_input_tokens: 100 } })]), { usdInr: 90 });
    expect(s.byModel[HAIKU]).toMatchObject({ calls: 1, inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 100 });
    expect(s.byModel[HAIKU].cacheShare).toBeCloseTo(300 / 500, 9);
  });
});

describe("calibrating the characters per token, one model at a time", () => {
  it("is the characters we sent (the fixed prompt plus the messages) over the input tokens the model reported, for each model on its own", () => {
    const o = parseExport([
      gen({ usageDetails: { input: 1000, output: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, metadata: { role: "extraction", input_chars: 500 } }),
      gen({ name: "reply_v2", model: SONNET, usageDetails: { input: 400, output: 10, cache_read_input_tokens: 600, cache_creation_input_tokens: 0 }, metadata: { role: "reply", input_chars: 1000 } }),
    ]);
    const ratios = calibrateCharsPerToken(o, { extraction: 3500, reply: 1000 });
    expect(ratios[HAIKU]).toEqual({ chars: 4000, tokens: 1000, calls: 1, charsPerToken: 4 });
    expect(ratios[SONNET]).toEqual({ chars: 2000, tokens: 1000, calls: 1, charsPerToken: 2 });
  });

  it("skips a call with no character count or a failed one", () => {
    const o = parseExport([gen({ metadata: { role: "extraction" } }), gen({ level: "ERROR" })]);
    expect(calibrateCharsPerToken(o, { extraction: 100 })).toEqual({});
  });
});

describe("where the traces come from", () => {
  it("is a file when one is given", () => {
    expect(resolveTraceSource({ file: "export.json", env: {} })).toEqual({ kind: "file", path: "export.json" });
  });

  it("is the Langfuse API when both keys are in the environment, with the default address", () => {
    const source = resolveTraceSource({ env: { LANGFUSE_PUBLIC_KEY: "pk-test", LANGFUSE_SECRET_KEY: "sk-test" } });
    expect(source).toEqual({ kind: "api", baseUrl: "https://cloud.langfuse.com", publicKey: "pk-test", secretKey: "sk-test" });
  });

  it("is nothing, with a clear message, when there is no file and no keys: and the message never shows a key", () => {
    const none = resolveTraceSource({ env: {} });
    expect(none.kind).toBe("none");
    if (none.kind === "none") expect(none.message).toMatch(/--file/);
    if (none.kind === "none") expect(none.message).toMatch(/LANGFUSE_PUBLIC_KEY/);
    const half = resolveTraceSource({ env: { LANGFUSE_PUBLIC_KEY: "pk-secret-value" } });
    expect(half.kind).toBe("none");
    expect(JSON.stringify(half)).not.toContain("pk-secret-value");
  });

  it("refuses a Langfuse address that is not https, since the keys are sent to it", () => {
    const source = resolveTraceSource({ env: { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_BASE_URL: "http://example.test" } });
    expect(source.kind).toBe("none");
    if (source.kind === "none") expect(source.message).toMatch(/https/);
  });
});

describe("fetching observations from the Langfuse API (a fake fetch: no network)", () => {
  const source = { baseUrl: "https://langfuse.example.test", publicKey: "pk-fake", secretKey: "sk-fake" };
  const page = (data: unknown[], totalPages: number) => new Response(JSON.stringify({ data, meta: { totalPages } }), { status: 200 });

  it("asks for generations of the day in India time, page by page, with the keys as basic auth", async () => {
    const fake = vi.fn().mockResolvedValueOnce(page([gen()], 2)).mockResolvedValueOnce(page([gen(), gen()], 2));
    const got = await fetchObservations(source, "2026-10-15", fake as unknown as typeof fetch);
    expect(got).toHaveLength(3);
    expect(fake).toHaveBeenCalledTimes(2);
    const first = new URL(fake.mock.calls[0][0] as string);
    expect(first.origin).toBe("https://langfuse.example.test");
    expect(first.pathname).toBe("/api/public/observations");
    expect(first.searchParams.get("type")).toBe("GENERATION");
    expect(first.searchParams.get("fromStartTime")).toBe("2026-10-14T18:30:00.000Z");
    expect(first.searchParams.get("toStartTime")).toBe("2026-10-15T18:30:00.000Z");
    expect(first.searchParams.get("page")).toBe("1");
    expect(new URL(fake.mock.calls[1][0] as string).searchParams.get("page")).toBe("2");
    const headers = (fake.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("pk-fake:sk-fake").toString("base64")}`);
  });

  it("says the HTTP status and nothing else when a call fails: never the keys or the body", async () => {
    const fake = vi.fn().mockResolvedValue(new Response("pk-fake sk-fake body", { status: 401 }));
    const failure = await fetchObservations(source, "2026-10-15", fake as unknown as typeof fetch).catch((e: unknown) => e as Error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/401/);
    expect((failure as Error).message).not.toMatch(/pk-fake|sk-fake|body/);
  });

  it("refuses an address that is not https before sending anything", async () => {
    const fake = vi.fn();
    await expect(fetchObservations({ ...source, baseUrl: "http://example.test" }, "2026-10-15", fake as unknown as typeof fetch)).rejects.toThrow(/https/);
    expect(fake).not.toHaveBeenCalled();
  });
});
