import { LlmError } from "../agent/llm/anthropic";
import type { LlmClient } from "../agent/llm";
import { RETRY_DELAYS_MS } from "../agent/llm/anthropic";

// The call cap of `pnpm test:conversations -- --live` (Day 7, PR C): a live run can no longer spend more than the cap says.
// Every model request is counted, a request the client retries counts once per try, a failed call is counted too (it is billed), and a call
// is refused BEFORE it is made unless its worst case (every try) still fits. So the requests made never pass the cap.

export const LIVE_DEFAULT_MAX_CALLS = 40;
export const LIVE_MAX_CALLS_LIMIT = 60;

/** The most requests one call can make: the client tries a request up to this many times (anthropic.ts RETRY_DELAYS_MS). */
const TRIES_PER_CALL = RETRY_DELAYS_MS.length + 1;

export interface LiveArgs {
  live: boolean;
  /** Chats whose file or name contains any of these (lower case); empty means all. */
  only: string[];
  maxCalls: number;
}

export function parseLiveArgs(argv: string[]): LiveArgs {
  let live = false;
  let only: string[] = [];
  let maxCalls = LIVE_DEFAULT_MAX_CALLS;
  const value = (arg: string, i: number, name: string) => (arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[i + 1] ?? (() => { throw new Error(`${name} needs a value.`); })());
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--live") live = true;
    else if (arg === "--only" || arg.startsWith("--only=")) {
      const text = value(arg, i, "--only");
      if (text.startsWith("--")) throw new Error("--only needs a text to look for in the chat file or name, not a flag.");
      if (!arg.includes("=")) i++;
      only = text.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (only.length === 0) throw new Error("--only needs a text to look for in the chat file or name (several: a,b,c).");
    } else if (arg === "--max-calls" || arg.startsWith("--max-calls=")) {
      const text = value(arg, i, "--max-calls");
      if (!arg.includes("=")) i++;
      const n = Number(text);
      if (!/^\d+$/.test(text) || n < 1 || n > LIVE_MAX_CALLS_LIMIT) throw new Error(`--max-calls needs a whole number from 1 to ${LIVE_MAX_CALLS_LIMIT}.`);
      maxCalls = n;
    } else throw new Error(`Unknown argument ${arg}. Allowed: --live, --only <text[,text]>, --max-calls N (1 to ${LIVE_MAX_CALLS_LIMIT}, default ${LIVE_DEFAULT_MAX_CALLS}).`);
  }
  return { live, only, maxCalls };
}

export interface CallUsage {
  used: number;
  max: number;
  costUsd: number | null;
  /** The cap refused a call: the chat that was running did not run as it would have, and no more chats are started. */
  capped: boolean;
}

export class CallCapReached extends Error {
  constructor() {
    super("the call cap was reached");
  }
}

export function capCalls(llm: LlmClient, maxCalls: number): { client: LlmClient; usage: CallUsage } {
  const usage: CallUsage = { used: 0, max: maxCalls, costUsd: 0, capped: false };
  const client: LlmClient = {
    async complete(request) {
      if (usage.used + TRIES_PER_CALL > maxCalls) {
        usage.capped = true;
        throw new CallCapReached();
      }
      try {
        const result = await llm.complete(request);
        usage.used += Math.max(1, result.attempts);
        usage.costUsd = usage.costUsd === null || result.costUsd === null ? null : usage.costUsd + result.costUsd;
        return result;
      } catch (error) {
        // An error that is not the client's own may have come after every try: count the worst case.
        usage.used += error instanceof LlmError ? Math.max(1, error.attempts) : TRIES_PER_CALL;
        throw error;
      }
    },
  };
  return { client, usage };
}
