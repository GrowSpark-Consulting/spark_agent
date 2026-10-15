import { buildExtractionMessages, buildExtractionSystem } from "../agent/prompts/extraction_v2";
import { buildReplyMessages, buildReplySystem } from "../agent/prompts/reply_v2";
import { MODELS } from "../agent/llm/models";
import type { PackDefinition } from "@pakka/types";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultPacksDir } from "../agent/packs/sync";
import {
  CACHE_MINIMUM_TOKENS,
  DEFAULT_USD_INR,
  HAIKU_5_5,
  TARGET_INR_PER_CREDIT,
  breakEvenHitRate,
  breakdownCostUsd,
  cacheVerdicts,
  cachedPrefixTokens,
  callCostUsd,
  estimateTokens,
  messageCostUsd,
  toInr,
  type Block,
  type CacheMode,
  type CallSpec,
  type MessageCost,
  type Ratios,
  type ReplyParts,
  type TurnSpec,
} from "./cost-per-message-lib";

// The offline estimate of `pnpm cost:per-message`: the REAL prompts (the builders in agent/prompts, the real-estate pack's fields) with typical customer
// messages and knowledge-base text, token counts estimated from characters (cost-per-message-lib.ts), priced with the agent's own price table. No model is called.

export interface OfflineOptions {
  usdInr?: number;
  /** Knowledge-base chunks handed to the reply as facts (the search returns up to 5 above the similarity cut-off). */
  kbChunks?: number;
  /** Characters of each chunk (a chunk is cut to 1,500 in the prompt). */
  kbChunkChars?: number;
  /** Characters per token for a model, as calibrated from traces. */
  ratios?: Ratios;
  /** The pack whose fields go into the extraction prompt (packs/<key>.json). */
  pack?: string;
}

/** The pack of the demo business the knowledge-base samples below come from (docs/demo-script.md). */
const DEMO_PACK = "real-estate";

/** The knowledge-base answers the demo script's appendix asks the owner to add: typical text for a price question. */
const KB_SAMPLE = [
  "Skyline Towers in Velachery has 2 and 3 BHK apartments near Velachery station, ready to move in. Total prices are from ₹65 lakh up to ₹90 lakh.",
  "Green Meadows on OMR has 1, 2 and 3 BHK homes, with handover in 2027. Total prices are from ₹45 lakh up to ₹70 lakh.",
  "Lake View Residency in Tambaram has 2 BHK apartments by the lake, ready to move in. Total prices are from ₹35 lakh up to ₹55 lakh.",
  "We have projects in Velachery, OMR and Tambaram.",
  "Site visits take about an hour. Our site executives are available Monday to Saturday from 10:00 am to 6:00 pm and on Sunday from 10:00 am to 1:00 pm.",
];

const sampleChunk = (index: number, chars: number): string => {
  let text = "";
  for (let i = 0; text.length < chars; i++) text += `${KB_SAMPLE[(index + i) % KB_SAMPLE.length]} `;
  return text.trim().slice(0, chars);
};

const EXTRACTION_OUTPUT = '{"language":"en","intent":"qualify","fields":{"bhk":"2BHK","area":"Velachery","budget":"60 lakh","timeline":"within 3 months"},"question":null,"sentiment":"neutral","confidence":0.92}';

interface Sample {
  name: string;
  message: string;
  recent: { sender: "customer" | "ai"; text: string }[];
  language: "en" | "ta";
  replyText: string;
}

const SAMPLES: Sample[] = [
  {
    name: "English",
    message: "I want a 2BHK in Velachery, my budget is around 60 lakh and I plan to buy within 3 months",
    recent: [
      { sender: "customer", text: "hi" },
      { sender: "ai", text: "Hi! Welcome to Spark Agent Demo. How can I help you today?" },
      { sender: "customer", text: "What is the price of a 2BHK in Velachery?" },
    ],
    language: "en",
    replyText:
      "Skyline Towers in Velachery has 2 and 3 BHK homes, ready to move in, from ₹65 lakh to ₹90 lakh in total. Your budget of around 60 lakh is a little below that range, but there may be options in Tambaram from ₹35 lakh. Would you like to visit a site this week?",
  },
  {
    name: "Tamil script",
    message: "வேளச்சேரியில் 2BHK வீடு வேண்டும், என் பட்ஜெட் சுமார் 60 லட்சம், 3 மாதத்திற்குள் வாங்க திட்டமிடுகிறேன்",
    recent: [
      { sender: "customer", text: "வணக்கம்" },
      { sender: "ai", text: "வணக்கம்! ஸ்பார்க் ஏஜென்ட் டெமோவுக்கு வரவேற்கிறோம். உங்களுக்கு எப்படி உதவலாம்?" },
      { sender: "customer", text: "வேளச்சேரியில் 2BHK வீட்டின் விலை என்ன?" },
    ],
    language: "ta",
    replyText:
      "வேளச்சேரியில் ஸ்கைலைன் டவர்ஸ் திட்டத்தில் 2 மற்றும் 3 BHK வீடுகள் உள்ளன, உடனே குடியேறலாம். மொத்த விலை ₹65 லட்சம் முதல் ₹90 லட்சம் வரை. உங்கள் பட்ஜெட் இதற்குச் சற்று குறைவு, தாம்பரத்தில் ₹35 லட்சம் முதல் வீடுகள் உள்ளன. இந்த வாரம் தளத்தைப் பார்க்க விரும்புகிறீர்களா?",
  },
];

/** What the post-check's correction message adds to a regenerated reply's input (postcheck's text is about this long), in characters. */
const CORRECTION_CHARS = 300;
/** Thinking tokens a Sonnet 5.5 reply is assumed to spend at effort "low", on top of the visible message (they are billed as output). */
const REPLY_THINKING_TOKENS = 100;

export interface CaseCost extends MessageCost {
  totalInr: number;
  perCreditInr: number;
  withinTarget: boolean;
}

export interface ScenarioReport {
  name: string;
  extraction: CallSpec;
  reply: CallSpec;
  /** One processed message with no regenerate, under each cache case. */
  cases: Record<CacheMode, CaseCost>;
  /** The same with one regenerated reply (still one credit). */
  regenerate: Record<CacheMode, CaseCost>;
  /** The Sonnet reply's cost by part, under each cache case: which part to shrink. */
  replyParts: Record<CacheMode, ReplyParts>;
  /** The share of calls that must hit the cache for it to cost no more than no cache. */
  breakEven: { extraction: number | null; reply: number | null };
  /** Extraction on Haiku 5.5, a what-if: nothing in the agent uses it. */
  haiku55: { extractionNone: number; extractionHit: number; totalNone: number; totalHit: number };
}

export interface CacheCheck {
  model: string;
  minimum: number;
  verdicts: { index: number; cumulativeTokens: number; caches: boolean }[];
  /** The system prompt's length up to its last breakpoint. */
  totalCachedPrefixTokens: number;
  /** What the API would actually cache of it: all of it, or nothing. */
  cachedTokens: number;
  /** The token count is an estimate good to roughly 15%: a prompt that close to the minimum may land on either side. */
  borderline: boolean;
}

const BORDERLINE = 0.15;

export interface OfflineReport {
  usdInr: number;
  targetInr: number;
  whatIfModel: string;
  extraction: CallSpec;
  reply: CallSpec;
  scenarios: ScenarioReport[];
  cacheChecks: CacheCheck[];
  assumptions: string[];
  /** The system prompts' characters, for calibrating from traces. */
  systemChars: { extraction: number; reply: number };
}

export function buildOfflineReport(options: OfflineOptions = {}): OfflineReport {
  const usdInr = options.usdInr ?? DEFAULT_USD_INR;
  const kbChunks = options.kbChunks ?? 3;
  const kbChunkChars = options.kbChunkChars ?? 600;
  const ratios = options.ratios ?? {};
  const pack = JSON.parse(readFileSync(join(defaultPacksDir(), `${options.pack ?? DEMO_PACK}.json`), "utf8")) as PackDefinition;
  const facts = Array.from({ length: kbChunks }, (_, i) => sampleChunk(i, Math.min(kbChunkChars, 1500)));

  const extractionSystem = buildExtractionSystem(pack);
  const replySystem = buildReplySystem({ businessName: "Spark Agent Demo", tone: "friendly" });
  const blocksFor = (system: { text: string; cache?: boolean }[], model: string): Block[] => system.map((b) => ({ tokens: estimateTokens(b.text, model, ratios), cache: b.cache === true }));
  const tokens = (text: string, model: string) => estimateTokens(text, model, ratios);

  const buildTurn = (sample: Sample, extractionModel: string): { turn: TurnSpec; split: { knowledgeTokens: number; historyTokens: number } } => {
    const extractionUser = buildExtractionMessages({ message: sample.message, recent: sample.recent, known: { bhk: "2BHK" } })[0].content;
    const replyUser = buildReplyMessages({
      action: { kind: "answer_and_ask", question: sample.message, askFields: ["budget"] },
      facts,
      askFields: [{ label: "Budget" }],
      history: [...sample.recent, { sender: "customer", text: sample.message }],
      language: sample.language,
    })[0].content;
    const extraction: CallSpec = {
      model: extractionModel,
      blocks: blocksFor(extractionSystem, extractionModel),
      userTokens: tokens(extractionUser, extractionModel),
      outputTokens: tokens(EXTRACTION_OUTPUT, extractionModel),
    };
    const reply: CallSpec = {
      model: MODELS.reply,
      blocks: blocksFor(replySystem, MODELS.reply),
      userTokens: tokens(replyUser, MODELS.reply),
      outputTokens: tokens(sample.replyText, MODELS.reply) + REPLY_THINKING_TOKENS,
    };
    const section = (tag: string) => {
      const start = replyUser.indexOf(`<${tag}>`);
      const end = replyUser.indexOf(`</${tag}>`);
      return start >= 0 && end > start ? replyUser.slice(start, end + tag.length + 3) : "";
    };
    const split = { knowledgeTokens: tokens(section("facts"), MODELS.reply), historyTokens: tokens(section("conversation"), MODELS.reply) };
    return { split, turn: { extraction, reply, regenerateExtraTokens: tokens(sample.replyText, MODELS.reply) + tokens("x".repeat(CORRECTION_CHARS), MODELS.reply) } };
  };

  const rupees = (cost: MessageCost): CaseCost => {
    const perCreditInr = toInr(cost.total, usdInr); // one credit per processed message, a regenerate included
    return { ...cost, totalInr: perCreditInr, perCreditInr, withinTarget: perCreditInr <= TARGET_INR_PER_CREDIT };
  };
  const modes: CacheMode[] = ["none", "hit", "write"];

  const scenarios: ScenarioReport[] = SAMPLES.map((sample) => {
    const { turn, split } = buildTurn(sample, MODELS.extraction);
    const { turn: what } = buildTurn(sample, HAIKU_5_5);
    const cases = Object.fromEntries(modes.map((m) => [m, rupees(messageCostUsd(turn, m, false))])) as Record<CacheMode, CaseCost>;
    const regenerate = Object.fromEntries(modes.map((m) => [m, rupees(messageCostUsd(turn, m, true))])) as Record<CacheMode, CaseCost>;
    const whatNone = callCostUsd(what.extraction, "none");
    const whatHit = callCostUsd(what.extraction, "hit");
    return {
      name: sample.name,
      extraction: turn.extraction,
      reply: turn.reply,
      cases,
      regenerate,
      replyParts: Object.fromEntries(modes.map((m) => [m, breakdownCostUsd(turn.reply, split, m)])) as Record<CacheMode, ReplyParts>,
      breakEven: { extraction: breakEvenHitRate(turn.extraction), reply: breakEvenHitRate(turn.reply) },
      haiku55: { extractionNone: whatNone, extractionHit: whatHit, totalNone: whatNone + cases.none.reply, totalHit: whatHit + cases.hit.reply },
    };
  });

  const first = scenarios[0];
  const check = (model: string, blocks: Block[]): CacheCheck => ({
    model,
    minimum: CACHE_MINIMUM_TOKENS[model],
    verdicts: cacheVerdicts(blocks, CACHE_MINIMUM_TOKENS[model]),
    totalCachedPrefixTokens: Math.max(0, ...cacheVerdicts(blocks, 0).map((v) => v.cumulativeTokens)),
    cachedTokens: cachedPrefixTokens(blocks, CACHE_MINIMUM_TOKENS[model]),
    borderline: Math.abs(Math.max(0, ...cacheVerdicts(blocks, 0).map((v) => v.cumulativeTokens)) / CACHE_MINIMUM_TOKENS[model] - 1) <= BORDERLINE,
  });

  return {
    usdInr,
    targetInr: TARGET_INR_PER_CREDIT,
    whatIfModel: HAIKU_5_5,
    extraction: first.extraction,
    reply: first.reply,
    scenarios,
    cacheChecks: [check(MODELS.extraction, first.extraction.blocks), check(MODELS.reply, first.reply.blocks)],
    systemChars: {
      extraction: extractionSystem.reduce((sum, b) => sum + b.text.length, 0),
      reply: replySystem.reduce((sum, b) => sum + b.text.length, 0),
    },
    assumptions: [
      `Tokens are ESTIMATED from characters per token (there is no tokenizer here and the API's counter is a model-service call): Haiku 4.5 3.5 for English and 1.2 for Tamil script; Sonnet 5.5 and Haiku 5.5 about 30% more tokens (3.5/1.3 and 1.2/1.3), because Claude 4.7 and later use a newer tokenizer. Calibrate each from traces with --file.`,
      `Prices are llm/models.ts's table (Haiku 4.5 $1 in / $5 out; Sonnet 5.5 $2 in / $10 out, cache reads $0.10, writes 1.25x); Haiku 5.5 $0.10 / $0.50 is a what-if.`,
      `Rupees at ${usdInr} to the dollar: a stated assumption, not a looked-up rate. One credit is one AI reply; a regenerated reply is a second model call, not a second credit.`,
      `The turn: ${kbChunks} knowledge-base chunks of ${Math.min(kbChunkChars, 1500)} characters (the demo's answers), 3 earlier messages, a reply of about ${SAMPLES[0].replyText.length} characters (Tamil ${SAMPLES[1].replyText.length}) plus ${REPLY_THINKING_TOKENS} thinking tokens, an extraction answer of ${EXTRACTION_OUTPUT.length} characters.`,
      `Cache cases are the two ends: every call a hit (busy chat, within the 5-minute lifetime) or every call a write (quiet, each call after the cache expired). Real traffic is in between; "break-even" says what share of hits is needed.`,
      `A regenerate is one more reply call with the first reply and a ${CORRECTION_CHARS}-character correction added. A second extraction try (bad JSON) is not counted.`,
    ],
  };
}
