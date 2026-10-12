import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createAnthropicClient } from "../agent/llm/anthropic";
import { noopTracer } from "../agent/llm/tracing";
import { checkSummary, parseTriageArgs, runTriage, SAMPLE_KB } from "./triage";
import { parseKbFile, parseTriageFile } from "./triage-format";

// The command: pnpm triage:chats <file> [--live] [--max-calls N] [--kb <file>] [--keep-numbers]. The work is in triage.ts; this reads the files, checks the key and prints.
// It is a file of its own so that importing triage.ts (the tests do) can never start a run, and so that running this one can never exit quietly without doing anything.

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
  console.log(`LIVE (real models), at most ${args.maxCalls} requests; fake sender, fake knowledge base (${kb.length} facts${args.kb ? "" : ", the sample"}); nothing is sent.\n`);
  await runTriage(chats, { maxCalls: args.maxCalls, kb }, createAnthropicClient(key, noopTracer), (line) => console.log(line));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  },
);
