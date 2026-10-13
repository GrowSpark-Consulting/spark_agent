import type { StageProbe } from "./run-chat";

// The latency harness's numbers and its report (conversation-tests/latency.ts). Pure: no clock, no model, no database. Every table says where its numbers
// come from: MOCKED (the pipeline's own code time, with models that answer at once), LIVE (the real models), CONFIG (a limit read from the code), MEASURED
// SEPARATELY (a function timed on its own) or NOT MEASURED. A number is never shown without its label.

/** Nearest-rank percentile: the smallest value that at least p percent of the values do not exceed. NaN for no values. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

/** Collects the timings a run reports (run-chat.ts StageProbe). */
export class Recorder implements StageProbe {
  readonly samples = new Map<string, number[]>();
  readonly turns: number[] = [];
  /** Replies written a second time because the post-check refused the first: every reply-model call after the first in a turn. */
  regenerations = 0;
  private replyCalls = 0;
  record(stage: string, ms: number): void {
    const list = this.samples.get(stage);
    if (list) list.push(ms);
    else this.samples.set(stage, [ms]);
    if (stage === "llm:reply") this.replyCalls++;
  }
  turn(_index: number, ms: number): void {
    this.turns.push(ms);
    if (this.replyCalls > 1) this.regenerations += this.replyCalls - 1;
    this.replyCalls = 0;
  }
}

export interface StageRow {
  stage: string;
  n: number;
  p50: number;
  p95: number;
  max: number;
}

/** The stages whose name starts with `prefix` (the prefix is dropped from the row's name when it ends with a colon), in the order they were first seen. */
export function stageRows(samples: ReadonlyMap<string, number[]>, prefix: string): StageRow[] {
  const rows: StageRow[] = [];
  for (const [stage, values] of samples) {
    if (!stage.startsWith(prefix)) continue;
    rows.push({ stage: prefix.endsWith(":") ? stage.slice(prefix.length) : stage, n: values.length, p50: percentile(values, 50), p95: percentile(values, 95), max: Math.max(...values) });
  }
  return rows;
}

/** 0.04 ms, 12 ms, 1.5 s. */
export function formatMs(ms: number): string {
  if (Number.isNaN(ms)) return "-";
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export interface LiveUsage {
  used: number;
  max: number;
  byRole: Record<string, number>;
  costUsd: number | null;
}

export interface ReportInput {
  mode: "mocked" | "live";
  /** Chats run, turns measured, and how many times the set was run (mocked runs repeat it for steadier percentiles). */
  chats: number;
  turns: number;
  rounds: number;
  recorder: Recorder;
  /** Pipeline steps run per turn, on average. */
  stepsPerTurn: number;
  /** Replies that were written a second time because the post-check refused the first. */
  regenerations: number;
  /** The post-check timed on its own over the final replies, in microseconds. */
  postcheck: { n: number; p50Us: number; p95Us: number } | null;
  calls: LiveUsage | null;
  capped: boolean;
  config: { what: string; value: string }[];
}

const pad = (text: string, width: number) => text.padEnd(width);
const padNum = (text: string, width: number) => text.padStart(width);

function table(rows: StageRow[], nameHeader: string): string[] {
  if (rows.length === 0) return ["  (nothing recorded)"];
  const width = Math.max(nameHeader.length, ...rows.map((r) => r.stage.length));
  return [
    `  ${pad(nameHeader, width)}  ${padNum("calls", 6)}  ${padNum("p50", 9)}  ${padNum("p95", 9)}  ${padNum("max", 9)}`,
    ...rows.map((r) => `  ${pad(r.stage, width)}  ${padNum(String(r.n), 6)}  ${padNum(formatMs(r.p50), 9)}  ${padNum(formatMs(r.p95), 9)}  ${padNum(formatMs(r.max), 9)}`),
  ];
}

const NOT_MEASURED = [
  "The wait before a run starts: Inngest debounces a conversation's messages (a 3-second quiet period, at most 15 seconds), so every reply waits at least that long",
  "  after the customer's last message; the figure is in the configured limits, not measured.",
  "Inngest's own per-step time: each step is a separate invocation of the function, and its overhead is not in a local run. The real run has about 6 more steps than this harness runs",
  "  (started, resolve, batch, lead, gate and the read receipt).",
  "The real database: the store is in memory here (resolve, batch, lead, gate and the reads and writes of every step are not timed against Postgres).",
  "The real knowledge-base search (the query embedding and the vector search): the fake search answers at once.",
  "The real send: the sender is a fake, so the Meta call, notify.send's credit and record steps and the webhook that stores the message are not timed.",
];

export function formatReport(input: ReportInput): string[] {
  const live = input.mode === "live";
  const label = live ? "LIVE" : "MOCKED";
  const out: string[] = [];
  out.push(
    live
      ? `LIVE: the real models answered (extraction and reply). The knowledge base, the sender and the store are fakes: nothing is sent and nothing touches a database. At most ${input.calls?.max ?? "?"} model requests.`
      : "MOCKED: the models answer at once, the knowledge base and the store are in memory and nothing is sent. These are the pipeline's own code time, not what a customer waits.",
  );
  out.push(`${input.chats} chat${input.chats === 1 ? "" : "s"}, ${input.turns} turn${input.turns === 1 ? "" : "s"} measured${input.rounds > 1 ? `, the set run ${input.rounds} times` : ""}.`);
  out.push("");

  out.push(`Whole turn [${label}]: the stop check, understanding and the reply, until the reply is handed to the sender`);
  if (input.recorder.turns.length === 0) {
    out.push("  no turns were measured");
  } else {
    const t = input.recorder.turns;
    const over = (ms: number) => t.filter((v) => v > ms).length;
    out.push(`  turns            ${padNum(String(t.length), 8)}`);
    out.push(`  p50              ${padNum(formatMs(percentile(t, 50)), 8)}`);
    out.push(`  p95              ${padNum(formatMs(percentile(t, 95)), 8)}`);
    out.push(`  max              ${padNum(formatMs(Math.max(...t)), 8)}`);
    out.push(`  over 10 s        ${padNum(String(over(10_000)), 8)}   (the target)`);
    out.push(`  over 25 s        ${padNum(String(over(25_000)), 8)}   (the hard stop)`);
  }
  out.push(`  steps per turn (run by this harness)   ${input.stepsPerTurn.toFixed(2)}`);
  out.push("");

  out.push(`By step [${label}]: time inside each pipeline step (a step includes the calls made in it)`);
  out.push(...table(stageRows(input.recorder.samples, "step:"), "step"));
  out.push("");

  out.push(`Calls inside the steps [${live ? "LIVE: the models; everything else mocked" : label}]`);
  const calls = [...stageRows(input.recorder.samples, "llm:"), ...stageRows(input.recorder.samples, "kb"), ...stageRows(input.recorder.samples, "send"), ...stageRows(input.recorder.samples, "booking")];
  out.push(...table(calls, "call"));
  out.push(`  reply regenerated after the post-check   ${input.regenerations}`);
  out.push("");

  out.push("Post-check [MEASURED SEPARATELY]: the same function timed on its own, over the final replies and the chat's own facts");
  out.push(input.postcheck ? `  ${input.postcheck.n} runs: p50 ${Math.round(input.postcheck.p50Us)} µs, p95 ${Math.round(input.postcheck.p95Us)} µs` : "  no reply to check");
  out.push("");

  if (input.calls) {
    out.push("Model requests [LIVE]");
    out.push(`  requests         ${input.calls.used} of ${input.calls.max}${Object.keys(input.calls.byRole).length ? `   (${Object.entries(input.calls.byRole).map(([role, n]) => `${role} ${n}`).join(", ")})` : ""}`);
    out.push(`  cost             ${input.calls.costUsd === null ? "unknown" : `$${input.calls.costUsd.toFixed(4)}`}`);
    if (input.capped) out.push("  The cap was reached: the turn it stopped is left out of the whole-turn numbers and the chats after it were not run.");
    out.push("");
  }

  out.push("Configured limits [CONFIG]: read from the code, not measured");
  const width = Math.max(0, ...input.config.map((row) => row.what.length)) + 2;
  for (const row of input.config) out.push(`  ${pad(row.what, width)}${row.value}`);
  out.push("");

  out.push("Not measured here [NOT MEASURED]");
  for (const line of NOT_MEASURED) out.push(line.startsWith("  ") ? `  ${line.trim()}` : `  - ${line}`);
  return out;
}
