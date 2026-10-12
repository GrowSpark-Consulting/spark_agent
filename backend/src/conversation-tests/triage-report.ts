// What the triage harness prints: one block per message, then a table of the languages the model read and how many of those readings were weak.

export const LOW_CONFIDENCE = 0.6;

export interface MessageRow {
  customer: string;
  /** ok: run; capped: the call cap stopped it part-way; not_run: the cap was reached before it. */
  status: "ok" | "capped" | "not_run";
  language: string | null;
  sentiment: string | null;
  fields: Record<string, unknown>;
  intent: string | null;
  confidence: number | null;
  /** What the pipeline did (the reply step's row, "stop_phrase", ...). */
  action: string;
  handoff: string | null;
  optedOut: boolean;
  reply: string | null;
  /** What went wrong with this message (the pipeline threw, a check failed), so an error is not mistaken for a silent outcome. */
  notes: string[];
}

export interface TriageUsage {
  calls: number;
  max: number;
  byRole: Record<string, number>;
  /** Estimated dollars from the model results; null when a model has no price. */
  costUsd: number | null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const low = (confidence: number | null) => confidence !== null && confidence < LOW_CONFIDENCE;
const showField = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

export function formatChat(index: number, name: string, rows: MessageRow[]): string[] {
  const out = [`chat ${index}: "${name}" (${plural(rows.length, "message")})`];
  for (const [i, row] of rows.entries()) {
    out.push(`  [${i + 1}] customer: ${row.customer}`);
    if (row.status === "not_run") {
      out.push("      not run (call cap reached)");
      continue;
    }
    const fields = Object.entries(row.fields);
    out.push(`      language: ${row.language ?? "-"}     sentiment: ${row.sentiment ?? "-"}`);
    out.push(
      `      intent:   ${row.intent ?? "-"} (${row.confidence ?? "-"})     action: ${row.action}${row.handoff ? `, handoff ${row.handoff}` : ""}${row.optedOut ? ", OPTED OUT" : ""}${low(row.confidence) ? "   <-- low confidence" : ""}`,
    );
    out.push(`      fields:   ${fields.length === 0 ? "(none)" : fields.map(([k, v]) => `${k}=${showField(v)}`).join(", ")}`);
    out.push(`      reply:    ${row.reply ?? "(none)"}`);
    for (const note of row.notes) out.push(`      note: ${note}`);
    if (row.status === "capped") out.push("      (stopped at the call cap)");
  }
  return out;
}

export interface Summary {
  run: number;
  notRun: number;
  low: number;
  withNotes: number;
  languages: { language: string; messages: number; low: number }[];
}

/** Per language the model read: how many messages, and how many of them had an intent confidence below 0.6. A message not run is not counted. */
export function summarize(rows: MessageRow[]): Summary {
  const byLanguage = new Map<string, { messages: number; low: number }>();
  let notRun = 0;
  let lowTotal = 0;
  let run = 0;
  let withNotes = 0;
  for (const row of rows) {
    if (row.status === "not_run") {
      notRun++;
      continue;
    }
    run++;
    if (row.notes.length > 0) withNotes++;
    const key = row.language ?? "-";
    const entry = byLanguage.get(key) ?? { messages: 0, low: 0 };
    entry.messages++;
    if (low(row.confidence)) {
      entry.low++;
      lowTotal++;
    }
    byLanguage.set(key, entry);
  }
  const languages = [...byLanguage.entries()]
    .map(([language, v]) => ({ language, ...v }))
    .sort((a, b) => b.messages - a.messages || a.language.localeCompare(b.language));
  return { run, notRun, low: lowTotal, withNotes, languages };
}

export function formatSummary(summary: Summary, usage: TriageUsage): string[] {
  const out = [`summary: ${plural(summary.run, "message")} run, ${summary.notRun} not run${summary.notRun > 0 ? " (call cap reached)" : ""}${summary.withNotes > 0 ? `, ${summary.withNotes} with notes` : ""}`];
  if (summary.languages.length > 0) {
    const width = Math.max(8, ...summary.languages.map((l) => l.language.length)) + 3;
    const line = (a: string, b: string | number, c: string | number) => `${a.padEnd(width)}${String(b).padEnd(11)}${c}`;
    out.push(line("language", "messages", "confidence below 0.6"));
    for (const l of summary.languages) out.push(line(l.language, l.messages, l.low));
    out.push(line("total", summary.run, summary.low));
  }
  const roles = Object.entries(usage.byRole).map(([role, n]) => `${role} ${n}`).join(", ");
  out.push(`calls: ${usage.calls} of ${usage.max}${roles ? ` (${roles})` : ""}; ${usage.costUsd === null ? "estimated cost unknown" : `estimated cost $${usage.costUsd.toFixed(2)}`}`);
  return out;
}
