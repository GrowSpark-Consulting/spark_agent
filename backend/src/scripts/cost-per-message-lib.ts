import { z } from "zod";
import { MODELS, estimateCostUsd, type TokenUsage } from "../agent/llm/models";

// The maths behind `pnpm cost:per-message` (docs/cost-per-message.md): what a call costs with and without the prompt cache, what one processed message
// costs, rupees, and reading Langfuse traces. Pure: no model, no database, no network (the Langfuse fetch takes the `fetch` it is given). The prices are
// agent/llm/models.ts's `estimateCostUsd`, so this script and the traces cannot disagree.

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// The assumptions, each in one place
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/** Rupees to the dollar. A STATED ASSUMPTION, rounded up on purpose so the estimate does not flatter us; not a looked-up rate. Override with --usd-inr or USD_INR_RATE. */
export const DEFAULT_USD_INR = 90;
/** What one credit (one AI reply) may cost us: the target in the Day 8 task list. */
export const TARGET_INR_PER_CREDIT = 0.35;

/** Haiku 5.5 is a what-if (docs/cost-per-message.md): the agent does not use it. */
export const HAIKU_5_5 = "claude-haiku-5-5";
/** US dollars per million tokens, from https://platform.claude.com/docs/en/about-claude/pricing (prompts up to 100,000 tokens). */
const WHAT_IF_PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  [HAIKU_5_5]: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

/** The shortest prompt (in tokens) the API will cache, per model (https://platform.claude.com/docs/en/build-with-claude/prompt-caching). Under it nothing is cached and no error is returned. */
export const CACHE_MINIMUM_TOKENS: Record<string, number> = {
  [MODELS.extraction]: 4096, // Haiku 4.5
  [MODELS.reply]: 512, // Sonnet 5.5
  [HAIKU_5_5]: 512,
};

export interface CharsPerToken {
  /** English and other Latin text, tags and punctuation (our prompts). */
  latin: number;
  /** Tamil, Hindi and other Indic script. */
  indic: number;
}

// Claude 4.7 and later (Sonnet 5.5, Haiku 5.5) use a newer tokenizer that makes about 30% more tokens for the same text; Haiku 4.5 uses the older one
// (pricing page). There is no tokenizer in this repo and counting through the API is a model-service call, so these are ESTIMATES: calibrate each
// model from real traces (`--file`, which prints the ratio it finds) and pass it back in.
const OLD_TOKENIZER: CharsPerToken = { latin: 3.5, indic: 1.2 };
const NEW_TOKENIZER_FACTOR = 1.3;
const NEW_TOKENIZER: CharsPerToken = { latin: OLD_TOKENIZER.latin / NEW_TOKENIZER_FACTOR, indic: OLD_TOKENIZER.indic / NEW_TOKENIZER_FACTOR };
const DEFAULT_RATIOS: Record<string, CharsPerToken> = {
  [MODELS.extraction]: OLD_TOKENIZER,
  [MODELS.reply]: NEW_TOKENIZER,
  [HAIKU_5_5]: NEW_TOKENIZER,
};

export type Ratios = Record<string, CharsPerToken>;

export function charsPerToken(model: string, given: Ratios = {}): CharsPerToken {
  return given[model] ?? DEFAULT_RATIOS[model] ?? NEW_TOKENIZER;
}

/** A character from an Indic or other non-Latin script block (Devanagari and up): Tamil is U+0B80 to U+0BFF. */
const isIndic = (code: number) => code >= 0x0900;

/** An estimate of the tokens in a text for one model, counting Latin and Indic characters at their own ratios. */
export function estimateTokens(text: string, model: string, given: Ratios = {}): number {
  const ratio = charsPerToken(model, given);
  let latin = 0;
  let indic = 0;
  for (const char of text) {
    if (isIndic(char.codePointAt(0) ?? 0)) indic++;
    else latin++;
  }
  return Math.ceil(latin / ratio.latin + indic / ratio.indic);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Pricing and the cache
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/** The estimated cost of one call in US dollars: the agent's own table, or the what-if table; null for a model with no price. */
export function priceUsd(model: string, usage: TokenUsage): number | null {
  const known = estimateCostUsd(model, usage);
  if (known !== null) return known;
  const price = Object.hasOwn(WHAT_IF_PRICES, model) ? WHAT_IF_PRICES[model] : undefined;
  if (!price) return null;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output + usage.cacheReadTokens * price.cacheRead + usage.cacheWriteTokens * price.cacheWrite) / 1_000_000;
}

export interface Block {
  tokens: number;
  /** A cache breakpoint ends this block: the API caches the prompt up to and including it. */
  cache: boolean;
}

/**
 * For each breakpoint, how long the prompt is up to and including it, and whether that is long enough to be cached. A breakpoint whose prefix is under
 * the model's minimum caches nothing, silently; a later, longer one still can.
 */
export function cacheVerdicts(blocks: Block[], minimum: number): { index: number; cumulativeTokens: number; caches: boolean }[] {
  const verdicts: { index: number; cumulativeTokens: number; caches: boolean }[] = [];
  let cumulative = 0;
  blocks.forEach((block, index) => {
    cumulative += block.tokens;
    if (block.cache) verdicts.push({ index, cumulativeTokens: cumulative, caches: cumulative >= minimum });
  });
  return verdicts;
}

/** The tokens that are cached: the prefix up to the longest breakpoint that reaches the minimum, or 0. */
export function cachedPrefixTokens(blocks: Block[], minimum: number): number {
  return Math.max(0, ...cacheVerdicts(blocks, minimum).filter((v) => v.caches).map((v) => v.cumulativeTokens));
}

export type CacheMode = "none" | "hit" | "write";

export interface CallSpec {
  model: string;
  /** The system prompt, in blocks, in order. */
  blocks: Block[];
  /** The tokens after the system prompt: the user turn. */
  userTokens: number;
  outputTokens: number;
}

/** The tokens one call is billed for. `none`: the cache is not used. `hit`: the cached prefix is read. `write`: it is written (the first call, or one after the cache expired). */
export function callUsage(call: CallSpec, mode: CacheMode): TokenUsage {
  const total = call.blocks.reduce((sum, block) => sum + block.tokens, 0) + call.userTokens;
  const cached = mode === "none" ? 0 : cachedPrefixTokens(call.blocks, CACHE_MINIMUM_TOKENS[call.model] ?? Infinity);
  return {
    inputTokens: total - cached,
    outputTokens: call.outputTokens,
    cacheReadTokens: mode === "hit" ? cached : 0,
    cacheWriteTokens: mode === "write" ? cached : 0,
  };
}

export function callCostUsd(call: CallSpec, mode: CacheMode): number {
  const cost = priceUsd(call.model, callUsage(call, mode));
  if (cost === null) throw new Error(`no price for ${call.model}`);
  return cost;
}

export interface ReplyParts {
  /** The fixed system prompt (the rules and the persona), as cached, written or plain input depending on the case. */
  cachedPrompt: number;
  /** The knowledge-base facts in the user turn. */
  knowledge: number;
  /** The conversation in the user turn. */
  history: number;
  /** The rest of the user turn: the task and the questions to ask. */
  other: number;
  /** The answer, thinking included. */
  output: number;
  total: number;
}

/**
 * One call's cost split by what the tokens are: where to cut to make it cheaper. The user turn is split by the tokens of the knowledge-base facts and of the
 * conversation; the rest of it (task, questions to ask) is "other". The parts add up to `callCostUsd`.
 */
export function breakdownCostUsd(call: CallSpec, split: { knowledgeTokens: number; historyTokens: number }, mode: CacheMode): ReplyParts {
  const price = (usage: Partial<TokenUsage>) => {
    const cost = priceUsd(call.model, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...usage });
    if (cost === null) throw new Error(`no price for ${call.model}`);
    return cost;
  };
  const system = call.blocks.reduce((sum, block) => sum + block.tokens, 0);
  const cached = mode === "none" ? 0 : cachedPrefixTokens(call.blocks, CACHE_MINIMUM_TOKENS[call.model] ?? Infinity);
  const cachedPrompt = price({ inputTokens: system - cached, cacheReadTokens: mode === "hit" ? cached : 0, cacheWriteTokens: mode === "write" ? cached : 0 });
  const knowledge = price({ inputTokens: split.knowledgeTokens });
  const history = price({ inputTokens: split.historyTokens });
  const other = price({ inputTokens: Math.max(0, call.userTokens - split.knowledgeTokens - split.historyTokens) });
  const output = price({ outputTokens: call.outputTokens });
  return { cachedPrompt, knowledge, history, other, output, total: cachedPrompt + knowledge + history + other + output };
}

/** The share of calls that must be cache hits for the cache to cost the same as no cache at all (a miss pays the write price). Null when the cache does nothing for this call. */
export function breakEvenHitRate(call: CallSpec): number | null {
  const none = callCostUsd(call, "none");
  const write = callCostUsd(call, "write");
  const hit = callCostUsd(call, "hit");
  if (write === none && hit === none) return null;
  return (write - none) / (write - hit);
}

export interface TurnSpec {
  extraction: CallSpec;
  reply: CallSpec;
  /** Tokens a regenerated reply adds to its input: the first reply and the correction. */
  regenerateExtraTokens: number;
}

export interface MessageCost {
  extraction: number;
  reply: number;
  regenerate: number;
  total: number;
}

/**
 * One processed message: the extraction, the reply, and with `regenerate` a second reply call (the post-check refused the first). A regenerate is not a
 * second credit. In the `write` case the second reply comes moments after the first, so it reads what the first wrote.
 */
export function messageCostUsd(turn: TurnSpec, mode: CacheMode, regenerate: boolean): MessageCost {
  const extraction = callCostUsd(turn.extraction, mode);
  const reply = callCostUsd(turn.reply, mode);
  const second = { ...turn.reply, userTokens: turn.reply.userTokens + turn.regenerateExtraTokens };
  const regenerated = regenerate ? callCostUsd(second, mode === "write" ? "hit" : mode) : 0;
  return { extraction, reply, regenerate: regenerated, total: extraction + reply + regenerated };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Rupees
// ---------------------------------------------------------------------------------------------------------------------------------------------------

export const toInr = (usd: number, usdInr: number): number => usd * usdInr;

/** The rate: the flag, then USD_INR_RATE, then the default. A rate that is not a positive number is refused, never guessed at. */
export function resolveUsdInr({ flag, env }: { flag?: string; env?: string }): number {
  const raw = [flag, env].find((value) => value !== undefined && value.trim() !== "");
  if (raw === undefined) return DEFAULT_USD_INR;
  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`The USD to INR rate must be a positive number (got "${raw.slice(0, 20)}").`);
  return rate;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Traces
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/** The day (YYYY-MM-DD) a moment falls on in India time, the day the business counts in. */
export function indiaDay(date: Date): string {
  return new Date(date.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

export type Role = "extraction" | "reply" | "summary" | "other";

export interface Observation {
  name: string;
  model: string;
  role: Role;
  startTime: Date;
  usage: TokenUsage;
  costUsd: number | null;
  failed: boolean;
  /** The characters of the messages sent (not the fixed system prompt): tracing.ts writes it as metadata.input_chars. */
  inputChars: number | null;
}

// THE FORMAT IS A GUESS. It is what tracing.ts writes (a generation with usageDetails, costDetails and metadata) shaped like Langfuse's observations
// export, read leniently: usage under `usageDetails` or `usage`, cost under `costDetails.total`, `calculatedTotalCost` or `totalCost`. It has not been
// checked against a real export, because there is no Langfuse access yet. If a real export differs, change `normalise` here and its tests.
const Raw = z.looseObject({
  type: z.string().optional(),
  name: z.string().optional(),
  model: z.string().nullish(),
  startTime: z.string().optional(),
  level: z.string().nullish(),
  usageDetails: z.record(z.string(), z.number()).nullish(),
  usage: z.record(z.string(), z.number().nullable()).nullish(),
  costDetails: z.record(z.string(), z.number()).nullish(),
  calculatedTotalCost: z.number().nullish(),
  totalCost: z.number().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});

function roleOf(raw: z.infer<typeof Raw>): Role {
  const fromMetadata = raw.metadata?.role;
  const label = typeof fromMetadata === "string" ? fromMetadata : (raw.name ?? "");
  if (label.startsWith("extraction")) return "extraction";
  if (label.startsWith("reply")) return "reply";
  if (label.startsWith("summary") || label.startsWith("leadcard")) return "summary";
  return "other";
}

function normalise(item: unknown): Observation | null {
  const parsed = Raw.safeParse(item);
  if (!parsed.success) return null;
  const raw = parsed.data;
  if (raw.type !== undefined && raw.type !== "GENERATION") return null;
  const startTime = raw.startTime ? new Date(raw.startTime) : null;
  if (!startTime || Number.isNaN(startTime.getTime())) return null;
  const usage = raw.usageDetails ?? raw.usage ?? {};
  const count = (key: string, alternative?: string) => usage[key] ?? (alternative ? usage[alternative] : undefined) ?? 0;
  const chars = raw.metadata?.input_chars;
  return {
    name: raw.name ?? "",
    model: raw.model ?? "",
    role: roleOf(raw),
    startTime,
    usage: {
      inputTokens: count("input", "promptTokens"),
      outputTokens: count("output", "completionTokens"),
      cacheReadTokens: count("cache_read_input_tokens"),
      cacheWriteTokens: count("cache_creation_input_tokens"),
    },
    costUsd: raw.costDetails?.total ?? raw.calculatedTotalCost ?? raw.totalCost ?? null,
    failed: raw.level === "ERROR",
    inputChars: typeof chars === "number" ? chars : null,
  };
}

/** The generations in a Langfuse export: a list, or an object holding it under `data` or `observations`. Anything else is refused. */
export function parseExport(json: unknown): Observation[] {
  const list = Array.isArray(json) ? json : typeof json === "object" && json !== null ? ((json as Record<string, unknown>).data ?? (json as Record<string, unknown>).observations) : undefined;
  if (!Array.isArray(list)) throw new Error("Expected a JSON array of observations, or an object with the array under `data` or `observations`.");
  return list.flatMap((item) => normalise(item) ?? []);
}

export interface ModelTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Cache reads over all input tokens (fresh, read and written). */
  cacheShare: number;
}

export interface TraceSummary {
  day: string | null;
  usdInr: number;
  /** Processed messages: the extraction calls that did not fail. */
  messages: number;
  /** Extraction and reply cost of the whole day. */
  totalUsd: number;
  /** Replies beyond one per message: regenerates (or messages that got no reply). */
  extraReplies: number;
  /** Handover cards and anything else that is not a processed message. */
  otherUsd: number;
  recomputed: number;
  credits: number;
  creditsAssumed: boolean;
  perMessageUsd: number | null;
  perMessageInr: number | null;
  perCreditUsd: number | null;
  perCreditInr: number | null;
  withinTarget: boolean | null;
  byModel: Record<string, ModelTotals>;
}

export function summariseTraces(observations: Observation[], options: { day?: string; usdInr: number; credits?: number }): TraceSummary {
  const day = options.day ?? null;
  const chosen = observations.filter((o) => day === null || indiaDay(o.startTime) === day);
  let totalUsd = 0;
  let otherUsd = 0;
  let recomputed = 0;
  let messages = 0;
  let replies = 0;
  const byModel: Record<string, ModelTotals> = {};

  for (const o of chosen) {
    let cost = o.costUsd;
    if (cost === null) {
      cost = priceUsd(o.model, o.usage) ?? 0;
      recomputed++;
    }
    if (o.role === "extraction" || o.role === "reply") {
      totalUsd += cost;
      if (o.role === "extraction" && !o.failed) messages++;
      if (o.role === "reply" && !o.failed) replies++;
    } else otherUsd += cost;

    const totals = (byModel[o.model] ??= { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheShare: 0 });
    totals.calls++;
    totals.inputTokens += o.usage.inputTokens;
    totals.outputTokens += o.usage.outputTokens;
    totals.cacheReadTokens += o.usage.cacheReadTokens;
    totals.cacheWriteTokens += o.usage.cacheWriteTokens;
  }
  for (const totals of Object.values(byModel)) {
    const input = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
    totals.cacheShare = input === 0 ? 0 : totals.cacheReadTokens / input;
  }

  const creditsAssumed = options.credits === undefined;
  const credits = options.credits ?? messages;
  const perMessageUsd = messages > 0 ? totalUsd / messages : null;
  const perCreditUsd = credits > 0 ? totalUsd / credits : null;
  const perCreditInr = perCreditUsd === null ? null : toInr(perCreditUsd, options.usdInr);
  return {
    day,
    usdInr: options.usdInr,
    messages,
    totalUsd,
    extraReplies: Math.max(0, replies - messages),
    otherUsd,
    recomputed,
    credits,
    creditsAssumed,
    perMessageUsd,
    perMessageInr: perMessageUsd === null ? null : toInr(perMessageUsd, options.usdInr),
    perCreditUsd,
    perCreditInr,
    withinTarget: perCreditInr === null ? null : perCreditInr <= TARGET_INR_PER_CREDIT,
    byModel,
  };
}

export interface Calibration {
  chars: number;
  tokens: number;
  calls: number;
  charsPerToken: number;
}

/**
 * Characters per token for each model, from calls that have a character count: (the fixed prompt's characters, given per role, plus the characters of the
 * messages) over every input token the call reported (fresh, read and written). It is one blended figure for mixed English text and tags: pass it back as
 * the model's `latin` ratio. Tamil-heavy traffic will pull it down.
 */
export function calibrateCharsPerToken(observations: Observation[], systemChars: Partial<Record<Role, number>>): Record<string, Calibration> {
  const found: Record<string, Calibration> = {};
  for (const o of observations) {
    const fixed = systemChars[o.role];
    const tokens = o.usage.inputTokens + o.usage.cacheReadTokens + o.usage.cacheWriteTokens;
    if (o.failed || o.inputChars === null || fixed === undefined || tokens <= 0) continue;
    const entry = (found[o.model] ??= { chars: 0, tokens: 0, calls: 0, charsPerToken: 0 });
    entry.chars += fixed + o.inputChars;
    entry.tokens += tokens;
    entry.calls++;
    entry.charsPerToken = entry.chars / entry.tokens;
  }
  return found;
}

export type TraceSource =
  | { kind: "file"; path: string }
  | { kind: "api"; baseUrl: string; publicKey: string; secretKey: string }
  | { kind: "none"; message: string };

const DEFAULT_LANGFUSE_URL = "https://cloud.langfuse.com";
const NO_SOURCE = "No traces to read. Give an export with --file <langfuse-export.json>, or set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY (and optionally LANGFUSE_BASE_URL, https only) to read the Langfuse API. Nothing was read and nothing was sent.";

/** Where the traces come from: a file if one is given, else the Langfuse API if both keys are set, else nothing (said plainly; never an error, and never a key in the message). */
export function resolveTraceSource({ file, env }: { file?: string; env: Record<string, string | undefined> }): TraceSource {
  if (file) return { kind: "file", path: file };
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim();
  if (!publicKey || !secretKey) return { kind: "none", message: NO_SOURCE };
  const baseUrl = (env.LANGFUSE_BASE_URL?.trim() || DEFAULT_LANGFUSE_URL).replace(/\/+$/, "");
  if (!baseUrl.startsWith("https://")) return { kind: "none", message: "LANGFUSE_BASE_URL must be an https address: the keys are sent to it. Nothing was read and nothing was sent." };
  return { kind: "api", baseUrl, publicKey, secretKey };
}

const PAGE_SIZE = 100;
const MAX_PAGES = 200;
const Page = z.object({ data: z.array(z.unknown()), meta: z.object({ totalPages: z.number() }).partial().optional() });

/**
 * The generations of one India day from the Langfuse API (GET /api/public/observations, paged, basic auth). UNVERIFIED against the real API: there is no
 * access yet, so the path, the parameters and the paging follow Langfuse's public docs from memory. A failure says the HTTP status and nothing else.
 */
export async function fetchObservations(source: { baseUrl: string; publicKey: string; secretKey: string }, day: string, fetchImpl: typeof fetch = fetch): Promise<Observation[]> {
  if (!source.baseUrl.startsWith("https://")) throw new Error("The Langfuse address must be https: the keys are sent to it.");
  const start = new Date(`${day}T00:00:00.000Z`).getTime() - 330 * 60_000;
  const from = new Date(start).toISOString();
  const to = new Date(start + 24 * 3_600_000).toISOString();
  const headers = { Authorization: `Basic ${Buffer.from(`${source.publicKey}:${source.secretKey}`).toString("base64")}` };
  const all: Observation[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL("/api/public/observations", source.baseUrl);
    url.search = new URLSearchParams({ type: "GENERATION", fromStartTime: from, toStartTime: to, page: String(page), limit: String(PAGE_SIZE) }).toString();
    const response = await fetchImpl(url.toString(), { headers });
    if (!response.ok) throw new Error(`The Langfuse API answered HTTP ${response.status}.`);
    const body = Page.parse(await response.json());
    all.push(...parseExport(body.data));
    if (page >= (body.meta?.totalPages ?? 1)) break;
  }
  return all;
}
