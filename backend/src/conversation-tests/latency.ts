import { LlmError, RETRY_DELAYS_MS } from "../agent/llm/anthropic";
import type { LlmClient } from "../agent/llm";
import { ROLE_SETTINGS } from "../agent/llm/models";
import { checkReply } from "../agent/pipeline/postcheck";
import { TURN_HARD_STOP_MS, TURN_TARGET_MS } from "../agent/pipeline/turn-deadline";
import { MARK_READ_MIN_LEFT_MS, MARK_READ_TIMEOUT_MS } from "../channels/whatsapp/mark-read";
import { processMessage } from "../inngest/process-message";
import type { LoadedChat } from "./load";
import { percentile, Recorder, type LiveUsage, type ReportInput } from "./latency-report";
import { runChat, type UntimedError } from "./run-chat";

// The latency harness (pnpm latency:chats; docs/task-notes/2026-10-13-day6-dev1-step8-audit.md). It runs the scripted conversations (tests/conversations) through the real
// pipeline steps and times each step and call, as run-chat.ts runs them. LOCAL ONLY, never in CI.
//
//   mocked (default): the models answer at once, the knowledge base and store are in memory, nothing is sent. The numbers are the pipeline's own code time.
//   --live: the real models answer (extraction and reply) for ONE turn of a handful of chats, at most 15 requests (hard limit 20). The knowledge base, the sender and
//           the store are still fakes: nothing is sent and nothing touches a database. It needs ANTHROPIC_API_KEY in the environment.
//
// It judges and changes nothing: no prompt, no model, no rule. Every number it prints is labelled mocked, live, configured or not measured (latency-report.ts).

export const LIVE_DEFAULT_MAX_CALLS = 15;
export const LIVE_MAX_CALLS_LIMIT = 20;
const DEFAULT_ROUNDS = 5;
const MAX_ROUNDS = 100;

/** The first turn of each of these chats is run live: a question answered from the knowledge base in English and in Tanglish, an off-topic one, a booking, an angry customer and a discount. */
export const LIVE_TURNS = [
  "real-estate/01-price-question-english.yaml",
  "real-estate/02-price-question-tanglish.yaml",
  "real-estate/03-off-topic.yaml",
  "real-estate/50-booking-asks-next-details.yaml",
  "real-estate/51-booking-offer-and-book.yaml",
  "real-estate/61-angry-customer-sorry-then-person.yaml",
  "real-estate/62-discount-request-goes-to-a-person.yaml",
];

export interface LatencyArgs {
  live: boolean;
  maxCalls: number;
  rounds: number;
}

export function parseLatencyArgs(argv: string[]): LatencyArgs {
  let live = false;
  let maxCalls = LIVE_DEFAULT_MAX_CALLS;
  let rounds = DEFAULT_ROUNDS;
  const whole = (value: string | undefined, name: string, max: number): number => {
    const n = Number(value);
    if (value === undefined || !/^\d+$/.test(value) || n < 1 || n > max) throw new Error(`${name} needs a whole number from 1 to ${max}.`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--live") live = true;
    else if (arg === "--max-calls" || arg.startsWith("--max-calls=")) maxCalls = whole(arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i], "--max-calls", LIVE_MAX_CALLS_LIMIT);
    else if (arg === "--rounds" || arg.startsWith("--rounds=")) rounds = whole(arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i], "--rounds", MAX_ROUNDS);
    else throw new Error(`Unknown argument ${arg}. Allowed: --live, --max-calls N (1 to ${LIVE_MAX_CALLS_LIMIT}), --rounds N (1 to ${MAX_ROUNDS}).`);
  }
  return { live, maxCalls, rounds };
}

const seconds = (ms: number) => `${ms / 1000} s`;
const secondsOf = (text: string) => (/^(\d+)s$/.exec(text) ? `${/^(\d+)s$/.exec(text)?.[1]} s` : text);
/** The adapter's own request timeout (channels/whatsapp/adapter.ts DEFAULT_TIMEOUT_MS; a test pins the number). */
const SEND_TIMEOUT_S = 10;

/** The limits the pipeline runs under, read from the code so the report cannot drift from it. */
export function configRows(): { what: string; value: string }[] {
  const opts = (processMessage as unknown as { opts: { debounce: { period: string; timeout: string }; retries: number; concurrency: { limit: number } } }).opts;
  const tries = RETRY_DELAYS_MS.length + 1;
  const role = (r: "extraction" | "reply") => `${seconds(ROLE_SETTINGS[r].attemptTimeoutMs)} / ${seconds(ROLE_SETTINGS[r].totalTimeoutMs)}, ${tries} tries`;
  const longestDebounce = Number(/^(\d+)s$/.exec(opts.debounce.timeout)?.[1] ?? Number.NaN);
  const worst = longestDebounce + TURN_HARD_STOP_MS / 1000 + SEND_TIMEOUT_S;
  return [
    { what: "Turn target / hard stop", value: `${seconds(TURN_TARGET_MS)} / ${seconds(TURN_HARD_STOP_MS)}` },
    { what: "Debounce: quiet period / longest wait", value: `${secondsOf(opts.debounce.period)} / ${secondsOf(opts.debounce.timeout)}` },
    { what: "Step retries / conversations at once", value: `${opts.retries} / ${opts.concurrency.limit}` },
    { what: "Extraction model: a try / all tries", value: role("extraction") },
    { what: "Reply model: a try / all tries", value: role("reply") },
    { what: "WhatsApp send timeout", value: `${SEND_TIMEOUT_S} s (the adapter's default; it never retries)` },
    { what: "Read receipt", value: `${seconds(MARK_READ_TIMEOUT_MS)} at most; skipped when under ${seconds(MARK_READ_MIN_LEFT_MS)} of the target is left` },
    { what: "Longest wait without a step retry", value: `${worst} s (${longestDebounce} s + ${TURN_HARD_STOP_MS / 1000} s + ${SEND_TIMEOUT_S} s)` },
  ];
}

/** The post-check timed on its own: each reply against its facts, `reps` times. Null when there is no reply. */
export function postcheckTiming(items: { text: string; facts: readonly string[] }[], reps: number): { n: number; p50Us: number; p95Us: number } | null {
  if (items.length === 0) return null;
  const micros: number[] = [];
  for (const { text, facts } of items) {
    for (let i = 0; i < reps; i++) {
      const startedAt = process.hrtime.bigint();
      checkReply(text, facts);
      micros.push(Number(process.hrtime.bigint() - startedAt) / 1000);
    }
  }
  return { n: micros.length, p50Us: percentile(micros, 50), p95Us: percentile(micros, 95) };
}

/**
 * Runs `fn` with the console quiet: the pipeline logs a line for some outcomes (a reply the post-check refused, a model that failed) and a timing run has no use for them.
 * Put back afterwards, whatever happens.
 */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => undefined;
  console.warn = () => undefined;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

export type Measured = Omit<ReportInput, "mode" | "config" | "calls" | "capped">;

function summarize(recorder: Recorder, chats: number, rounds: number, replies: { text: string; facts: readonly string[] }[]): Measured {
  const steps = [...recorder.samples].filter(([stage]) => stage.startsWith("step:")).reduce((n, [, values]) => n + values.length, 0);
  const turns = recorder.turns.length;
  return { chats, turns, rounds, recorder, stepsPerTurn: turns === 0 ? 0 : steps / turns, regenerations: recorder.regenerations, postcheck: postcheckTiming(replies, 50) };
}

/** Every scripted chat, mocked models, `rounds` times over. */
export async function measureMocked(chats: LoadedChat[], rounds: number): Promise<Measured> {
  const recorder = new Recorder();
  const replies: { text: string; facts: readonly string[] }[] = [];
  await quietly(async () => {
    for (let round = 0; round < rounds; round++) {
      for (const { chat } of chats) {
        const report = await runChat(chat, { mode: "mock", probe: recorder });
        if (round === 0) for (const t of report.transcript) if (t.reply) replies.push({ text: t.reply, facts: chat.kb });
      }
    }
  });
  return summarize(recorder, chats.length, rounds, replies);
}

class CallCapReached extends Error implements UntimedError {
  readonly untimed = true as const;
  constructor() {
    super("the call cap was reached");
  }
}

/** The most requests one call can make: the client tries a request up to this many times (anthropic.ts RETRY_DELAYS_MS). */
const TRIES_PER_CALL = RETRY_DELAYS_MS.length + 1;

/** The first turn of the chosen chats with the real models, until `maxCalls` requests have been made. */
export async function measureLive(chats: LoadedChat[], llm: LlmClient, maxCalls: number): Promise<Measured & { calls: LiveUsage; capped: boolean }> {
  const usage: LiveUsage = { used: 0, max: maxCalls, byRole: {}, costUsd: 0 };
  let capped = false;
  // The cap is hard. A call is refused unless its worst case still fits (the client may try it three times), so the requests a run makes never pass the cap; the
  // ones that did happen are counted by the tries they took, whether the call succeeded or failed (a failed call is billed too).
  const count = (role: string, requests: number) => {
    usage.used += requests;
    usage.byRole[role] = (usage.byRole[role] ?? 0) + requests;
  };
  const client: LlmClient = {
    async complete(request) {
      if (usage.used + TRIES_PER_CALL > maxCalls) {
        capped = true;
        throw new CallCapReached();
      }
      let result;
      try {
        result = await llm.complete(request);
      } catch (error) {
        count(request.role, error instanceof LlmError ? Math.max(1, error.attempts) : 1);
        throw error;
      }
      count(request.role, Math.max(1, result.attempts));
      usage.costUsd = usage.costUsd === null || result.costUsd === null ? null : usage.costUsd + result.costUsd;
      return result;
    },
  };

  const recorder = new Recorder();
  const replies: { text: string; facts: readonly string[] }[] = [];
  const byFile = new Map(chats.map((c) => [c.file, c]));
  let ran = 0;
  await quietly(async () => {
    for (const file of LIVE_TURNS) {
      const loaded = byFile.get(file);
      if (!loaded || capped) continue;
      const firstTurn = { ...loaded.chat, turns: loaded.chat.turns.slice(0, 1) };
      const report = await runChat(firstTurn, { mode: "live", llm: client, probe: recorder });
      // The turn the cap stopped did not run as it would have: it is left out of the whole-turn numbers.
      if (capped) recorder.turns.pop();
      else ran++;
      for (const t of report.transcript) if (t.reply) replies.push({ text: t.reply, facts: loaded.chat.kb });
    }
  });
  return { ...summarize(recorder, ran, 1, replies), calls: usage, capped };
}
