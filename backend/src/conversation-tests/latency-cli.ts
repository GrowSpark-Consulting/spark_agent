import { createAnthropicClient } from "../agent/llm/anthropic";
import { noopTracer } from "../agent/llm/tracing";
import { configRows, measureLive, measureMocked, parseLatencyArgs } from "./latency";
import { formatReport } from "./latency-report";
import { loadChats } from "./load";

// pnpm latency:chats [--live] [--max-calls N] [--rounds N]   (docs/task-notes/2026-10-13-day6-dev1-step8-audit.md)
//
// Times the pipeline's steps and calls on the scripted conversations. Mocked by default (the pipeline's own code time); --live uses the real models for one turn of a
// handful of chats, at most 15 requests (hard limit 20), with a fake sender, knowledge base and store: nothing is sent and nothing touches a database. LOCAL ONLY, never in CI.
// The work is in latency.ts; this reads the arguments and the key and prints.

async function main(): Promise<number> {
  const args = parseLatencyArgs(process.argv.slice(2));
  const chats = loadChats();
  if (!args.live) {
    for (const line of formatReport({ ...(await measureMocked(chats, args.rounds)), mode: "mocked", calls: null, capped: false, config: configRows() })) console.log(line);
    return 0;
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error("--live needs ANTHROPIC_API_KEY in the environment (backend/.env.local).");
    return 2;
  }
  const run = await measureLive(chats, createAnthropicClient(key, noopTracer), args.maxCalls);
  for (const line of formatReport({ ...run, mode: "live", config: configRows() })) console.log(line);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  },
);
