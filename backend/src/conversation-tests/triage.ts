import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { createAnthropicClient } from "../agent/llm/anthropic";
import { noopTracer } from "../agent/llm/tracing";
import type { LlmClient } from "../agent/llm";
import { runChat } from "./run-chat";
import type { Chat } from "./schema";
import { parseKbFile, parseTriageFile, type TriageChat } from "./triage-format";
import { formatChat, formatSummary, summarize, type MessageRow, type TriageUsage } from "./triage-report";

// pnpm triage:chats <file> [--live] [--max-calls N] [--kb <file>] [--keep-numbers]   (tests/triage/README.md)
//
// Runs a pasted file of real chats through the real pipeline steps with the REAL models (--live), a fake sender and a fake knowledge base, and prints for each message
// what the models read and what the pipeline did, then a table of languages and weak readings. It judges nothing and changes nothing: it is for reading the
// Tamil and Tanglish chats before tuning. Nothing is sent and nothing touches a database. Without --live it only checks the file.

export type { TriageUsage };

const DEFAULT_MAX_CALLS = 20;
const MAX_CALLS_LIMIT = 200;
const SAMPLE_KB = fileURLToPath(new URL("../../../tests/triage/sample-kb.txt", import.meta.url));

/** The business every chat runs against: the fixed clock, catalog and free times of the booking chats, so offers and bookings show up. */
const BOOKING = {
  now: "2026-10-10T04:30:00.000Z",
  timeZone: "Asia/Kolkata",
  services: 1,
  catalog: [{ type: "property", priceFrom: 6000000, attributes: { price_to: 8000000, area: "Velachery" } }],
  slots: ["2026-10-11T04:30:00.000Z", "2026-10-11T09:30:00.000Z", "2026-10-12T12:00:00.000Z"],
  takenWhenChosen: [] as string[],
};

class CallCapReached extends Error {
  constructor() {
    super("the call cap was reached");
  }
}

export interface TriageArgs {
  file: string;
  live: boolean;
  maxCalls: number;
  kb?: string;
  keepNumbers: boolean;
}

export function parseTriageArgs(argv: string[]): TriageArgs {
  let file: string | undefined;
  let live = false;
  let keepNumbers = false;
  let maxCalls = DEFAULT_MAX_CALLS;
  let kb: string | undefined;
  const maxCallsError = () => new Error(`--max-calls needs a whole number from 1 to ${MAX_CALLS_LIMIT}.`);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--live") live = true;
    else if (arg === "--keep-numbers") keepNumbers = true;
    else if (arg === "--max-calls" || arg.startsWith("--max-calls=")) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      const n = Number(value);
      if (value === undefined || !/^\d+$/.test(value) || n < 1 || n > MAX_CALLS_LIMIT) throw maxCallsError();
      maxCalls = n;
    } else if (arg === "--kb" || arg.startsWith("--kb=")) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (!value) throw new Error("--kb needs the path of a file with one fact per line.");
      kb = value;
    } else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}. Allowed: --live, --max-calls N, --kb <file>, --keep-numbers.`);
    else if (file !== undefined) throw new Error("Give one file of chats.");
    else file = arg;
  }
  if (file === undefined) throw new Error("Give a file of chats: pnpm triage:chats <file> [--live] [--max-calls N] [--kb <file>].");
  return { file, live, maxCalls, ...(kb !== undefined && { kb }), keepNumbers };
}

export function checkSummary(chats: TriageChat[]): string[] {
  const messages = chats.reduce((n, c) => n + c.messages.length, 0);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return [`${plural(chats.length, "chat")}, ${plural(messages, "message")}: the file is in the right format.`, "No model was called. Add --live to run it with the real models."];
}

const toChat = (chat: TriageChat, kb: string[]): Chat =>
  ({ name: chat.name, pack: "real-estate", settings: {}, contact: { language: null, alreadySawNotice: true }, kb, booking: BOOKING, turns: chat.messages.map((customer) => ({ customer })) }) as unknown as Chat;

const notRunRow = (customer: string): MessageRow => ({ customer, status: "not_run", language: null, sentiment: null, fields: {}, intent: null, confidence: null, action: "-", handoff: null, optedOut: false, reply: null });

export async function runTriage(
  chats: TriageChat[],
  options: { maxCalls: number; kb: string[] },
  llm: LlmClient,
  print: (line: string) => void,
): Promise<{ rows: MessageRow[]; usage: TriageUsage }> {
  const usage: TriageUsage = { calls: 0, max: options.maxCalls, byRole: {}, costUsd: 0 };
  let capped = false;
  let turnNow = -1;
  let cappedTurn = -1;

  // The cap is hard: a call past it is refused here and never reaches the model.
  const client: LlmClient = {
    async complete(request) {
      if (usage.calls >= options.maxCalls) {
        if (!capped) cappedTurn = turnNow;
        capped = true;
        throw new CallCapReached();
      }
      usage.calls++;
      usage.byRole[request.role] = (usage.byRole[request.role] ?? 0) + 1;
      const result = await llm.complete(request);
      usage.costUsd = usage.costUsd === null || result.costUsd === null ? null : usage.costUsd + result.costUsd;
      return result;
    },
  };

  const rows: MessageRow[] = [];
  for (const [index, chat] of chats.entries()) {
    let chatRows: MessageRow[];
    if (capped) chatRows = chat.messages.map(notRunRow);
    else {
      turnNow = -1;
      const report = await runChat(toChat(chat, options.kb), { mode: "live", llm: client, onTurn: (t) => (turnNow = t) });
      chatRows = report.transcript.map((t, turn): MessageRow => {
        if (capped && cappedTurn >= 0 && turn > cappedTurn) return notRunRow(t.customer);
        const stopped = capped && turn === cappedTurn;
        return {
          customer: t.customer,
          status: stopped ? "capped" : "ok",
          language: t.extraction?.language ?? null,
          sentiment: t.extraction?.sentiment ?? null,
          fields: t.extraction?.fields ?? {},
          intent: t.intent,
          confidence: t.confidence,
          action: t.planCase,
          handoff: t.handoff,
          optedOut: t.optedOut,
          reply: stopped ? null : t.reply,
        };
      });
    }
    for (const line of formatChat(index + 1, chat.name, chatRows)) print(line);
    print("");
    rows.push(...chatRows);
  }
  for (const line of formatSummary(summarize(rows), usage)) print(line);
  return { rows, usage };
}

/** Relative paths are taken from where the command was typed (pnpm runs in backend/, and sets INIT_CWD to the folder you were in). */
const fromHere = (path: string) => (isAbsolute(path) ? path : resolve(process.env.INIT_CWD ?? process.cwd(), path));

async function main(): Promise<number> {
  const args = parseTriageArgs(process.argv.slice(2));
  const { chats } = parseTriageFile(readFileSync(fromHere(args.file), "utf8"), { keepNumbers: args.keepNumbers });
  if (!args.live) {
    for (const line of checkSummary(chats)) console.log(line);
    return 0;
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error("--live needs ANTHROPIC_API_KEY in the environment (backend/.env.local).");
    return 2;
  }
  const kb = parseKbFile(readFileSync(args.kb ? fromHere(args.kb) : SAMPLE_KB, "utf8"));
  console.log(`LIVE (real models), at most ${args.maxCalls} calls; fake sender, fake knowledge base (${kb.length} facts${args.kb ? "" : ", the sample"}); nothing is sent.\n`);
  await runTriage(chats, { maxCalls: args.maxCalls, kb }, createAnthropicClient(key, noopTracer), (line) => console.log(line));
  return 0;
}

// Only when run as the command, not when a test imports it.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(2);
    },
  );
}
