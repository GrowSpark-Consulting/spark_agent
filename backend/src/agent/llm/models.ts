// The two models the agent talks to (docs/handover.md, module 2: a fast model for extraction, a strong one for
// replies), what each kind of call is allowed to take, and an estimate of what a call costs. One file, so a
// model is changed in one place and a typo cannot be spread over several.

/** Exact ids: Haiku 4.5 (a dated snapshot) and Sonnet 5.5 (no date suffix). */
export const MODELS = {
  extraction: "claude-haiku-4-5-20251001",
  reply: "claude-sonnet-5-5",
  // The lead card staff read when a chat needs a person (Day 4): the same strong model, since it may write a reply in Tamil script.
  summary: "claude-sonnet-5-5",
} as const;

export type LlmRole = keyof typeof MODELS;
export type ModelId = (typeof MODELS)[LlmRole];

export interface RoleSettings {
  model: ModelId;
  maxTokens: number;
  /** Only where the model allows it: Haiku 4.5 does; Sonnet 5.5 refuses a non-default value. */
  temperature?: number;
  /** Only where the model has the setting: Sonnet 5.5 does; Haiku 4.5 refuses it. "low" is for chat-length replies. */
  effort?: "low" | "medium" | "high";
  /** One try. A try that has not answered by then is cut off and, if it is worth it, tried again. */
  attemptTimeoutMs: number;
  /** All tries together, whatever the caller's own deadline says. */
  totalTimeoutMs: number;
}

export const ROLE_SETTINGS: Record<LlmRole, RoleSettings> = {
  // A JSON answer with a handful of fields. Deterministic.
  extraction: { model: MODELS.extraction, maxTokens: 1024, temperature: 0, attemptTimeoutMs: 8_000, totalTimeoutMs: 20_000 },
  // Under 600 characters of text, which in Tamil script is more tokens than in English; thinking also counts
  // against max_tokens, so there is room for both.
  reply: { model: MODELS.reply, maxTokens: 2_000, effort: "low", attemptTimeoutMs: 15_000, totalTimeoutMs: 25_000 },
  // A JSON card with a short summary and a reply of under 400 characters, which in Tamil script is many tokens.
  summary: { model: MODELS.summary, maxTokens: 2_000, effort: "low", attemptTimeoutMs: 15_000, totalTimeoutMs: 25_000 },
};

export interface TokenUsage {
  /** Input tokens that were neither read from nor written to the cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

// US dollars per million tokens (https://docs.anthropic.com/en/docs/about-claude/pricing). Cache reads are a
// tenth of the input price; writes (5 minute cache) a quarter more. An ESTIMATE for tracing and budgeting:
// the invoice is the truth.
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  [MODELS.extraction]: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  [MODELS.reply]: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};

/** The estimated cost of one call in US dollars, or null for a model with no price here. */
export function estimateCostUsd(model: string, usage: TokenUsage): number | null {
  const price = Object.hasOwn(PRICES, model) ? PRICES[model] : undefined;
  if (!price) return null;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output + usage.cacheReadTokens * price.cacheRead + usage.cacheWriteTokens * price.cacheWrite) / 1_000_000;
}
