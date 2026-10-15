import { readFile } from "node:fs/promises";
import { serverEnv } from "../lib/env";
import { MODELS } from "../agent/llm/models";
import {
  DEFAULT_USD_INR,
  TARGET_INR_PER_CREDIT,
  calibrateCharsPerToken,
  charsPerToken,
  fetchObservations,
  indiaDay,
  parseExport,
  resolveTraceSource,
  resolveUsdInr,
  summariseTraces,
  type Observation,
  type Ratios,
  type TraceSummary,
} from "./cost-per-message-lib";
import { buildOfflineReport, type CaseCost, type OfflineReport } from "./cost-per-message-offline";

// pnpm --filter @pakka/backend cost:per-message [flags]
// What does one processed message cost us in rupees, and is one credit under the 0.35 rupee target? docs/cost-per-message.md has the numbers and the reasoning.
//
//   (no trace flag)  OFFLINE ESTIMATE: the real prompts, typical messages, estimated tokens, the agent's own price table. Calls nothing.
//   --file <f.json>  FROM TRACES: a Langfuse export. THE EXPORT FORMAT IS A GUESS (read from what tracing.ts writes), not checked against a real export.
//   --traces         FROM TRACES with no file: the Langfuse API if LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set (also unverified);
//                    otherwise it says there is nothing to read and exits normally.
// Never prints a key. No model is called; only --traces with keys sends anything, and only to the https Langfuse address, to read.

const HELP = `Usage: pnpm --filter @pakka/backend cost:per-message [flags]

Answers: how much does one processed message cost in rupees, and is one credit (one AI reply) under ${TARGET_INR_PER_CREDIT} rupees?
One processed message = one Haiku extraction + one Sonnet reply (+ a possible regenerated reply).

Offline estimate (default, calls nothing):
  --usd-inr <n>            rupees to the dollar (default ${DEFAULT_USD_INR}, a stated assumption; or set USD_INR_RATE)
  --kb-chunks <n>          knowledge-base chunks given to the reply (default 3, the search returns up to 5)
  --kb-chunk-chars <n>     characters per chunk (default 600, cut to 1500 in the prompt)
  --ratio-extraction <n>   characters per token for English text on the extraction model (Haiku 4.5), from a calibration
  --ratio-reply <n>        the same for the reply model (Sonnet 5.5)

From traces:
  --file <export.json>     a Langfuse export of generations. THE FORMAT IS A GUESS: it follows what tracing.ts writes
                           (usageDetails, costDetails, metadata.role, metadata.input_chars) and has not been checked against a real export.
  --traces                 read the Langfuse API (needs LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY; UNVERIFIED against the real API).
                           With no file and no keys it says so and exits normally.
  --day <YYYY-MM-DD>       the India day to average (default: with --file every day in the file, with --traces today)
  --credits <n>            the number of AI replies charged that day (the credit ledger's count). Without it one credit is one processed message.

  --help                   this text
`;

interface Args {
  help: boolean;
  usdInr?: string;
  kbChunks?: number;
  kbChunkChars?: number;
  ratioExtraction?: number;
  ratioReply?: number;
  file?: string;
  traces: boolean;
  day?: string;
  credits?: number;
}

const FLAGS = new Set(["--usd-inr", "--kb-chunks", "--kb-chunk-chars", "--ratio-extraction", "--ratio-reply", "--file", "--day", "--credits"]);

function parseArgs(argv: string[]): Args {
  const args: Args = { help: false, traces: false };
  const list = argv.filter((a) => a !== "--");
  for (let i = 0; i < list.length; i++) {
    const flag = list[i];
    if (flag === "--help" || flag === "-h") args.help = true;
    else if (flag === "--traces") args.traces = true;
    else if (FLAGS.has(flag)) {
      const value = list[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`Usage: ${flag} needs a value (see --help)`);
      const number = () => {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`Usage: ${flag} needs a positive number (got "${value.slice(0, 20)}")`);
        return n;
      };
      if (flag === "--usd-inr") args.usdInr = value;
      else if (flag === "--kb-chunks") args.kbChunks = Math.max(1, Math.round(number()));
      else if (flag === "--kb-chunk-chars") args.kbChunkChars = Math.max(50, Math.round(number()));
      else if (flag === "--ratio-extraction") args.ratioExtraction = number();
      else if (flag === "--ratio-reply") args.ratioReply = number();
      else if (flag === "--file") args.file = value;
      else if (flag === "--day") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Usage: --day needs YYYY-MM-DD");
        args.day = value;
      } else if (flag === "--credits") args.credits = Math.round(number());
    } else throw new Error(`Usage: unknown flag ${flag.slice(0, 30)} (see --help)`);
  }
  return args;
}

const usd = (n: number) => `$${n.toFixed(5)}`;
const inr = (n: number) => `₹${n.toFixed(3)}`;
const pad = (text: string, width: number) => text.padEnd(width);

function caseRow(label: string, c: CaseCost): string {
  return `  ${pad(label, 26)}${pad(usd(c.extraction), 11)}${pad(usd(c.reply), 11)}${pad(c.regenerate ? usd(c.regenerate) : "-", 11)}${pad(usd(c.total), 11)}${pad(inr(c.perCreditInr), 11)}${c.withinTarget ? "under" : "OVER"} ${TARGET_INR_PER_CREDIT}`;
}

function printOffline(report: OfflineReport): void {
  console.log(`OFFLINE ESTIMATE of one processed message. Nothing was called. USD to INR ${report.usdInr} (an assumption). Target: ${report.targetInr} rupees per credit.\n`);
  for (const scenario of report.scenarios) {
    const sum = (blocks: { tokens: number }[]) => blocks.reduce((n, b) => n + b.tokens, 0);
    console.log(`${scenario.name}`);
    console.log(`  extraction (${scenario.extraction.model}): system ${sum(scenario.extraction.blocks)} tokens in ${scenario.extraction.blocks.length} cached blocks, user ${scenario.extraction.userTokens}, output ${scenario.extraction.outputTokens}`);
    console.log(`  reply (${scenario.reply.model}): system ${sum(scenario.reply.blocks)} tokens in ${scenario.reply.blocks.length} cached blocks, user ${scenario.reply.userTokens}, output ${scenario.reply.outputTokens} (with thinking)`);
    console.log(`  ${pad("", 26)}${pad("extraction", 11)}${pad("reply", 11)}${pad("regenerate", 11)}${pad("total", 11)}${pad("per credit", 11)}vs target`);
    console.log(caseRow("no cache", scenario.cases.none));
    console.log(caseRow("every call a cache hit", scenario.cases.hit));
    console.log(caseRow("every call a cache write", scenario.cases.write));
    console.log(caseRow("no cache + a regenerate", scenario.regenerate.none));
    console.log(caseRow("cache hits + a regenerate", scenario.regenerate.hit));
    const part = (label: string, key: "cachedPrompt" | "knowledge" | "history" | "other" | "output") => {
      const cell = (m: "none" | "hit") => `${pad(usd(scenario.replyParts[m][key]), 11)}${pad(`${((scenario.replyParts[m][key] / scenario.replyParts[m].total) * 100).toFixed(0)}%`, 6)}`;
      console.log(`  ${pad(label, 40)}${cell("none")}${cell("hit")}`);
    };
    console.log(`  Sonnet reply by part:${pad("", 19)}${pad("no cache", 17)}cache hit`);
    part("fixed prompt (rules and persona)", "cachedPrompt");
    part("knowledge-base context", "knowledge");
    part("conversation history", "history");
    part("task and questions to ask", "other");
    part("output (answer and thinking)", "output");
    const pct = (n: number | null) => (n === null ? "the cache does nothing here" : `${(n * 100).toFixed(0)}% of calls must hit`);
    console.log(`  cache break-even: extraction ${pct(scenario.breakEven.extraction)}; reply ${pct(scenario.breakEven.reply)}`);
    console.log(`  what-if, extraction on ${report.whatIfModel}: ${usd(scenario.haiku55.extractionNone)} without cache (now ${usd(scenario.cases.none.extraction)}); a whole message ${usd(scenario.haiku55.totalNone)} (now ${usd(scenario.cases.none.total)}), ${inr(scenario.haiku55.totalNone * report.usdInr)} per credit\n`);
  }
  console.log("CACHE CHECK (report only: which cached prompt blocks are long enough to be cached; a prompt under the minimum is silently not cached)");
  for (const check of report.cacheChecks) {
    console.log(`  ${check.model}: minimum ${check.minimum} tokens, system prompt ${check.totalCachedPrefixTokens} tokens -> ${check.cachedTokens > 0 ? `cached (${check.cachedTokens} tokens)` : "NOT CACHED"}${check.borderline ? " (BORDERLINE: within 15% of the minimum, and the token count is an estimate; the real answer is cache_read_input_tokens in Langfuse)" : ""}`);
    for (const v of check.verdicts) console.log(`    breakpoint after block ${v.index + 1}: prefix ${v.cumulativeTokens} tokens -> ${v.caches ? "long enough" : "too short, nothing cached"}`);
  }
  console.log("\nASSUMPTIONS");
  for (const a of report.assumptions) console.log(`  - ${a}`);
}

function printTraces(summary: TraceSummary, ratios: ReturnType<typeof calibrateCharsPerToken>, count: number): void {
  console.log(`FROM TRACES: ${count} generations read${summary.day ? `, India day ${summary.day}` : ", every day in the source"}. USD to INR ${summary.usdInr} (an assumption). Target: ${TARGET_INR_PER_CREDIT} rupees per credit.`);
  if (summary.messages === 0) {
    console.log("No processed messages in that selection (no extraction calls), so there is no average to show.");
    return;
  }
  console.log(`  processed messages (extraction calls that worked): ${summary.messages}`);
  console.log(`  extraction + reply cost: ${usd(summary.totalUsd)}${summary.recomputed ? ` (${summary.recomputed} calls had no cost and were priced from their tokens)` : ""}; extra reply calls (regenerates): ${summary.extraReplies}`);
  console.log(`  per processed message: ${usd(summary.perMessageUsd ?? 0)} = ${inr(summary.perMessageInr ?? 0)}`);
  console.log(`  credits: ${summary.credits}${summary.creditsAssumed ? " (ASSUMED one per processed message; pass --credits with the ledger's count)" : ""}`);
  console.log(`  per credit: ${inr(summary.perCreditInr ?? 0)} -> ${summary.withinTarget ? "UNDER" : "OVER"} the ${TARGET_INR_PER_CREDIT} target`);
  if (summary.otherUsd > 0) console.log(`  not counted (handover cards and other calls): ${usd(summary.otherUsd)}`);
  for (const [model, totals] of Object.entries(summary.byModel)) {
    console.log(`  ${model}: ${totals.calls} calls, input ${totals.inputTokens}, cache read ${totals.cacheReadTokens}, cache written ${totals.cacheWriteTokens}, output ${totals.outputTokens}; ${(totals.cacheShare * 100).toFixed(0)}% of input came from the cache`);
  }
  const found = Object.entries(ratios);
  if (found.length > 0) {
    console.log("\nCALIBRATION (characters per token seen in these traces; one blended figure for the prompt and the messages)");
    for (const [model, c] of found) console.log(`  ${model}: ${c.charsPerToken.toFixed(2)} from ${c.calls} calls (the offline estimate uses ${charsPerToken(model).latin.toFixed(2)} for English)`);
    console.log("  Feed these back with --ratio-extraction and --ratio-reply.");
  }
}

function langfuseEnv(): Record<string, string | undefined> {
  try {
    const env = serverEnv();
    return { LANGFUSE_PUBLIC_KEY: env.LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY: env.LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL: env.LANGFUSE_BASE_URL };
  } catch {
    // The whole server environment is not here (a laptop with only the Langfuse keys): read just the three variables this needs.
    return { LANGFUSE_PUBLIC_KEY: process.env.LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY: process.env.LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL: process.env.LANGFUSE_BASE_URL };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  const usdInr = resolveUsdInr({ flag: args.usdInr, env: process.env.USD_INR_RATE });

  const ratios: Ratios = {};
  const scale = (model: string, latin: number) => {
    const base = charsPerToken(model);
    ratios[model] = { latin, indic: base.indic * (latin / base.latin) };
  };
  if (args.ratioExtraction) scale(MODELS.extraction, args.ratioExtraction);
  if (args.ratioReply) scale(MODELS.reply, args.ratioReply);

  if (!args.file && !args.traces) {
    printOffline(buildOfflineReport({ usdInr, kbChunks: args.kbChunks, kbChunkChars: args.kbChunkChars, ratios }));
    return;
  }

  const source = resolveTraceSource({ file: args.file, env: langfuseEnv() });
  if (source.kind === "none") {
    console.log(source.message);
    return;
  }
  let observations: Observation[];
  let day = args.day;
  if (source.kind === "file") {
    observations = parseExport(JSON.parse(await readFile(source.path, "utf8")));
  } else {
    day ??= indiaDay(new Date());
    observations = await fetchObservations(source, day);
  }
  const summary = summariseTraces(observations, { day, usdInr, credits: args.credits });
  const chosen = observations.filter((o) => !day || indiaDay(o.startTime) === day);
  const { systemChars } = buildOfflineReport({ usdInr });
  printTraces(summary, calibrateCharsPerToken(chosen, systemChars), chosen.length);
}

main().catch((error: unknown) => {
  // The message of our own errors only (usage, a status code, the shape of a file): never a key, a body or a customer's words.
  console.error(error instanceof Error && /^(Usage:|Expected|The (Langfuse|USD)|No price)/.test(error.message) ? error.message : "cost:per-message failed (run with --help; no details are printed in case they hold a key).");
  process.exitCode = 1;
});
