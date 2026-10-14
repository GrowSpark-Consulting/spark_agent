import { createAnthropicClient } from "../agent/llm/anthropic";
import { noopTracer } from "../agent/llm/tracing";
import { capCalls, parseLiveArgs, type CallUsage } from "./live-cap";
import { loadChats } from "./load";
import { runChat } from "./run-chat";

// pnpm test:conversations [--live] [--only <text[,text] in the file name or chat name>] [--max-calls N]
//
// Mock mode (the default) is what CI runs. --live asks the REAL models (extraction and reply); the knowledge base and the
// sender stay fakes, so nothing is ever sent. It costs a model call or two per turn and is never run in CI: it is capped
// (--max-calls, default 40, hard limit 60; live-cap.ts) and it needs ANTHROPIC_API_KEY in the environment. A chat the cap
// stops is reported NOT RUN, never as a result. The report prints each chat's turns with what the model understood.

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseLiveArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const { live, only, maxCalls } = parsed;

  let chats = loadChats();
  if (only.length > 0) chats = chats.filter((c) => only.some((text) => c.file.toLowerCase().includes(text) || c.chat.name.toLowerCase().includes(text)));
  if (chats.length === 0) {
    console.error("No chat matches.");
    return 2;
  }
  let llm;
  let usage: CallUsage | undefined;
  if (live) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      console.error("--live needs ANTHROPIC_API_KEY in the environment.");
      return 2;
    }
    const capped = capCalls(createAnthropicClient(key, noopTracer), maxCalls);
    llm = capped.client;
    usage = capped.usage;
  }
  console.log(`${live ? `LIVE (real models, at most ${maxCalls} requests)` : "mock models"}: ${chats.length} chat(s)\n`);

  let failed = 0;
  let ran = 0;
  let notRun = 0;
  for (const { file, chat } of chats) {
    const report = await runChat(chat, { mode: live ? "live" : "mock", llm });
    if (usage?.capped) {
      // The cap refused a call inside this chat: the pipeline fell back to its safe line, so nothing this chat shows says what the real model does.
      notRun = chats.length - ran;
      console.log(`NOT RUN  ${file}  ${chat.name}  (the call cap was reached; ${notRun} chat(s) not run: raise --max-calls or run fewer chats)`);
      break;
    }
    ran++;
    const flag = chat.needsNativeCheck ? "  [needs native-speaker check]" : "";
    console.log(`${report.failures.length === 0 ? "PASS" : "FAIL"}  ${file}  ${chat.name}${flag}`);
    if (live || report.failures.length > 0) {
      for (const t of report.transcript) {
        console.log(`      customer: ${t.customer}`);
        console.log(`      -> intent ${t.intent ?? "-"} (${t.confidence ?? "-"}), case ${t.planCase}${t.handoff ? `, handoff ${t.handoff}` : ""}${t.optedOut ? ", OPTED OUT" : ""}${t.reply ? `\n      -> reply: ${t.reply}` : ""}`);
      }
    }
    for (const f of report.failures) console.log(`      x ${f}`);
    if (report.failures.length > 0) failed++;
  }
  console.log(`\n${ran - failed} passed, ${failed} failed${notRun > 0 ? `, ${notRun} NOT RUN (cap)` : ""}`);
  if (usage) console.log(`requests made: ${usage.used} of at most ${usage.max}${usage.costUsd === null ? "" : `, about $${usage.costUsd.toFixed(3)}`}`);
  return failed === 0 && notRun === 0 ? 0 : 1;
}

main().then((code) => process.exit(code), (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
