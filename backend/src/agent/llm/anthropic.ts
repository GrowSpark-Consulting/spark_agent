import Anthropic, { type APIError } from "@anthropic-ai/sdk";
import { z } from "zod";
import { stripUnsafeCharacters } from "../../lib/text";
import { estimateCostUsd, MODELS, ROLE_SETTINGS, type LlmRole, type RoleSettings, type TokenUsage } from "./models";

// The one place the agent calls Anthropic (docs/handover.md, module 2: step 4 extraction on Haiku, step 7
// reply on Sonnet). It owns the things every call needs, so no caller repeats them:
//
// - A deadline on every try and on the call as a whole, and the caller's own deadline (the turn's) on top.
// - Retries only for what waiting can fix (429, 5xx, a dropped connection, a try that timed out), at most
//   three tries with growing waits (or the provider's Retry-After, capped). A 4xx means the request is wrong:
//   it fails at once, with the status kept. A refusal or an answer cut off by the token limit is never text
//   to send on: each is its own error.
// - Prompt caching on the parts of the system prompt the caller marks as fixed.
// - Nothing a customer wrote, no key and no provider message in an error or a log line: errors carry a code,
//   a status and fixed words, and logs carry the code and the status.
// - One trace record per call (see tracing.ts), which can never change the answer.

export interface SystemBlock {
  text: string;
  /** Fixed text (rules, a business's pack): the API caches the prompt up to and including this block. */
  cache?: boolean;
}
export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}
export interface LlmRequest {
  role: LlmRole;
  /** The prompt's own name and version (src/agent/prompts): they go on the trace. */
  prompt: { name: string; version: number };
  /** The business this call is for: always on the trace. Comes from server context, never from a customer. */
  tenantId: string;
  conversationId?: string;
  /** Fixed parts first (cached), the parts that change last. */
  system: SystemBlock[];
  messages: LlmMessage[];
  maxTokens?: number;
  /**
   * The caller's deadline (a turn's). When it passes the call stops, nothing is retried, and the error is `aborted`.
   * A turn that calls the model twice (extraction, then reply) should pass ONE signal for the whole turn: each call
   * also has its own deadline (20 s, 25 s), which alone would allow 45 s in all.
   */
  signal?: AbortSignal;
}

export interface LlmResult {
  text: string;
  model: string;
  stopReason: string;
  usage: TokenUsage;
  /** An estimate in US dollars; null for a model with no price in models.ts. */
  costUsd: number | null;
  latencyMs: number;
  attempts: number;
  requestId: string | null;
}

export type LlmErrorCode =
  | "rate_limited" // 429, still after the tries
  | "unavailable" // 5xx, a dropped connection, anything unrecognised
  | "timeout" // a try or the whole call ran out of time
  | "rejected" // a 4xx: the request or the key is wrong; waiting will not help
  | "refusal" // the model declined (a safety classifier)
  | "truncated" // the answer hit max_tokens
  | "empty" // the answer had no text
  | "aborted" // the caller's own deadline passed
  | "invalid_request" // refused before anything was sent
  | "over_budget"; // the business reached today's AI spend cap (lib/ai-limits.ts): not sent

const MESSAGES: Record<LlmErrorCode, string> = {
  rate_limited: "The language model is busy right now.",
  unavailable: "The language model could not be reached.",
  timeout: "The language model took too long to answer.",
  rejected: "The language model refused the request.",
  refusal: "The language model declined to answer.",
  truncated: "The language model's answer was cut off.",
  empty: "The language model gave no answer.",
  aborted: "The call was stopped before the language model answered.",
  invalid_request: "The request to the language model is not valid.",
  over_budget: "The business reached its daily AI limit.",
};

/** What a caller needs: a fixed code and message, the provider's HTTP status when there was one, and how many tries were made. */
export class LlmError extends Error {
  /** Whether a later attempt, by the caller, could work. */
  readonly retryable: boolean;
  constructor(
    readonly code: LlmErrorCode,
    readonly status?: number,
    readonly attempts = 0,
  ) {
    super(MESSAGES[code]);
    this.name = "LlmError";
    this.retryable = code === "rate_limited" || code === "unavailable" || code === "timeout";
  }
}

export interface GenerationEvent {
  tenantId: string;
  conversationId?: string;
  role: LlmRole;
  model: string;
  prompt: { name: string; version: number };
  status: "ok" | "error";
  errorCode?: LlmErrorCode;
  httpStatus?: number;
  attempts: number;
  latencyMs: number;
  stopReason?: string;
  usage: TokenUsage;
  costUsd: number | null;
  /** What was sent and what came back. The tracer alone decides what of it to keep (tracing.ts). */
  input: { system: string[]; messages: LlmMessage[] };
  output?: string;
}
export interface Tracer {
  /** Never throws into the caller: a tracing failure must not change an answer. */
  record(event: GenerationEvent): void;
}

export type CreateMessage = (params: Anthropic.MessageCreateParamsNonStreaming, options: { signal: AbortSignal; timeout: number }) => Promise<Anthropic.Message>;

export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResult>;
}

export interface LlmClientDeps {
  create: CreateMessage;
  tracer: Tracer;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Per-role overrides of models.ts (tests). */
  settings?: Partial<Record<LlmRole, Partial<RoleSettings>>>;
}

/** Waits before the second and the third try. */
export const RETRY_DELAYS_MS: readonly number[] = [500, 1500];
/** A Retry-After longer than this is capped: a customer is waiting. */
export const RETRY_AFTER_CAP_MS = 2000;
const MAX_CACHE_BLOCKS = 4; // the API allows four cache breakpoints in a request
const TAG = "[llm]";

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Limits far above anything the pipeline sends: they only stop a bug (or a runaway loop) from sending a huge
// request. A WhatsApp message is at most about 4,000 characters and the pipeline sends the last 10.
const MAX_TEXT = 50_000;
const RequestSchema = z.object({
  tenantId: z.guid(),
  conversationId: z.guid().optional(),
  prompt: z.object({ name: z.string().min(1).max(60), version: z.int().min(1) }),
  system: z.array(z.object({ text: z.string().trim().min(1).max(MAX_TEXT), cache: z.boolean().optional() })).min(1).max(10),
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(MAX_TEXT) }))
    .min(1)
    .max(50)
    .refine((m) => m.length === 0 || m[0].role === "user", "a conversation starts with the customer"),
  maxTokens: z.int().positive().max(8_000).optional(),
});

/** Outside text, cleaned: NUL, control characters and lone surrogates make a request invalid. */
const clean = (text: string) => stripUnsafeCharacters(text);

function retryAfterMs(error: APIError): number | undefined {
  const header = error.headers?.get?.("retry-after");
  return typeof header === "string" && /^\d{1,6}$/.test(header.trim()) ? Number(header) * 1000 : undefined;
}

/** What went wrong, as a code and a status, and whether another try could help. */
function classify(error: unknown): { code: LlmErrorCode; status?: number; retry: boolean; abort: boolean } {
  if (error instanceof Anthropic.APIUserAbortError) return { code: "aborted", retry: false, abort: true };
  if (error instanceof Anthropic.APIConnectionTimeoutError) return { code: "timeout", retry: true, abort: false };
  if (error instanceof Anthropic.APIConnectionError) return { code: "unavailable", retry: true, abort: false };
  if (error instanceof Anthropic.APIError && typeof error.status === "number") {
    const status = error.status;
    if (status === 429) return { code: "rate_limited", status, retry: true, abort: false };
    if (status === 408) return { code: "timeout", status, retry: true, abort: false };
    if (status >= 500) return { code: "unavailable", status, retry: true, abort: false };
    return { code: "rejected", status, retry: false, abort: false };
  }
  // Anything else is a bug or a surprise: not retried, and its text (it can hold paths and values) is dropped.
  return { code: "unavailable", retry: false, abort: false };
}

export function createLlmClient(deps: LlmClientDeps): LlmClient {
  const sleep = deps.sleep ?? sleepFor;
  const now = deps.now ?? Date.now;

  async function complete(raw: LlmRequest): Promise<LlmResult> {
    const parsed = RequestSchema.safeParse({
      ...raw,
      system: raw.system.map((block) => ({ ...block, text: clean(block.text) })),
      messages: raw.messages.map((message) => ({ ...message, content: clean(message.content) })),
    });
    if (!parsed.success) {
      console.warn(`${TAG} request refused before sending: invalid`); // which field is not said: it could quote a customer
      throw new LlmError("invalid_request");
    }
    const request = parsed.data;

    const settings = { ...ROLE_SETTINGS[raw.role], ...deps.settings?.[raw.role] };
    let cached = 0;
    const system = request.system.map((block) => ({
      type: "text" as const,
      text: block.text,
      ...(block.cache && cached++ < MAX_CACHE_BLOCKS && { cache_control: { type: "ephemeral" as const } }),
    }));
    const params = {
      model: settings.model,
      max_tokens: request.maxTokens ?? settings.maxTokens,
      system,
      messages: request.messages,
      ...(settings.temperature !== undefined && { temperature: settings.temperature }),
      ...(settings.effort !== undefined && { output_config: { effort: settings.effort } }),
    } as Anthropic.MessageCreateParamsNonStreaming;

    const traceInput = { system: request.system.map((b) => b.text), messages: request.messages };
    const startedAt = now();
    let attempts = 0;
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let model: string = settings.model;

    const trace = (fields: Pick<GenerationEvent, "status"> & Partial<GenerationEvent>) => {
      if (attempts === 0) return; // nothing was sent: nothing to trace
      try {
        deps.tracer.record({
          tenantId: request.tenantId,
          conversationId: request.conversationId,
          role: raw.role,
          model,
          prompt: request.prompt,
          attempts,
          latencyMs: now() - startedAt,
          usage,
          costUsd: estimateCostUsd(model, usage),
          input: traceInput,
          ...fields,
        });
      } catch {
        // tracing must never change what the customer gets
      }
    };
    const failWith = (code: LlmErrorCode, status?: number, extra: Partial<GenerationEvent> = {}): never => {
      trace({ status: "error", errorCode: code, httpStatus: status, ...extra });
      throw new LlmError(code, status, attempts);
    };

    // The call's own deadline, and the caller's. Whichever passes first stops the call and its retries.
    const deadline = AbortSignal.timeout(settings.totalTimeoutMs);
    const signal = raw.signal ? AbortSignal.any([raw.signal, deadline]) : deadline;
    const callerStopped = () => raw.signal?.aborted === true;
    if (callerStopped()) return failWith("aborted");

    const tries = RETRY_DELAYS_MS.length + 1;
    for (;;) {
      attempts++;
      try {
        const message = await deps.create(params, { signal, timeout: settings.attemptTimeoutMs });
        model = message.model || model;
        usage = {
          inputTokens: message.usage?.input_tokens ?? 0,
          outputTokens: message.usage?.output_tokens ?? 0,
          cacheReadTokens: message.usage?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: message.usage?.cache_creation_input_tokens ?? 0,
        };
        const stopReason = message.stop_reason ?? "unknown";
        if (stopReason === "refusal") return failWith("refusal", undefined, { stopReason });
        // Only a finished answer is text to use. Anything else (max_tokens, pause_turn, a context limit, a reason
        // this code has not met) can be a sentence cut in half, and a half sentence is never sent to a customer.
        if (stopReason !== "end_turn" && stopReason !== "stop_sequence") return failWith("truncated", undefined, { stopReason });
        const text = message.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("")
          .trim();
        if (!text) return failWith("empty", undefined, { stopReason });
        const result: LlmResult = {
          text,
          model,
          stopReason,
          usage,
          costUsd: estimateCostUsd(model, usage),
          latencyMs: now() - startedAt,
          attempts,
          requestId: (message as { _request_id?: string | null })._request_id ?? null,
        };
        trace({ status: "ok", stopReason, output: text, latencyMs: result.latencyMs });
        return result;
      } catch (error) {
        if (error instanceof LlmError) throw error;
        let failure = classify(error);
        // An abort is the caller's deadline if the caller stopped; otherwise it is the call's own deadline.
        if (failure.abort && !callerStopped()) failure = { code: "timeout", retry: false, abort: false };
        console.warn(`${TAG} try ${attempts} of ${tries} failed: ${failure.code}${failure.status ? ` status ${failure.status}` : ""}`);
        const asked = error instanceof Anthropic.APIError ? retryAfterMs(error) : undefined;
        // A Retry-After beyond the cap means the limit will still be in force when we come back: do not try into it.
        // Nor wait when the wait would use up what is left of the call's own deadline: say what went wrong now.
        const wait = Math.max(RETRY_DELAYS_MS[attempts - 1] ?? 0, asked ?? 0);
        const remaining = settings.totalTimeoutMs - (now() - startedAt);
        if (!failure.retry || attempts >= tries || signal.aborted || (asked ?? 0) > RETRY_AFTER_CAP_MS || wait >= remaining) {
          return failWith(callerStopped() ? "aborted" : failure.code, failure.status);
        }
        await sleep(wait);
        if (signal.aborted) return failWith(callerStopped() ? "aborted" : "timeout", failure.status);
      }
    }
  }

  return { complete };
}

/** The client for the real API. One per process; `maxRetries: 0` because the retries above are the retries. */
export function createAnthropicClient(apiKey: string, tracer: Tracer): LlmClient {
  // The address is fixed in code: ANTHROPIC_BASE_URL in the environment must not be able to redirect the key. SDK
  // logging is off: at its debug level it prints request bodies, which are customers' messages.
  const sdk = new Anthropic({ apiKey, baseURL: "https://api.anthropic.com", maxRetries: 0, logLevel: "off" });
  return createLlmClient({ create: (params, options) => sdk.messages.create(params, options), tracer });
}

export { MODELS };
