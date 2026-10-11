import { Extraction } from "@pakka/types";
import { NonRetriableError } from "inngest";
import type { KbMatch } from "../../kb/retrieve";
import type { LlmClient, LlmMessage } from "../llm/anthropic";
import { LlmError } from "../llm/anthropic";
import { PackError, resolvePack } from "../packs/load";
import { buildExtractionMessages, buildExtractionSystem, EXTRACTION_PROMPT } from "../prompts/extraction_v2";
import { qualify, type AskField, type Qualification } from "../scoring/qualify";
import { buildReferences, type CatalogRow } from "../scoring/references";
import { interpretExtraction } from "./extraction";
import { UNCLEAR_EXIT_MIN_CONFIDENCE } from "./plan";
import type { StepRunner, TurnContext } from "./process-message";
import type { PipelineStore } from "./store";

// The message pipeline, step 4 (docs/handover.md, module 2: "extraction, fast model, JSON only, validated with
// Zod; on failure retry once, then fall back to ask a clarifying question") and the knowledge-base search that
// goes with it. Continues where `runTurn` stops: it starts from the `TurnContext`.
//
// What it does, each a step: check the pack loads; ask the fast model what the customer's message says and
// validate the answer; keep the details on the lead (only the pack's own fields, each checked against the pack's
// own type) and move a new lead to engaged; search the knowledge base for the customer's question.
//
// What a step returns is kept by Inngest, so it is small facts only. The customer's words, the question and the
// details they gave stay in the database: the extraction is kept on the newest message's meta (`meta.agent`),
// where the next steps read it.

export interface UnderstandDeps {
  store: PipelineStore;
  llm: LlmClient;
  /** A pack's definition by key and version, or null (packs/store.ts; cached, since a published version never changes). */
  loadPackDefinition: (key: string, version: number) => Promise<unknown | null>;
  /** The knowledge-base search (kb/retrieve.ts), for this business. */
  retrieve: (tenantId: string, query: string) => Promise<KbMatch[]>;
  /** The turn's own deadline: when it passes the model call stops. Not wired in production until PR 6 (the reply step owns the deadline). */
  signal?: AbortSignal;
  /**
   * Switches on qualifying (step 5, first half): the lead is scored by code after its details are saved, and the next missing details
   * are worked out. Without it nothing new happens and the result has no `qualification`.
   */
  scoring?: {
    /** The business's catalog items (read only): the price bands, areas and cheapest price the pack's rules compare a customer with. */
    loadCatalog: (tenantId: string) => Promise<CatalogRow[]>;
    /** isEnabled(tenantId, key): "lead_qualification" (qualifying at all) and "custom_scoring" (the business may change weights and thresholds). */
    isEnabled: (tenantId: string, feature: "lead_qualification" | "custom_scoring") => Promise<boolean>;
  };
}

/** What the next steps need to know about the customer's message, without its words. */
export interface ExtractionSummary {
  intent: Extraction["intent"];
  language: Extraction["language"];
  sentiment: Extraction["sentiment"];
  asksIfHuman: boolean;
  /** With intent opt_out: the customer says they are not interested (the lead is then lost). */
  notInterested: boolean;
  confidence: number;
  /** There is a question to answer (it is on the message's meta). */
  hasQuestion: boolean;
  /** The keys of the details found (their values are on the lead). */
  fieldKeys: string[];
}

export interface RetrievedChunk {
  documentId: string;
  title: string | null;
  content: string;
  similarity: number;
}
export type Retrieval =
  | { outcome: "skipped" } // nothing to look up for this kind of message
  | { outcome: "found"; chunks: RetrievedChunk[] }
  | { outcome: "none" } // the knowledge base has no answer above the threshold: a gap
  | { outcome: "unavailable" }; // the search could not run: an outage, not a gap

export type FallbackReason = "no_text" | "invalid_output" | "model_declined";

/** What step 5 needs from qualifying: small facts and the pack's own labels, never the customer's words. */
export interface QualificationSummary {
  score: number;
  temperature: Qualification["temperature"];
  /** The next missing required details to ask for (at most two), with the pack's labels. */
  ask: AskField[];
  missingRequired: string[];
  /** Every required detail is in and the lead is warm or better: a time may be offered. */
  readyForSlots: boolean;
  /** Set when the lead is certainly not a fit (a hard fail of the pack). */
  hardFail: Qualification["hardFail"];
}

export type UnderstandResult =
  | { status: "understood"; summary: ExtractionSummary; retrieval: Retrieval; qualification?: QualificationSummary }
  | { status: "fallback"; reason: FallbackReason } // ask the customer a clarifying question
  | { status: "model_unavailable" } // the model could not be reached after every retry
  | { status: "no_pack" }; // the business's pack is missing or invalid

/** Only these messages are looked up in the knowledge base; a greeting, a complaint or a cancellation is not a question for it. */
/** A customer who may be leaving: what they said is not kept as details, a question to look up, or a sign of being engaged. */
const LEAVING_INTENTS: ReadonlySet<Extraction["intent"]> = new Set(["opt_out", "unclear_exit"]);

export const RETRIEVAL_INTENTS: ReadonlySet<Extraction["intent"]> = new Set(["question", "give_details", "book"]);

const HISTORY_LIMIT = 4;
const TAG = "[pipeline]";
const CORRECTION = "That was not a valid JSON object in the required format. Return only the JSON object, with every key, and nothing else.";

type ExtractOutcome =
  | { outcome: "ok"; summary: ExtractionSummary }
  | { outcome: "fallback"; reason: FallbackReason }
  | { outcome: "model_unavailable" }
  | { outcome: "no_pack" };

/** All the batch's text the model reads; a very long burst keeps its end, which is what the customer last said. */
export const BATCH_TEXT_MAX_CHARS = 4000;
/** Below this confidence a detail does not replace one the lead already has. */
export const OVERWRITE_MIN_CONFIDENCE = 0.5;

/** The business's pack: its definition for the pinned version with its own overrides applied. A missing or invalid pack is `null`. */
async function loadTurnPack(turn: TurnContext, deps: UnderstandDeps, allowScoringOverrides = false) {
  const raw = await deps.loadPackDefinition(turn.vertical, turn.verticalVersion); // an unreachable store throws: retried
  if (raw === null || raw === undefined) return null;
  const overrides = await deps.store.getPackOverrides(turn.tenantId);
  try {
    // Scoring overrides (a Pro-plan feature) play no part in reading a message; only the qualify step asks for them.
    const loaded = resolvePack(raw, overrides, { allowScoringOverrides });
    return loaded.pack.key === turn.vertical && loaded.pack.version === turn.verticalVersion ? loaded : null;
  } catch (error) {
    if (error instanceof PackError) return null;
    throw error;
  }
}

/** What the model reported, with a doubtful unclear_exit replaced by what the message otherwise is, and a leaving customer's words dropped. */
function leavingReading(extraction: Extraction): Extraction {
  if (extraction.intent === "unclear_exit" && extraction.confidence < UNCLEAR_EXIT_MIN_CONFIDENCE) {
    const intent = extraction.question !== null ? "question" : Object.keys(extraction.fields).length > 0 ? "give_details" : "greeting";
    return { ...extraction, intent };
  }
  return LEAVING_INTENTS.has(extraction.intent) ? { ...extraction, fields: {}, question: null } : extraction;
}

const summarise = (extraction: Extraction): ExtractionSummary => ({
  intent: extraction.intent,
  language: extraction.language,
  sentiment: extraction.sentiment,
  asksIfHuman: extraction.asksIfHuman,
  notInterested: extraction.intent === "opt_out" && extraction.notInterested === true,
  confidence: extraction.confidence,
  hasQuestion: extraction.question !== null,
  fieldKeys: Object.keys(extraction.fields),
});

const isScalar = (value: unknown): value is string | number | boolean => ["string", "number", "boolean"].includes(typeof value);
const scalarFields = (fields: Record<string, unknown>): Record<string, string | number | boolean> =>
  Object.fromEntries(Object.entries(fields).filter((e): e is [string, string | number | boolean] => isScalar(e[1])));
const isBlank = (value: unknown) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

/** Ids only, never text: where a failure happened, for whoever reads the log. */
const where = (turn: TurnContext) => `business ${turn.tenantId}, conversation ${turn.conversationId}`;

export async function understandTurn(step: StepRunner, turn: TurnContext, deps: UnderstandDeps): Promise<UnderstandResult> {
  const { store } = deps;
  const lastMessageId = turn.messageIds[turn.messageIds.length - 1];

  // Keeps what was worked out on the newest message. The keys of the other outcome are cleared in the same write, so
  // a re-run never leaves an extraction next to an extractionFailed. A write that fails is tried once more at once
  // (a step retry would call the model again); a message that is not found is a bug, not retried.
  const persist = async (agent: Record<string, unknown>) => {
    const write = () => store.saveAgentMeta(turn.tenantId, turn.conversationId, lastMessageId, { ...agent, at: new Date().toISOString() });
    let saved: boolean;
    try {
      saved = await write();
    } catch (error) {
      if (error instanceof NonRetriableError) throw error;
      saved = await write();
    }
    if (!saved) throw new NonRetriableError("The message was not found.");
  };

  // Ask the model. The client has already retried a model that was slow or unreachable (3 times, capped waits), so
  // a step that fails that way is not repeated: it says so, and the turn reports `model_unavailable`. A run that
  // finds the message already has its extraction (an earlier attempt saved it and then failed) uses it and does not
  // ask again. Anything else that goes wrong is not hidden.
  const extracted = await step.run<ExtractOutcome>("extract", async () => {
    const loaded = await loadTurnPack(turn, deps);
    if (!loaded) return { outcome: "no_pack" };

    const earlier = Extraction.safeParse((await store.getAgentMeta(turn.tenantId, turn.conversationId, lastMessageId))?.extraction);
    if (earlier.success) return { outcome: "ok", summary: summarise(earlier.data) };

    const texts = await store.getBatchTexts(turn.tenantId, turn.conversationId, turn.messageIds);
    const joined = texts.map((t) => t.body?.trim() ?? "").filter(Boolean).join("\n");
    const combined = joined.length > BATCH_TEXT_MAX_CHARS ? joined.slice(-BATCH_TEXT_MAX_CHARS) : joined;
    const fail = async (reason: FallbackReason | "model_unavailable"): Promise<ExtractOutcome> => {
      await persist({ extractionFailed: reason, extraction: null, droppedFields: null });
      return reason === "model_unavailable" ? { outcome: "model_unavailable" } : { outcome: "fallback", reason };
    };
    if (!combined) return fail("no_text");

    const [lead, history] = await Promise.all([
      store.getLead(turn.tenantId, turn.leadId),
      store.getHistory(turn.tenantId, turn.conversationId, texts[0].createdAt, HISTORY_LIMIT),
    ]);
    // Only what the pack still asks for: a field the business has since hidden is not shown to the model.
    const known = Object.fromEntries(Object.entries(scalarFields(lead?.fields ?? {})).filter(([key]) => Object.hasOwn(loaded.fieldSchema.shape, key)));
    const first: LlmMessage[] = buildExtractionMessages({ message: combined, recent: history.map((h) => ({ sender: h.sender, text: h.body })), known });
    const ask = (messages: LlmMessage[]) =>
      deps.llm.complete({ role: "extraction", tenantId: turn.tenantId, conversationId: turn.conversationId, prompt: EXTRACTION_PROMPT, system: buildExtractionSystem(loaded.pack), messages, signal: deps.signal });

    // One try, and one more with the reason if the answer is not usable (docs/handover.md). The second try also
    // covers an answer that was cut off or empty, with nothing added to the request.
    let followUp: LlmMessage[] = first;
    for (let attempt = 1; attempt <= 2; attempt++) {
      let text: string | undefined;
      try {
        text = (await ask(followUp)).text;
      } catch (error) {
        if (!(error instanceof LlmError)) throw error;
        if (error.code === "refusal") return fail("model_declined");
        if (error.code === "rejected" || error.code === "invalid_request") throw new NonRetriableError("The language model refused the request."); // our bug: not retried
        if (error.code === "aborted") {
          // The turn's time is up: say so (the reply step sends the safe line); a retry would only be aborted again.
          if (deps.signal?.aborted) return fail("model_unavailable");
          throw error;
        }
        if (error.retryable) return fail("model_unavailable");
        // truncated or empty: ask once more, as it was
        if (attempt === 2) return fail("invalid_output");
        continue;
      }
      const interpreted = interpretExtraction(text, loaded.fieldSchema);
      if (interpreted.ok) {
        const { dropped } = interpreted;
        // A customer who is leaving: what they said is not kept as details or as a question to look up. An unclear_exit the
        // model is not sure of (a stray character, "ok", "?") is read as what the message otherwise is, so a real question or
        // details typed with it are not lost (plan.ts then answers it like any message).
        const extraction = leavingReading(interpreted.extraction);
        await persist({ extraction, droppedFields: dropped, extractionFailed: null });
        return { outcome: "ok", summary: summarise(extraction) };
      }
      if (attempt === 2) return fail("invalid_output");
      followUp = [...first, { role: "assistant", content: text }, { role: "user", content: CORRECTION }];
    }
    return fail("invalid_output");
  });
  if (extracted.outcome === "no_pack") {
    console.error(`${TAG} the business's pack is missing or invalid (${where(turn)})`);
    return { status: "no_pack" };
  }
  if (extracted.outcome === "model_unavailable") {
    console.error(`${TAG} the language model could not be reached (${where(turn)})`);
    return { status: "model_unavailable" };
  }
  if (extracted.outcome === "fallback") return { status: "fallback", reason: extracted.reason };

  // The details go on the lead, over what it has: only the pack's own fields (re-checked here against the pack as
  // it is now), never replacing an answer with the same one, and a doubtful reading (low confidence) only fills a
  // gap. A customer who is leaving (opt_out) is not engaged and their words are not kept as details.
  const { summary } = extracted;
  await step.run("save-fields", async () => {
    if (LEAVING_INTENTS.has(summary.intent)) return { saved: false };
    const loaded = await loadTurnPack(turn, deps);
    if (!loaded) return { saved: false };
    const lead = await store.getLead(turn.tenantId, turn.leadId);
    if (!lead) return { saved: false };
    const agent = await store.getAgentMeta(turn.tenantId, turn.conversationId, lastMessageId);
    const offered = scalarFields((agent?.extraction as { fields?: Record<string, unknown> } | undefined)?.fields ?? {});
    const checked = loaded.fieldSchema.safeParse(offered);
    const valid = checked.success ? scalarFields(checked.data as Record<string, unknown>) : {};
    const patch = Object.fromEntries(
      Object.entries(valid).filter(([key, value]) => {
        const existing = lead.fields[key];
        if (existing === value) return false;
        return isBlank(existing) || summary.confidence >= OVERWRITE_MIN_CONFIDENCE;
      }),
    );
    // A lead that is gone (false) is not an error to repeat: there is nothing to save to.
    const merged = await store.mergeLeadFields(turn.tenantId, turn.leadId, patch, true); // a customer who wrote and was understood is engaged
    return { saved: merged, fieldKeys: Object.keys(patch) };
  });

  // Step 5, first half: score the lead against the business's catalog and work out what to ask next. Not for a customer who is leaving.
  const scoring = deps.scoring;
  const qualification =
    scoring && !LEAVING_INTENTS.has(summary.intent)
      ? await step.run<QualificationSummary | null>("qualify", async () => {
          if (!(await scoring.isEnabled(turn.tenantId, "lead_qualification"))) return null;
          const loaded = await loadTurnPack(turn, deps, await scoring.isEnabled(turn.tenantId, "custom_scoring"));
          if (!loaded) return null;
          const lead = await store.getLead(turn.tenantId, turn.leadId);
          if (!lead) return null;
          let rows: CatalogRow[] = [];
          try {
            rows = await scoring.loadCatalog(turn.tenantId);
          } catch (error) {
            // A catalog that cannot be read is not worth failing the customer's message for: the rules that need it earn nothing.
            console.error(`${TAG} the catalog could not be read (${error instanceof Error ? error.name : "unknown"}; ${where(turn)})`);
          }
          const result = qualify(loaded.pack, lead.fields, { references: buildReferences(loaded.pack, rows) });
          await store.saveLeadScore(turn.tenantId, turn.leadId, { score: result.score, temperature: result.temperature });
          return { score: result.score, temperature: result.temperature, ask: result.ask, missingRequired: result.missingRequired, readyForSlots: result.readyForSlots, hardFail: result.hardFail };
        })
      : null;

  const retrieval = await step.run<Retrieval>("retrieve", async () => {
    if (!summary.hasQuestion || !RETRIEVAL_INTENTS.has(summary.intent)) return { outcome: "skipped" };
    const agent = await store.getAgentMeta(turn.tenantId, turn.conversationId, lastMessageId);
    const question = (agent?.extraction as { question?: unknown } | undefined)?.question;
    if (typeof question !== "string" || !question) return { outcome: "skipped" };
    try {
      const matches = await deps.retrieve(turn.tenantId, question);
      return matches.length === 0
        ? { outcome: "none" }
        : { outcome: "found", chunks: matches.map((m) => ({ documentId: m.documentId, title: m.title, content: m.content, similarity: m.similarity })) };
    } catch (error) {
      // An outage is not a gap in the knowledge base: the class only, never the query. The turn goes on without
      // an answer from the knowledge base (the reply step then says it will check), as a search that is down is
      // not worth failing a customer's whole message for.
      console.error(`${TAG} the knowledge-base search failed (${error instanceof Error ? error.name : "unknown"}; ${where(turn)})`);
      return { outcome: "unavailable" };
    }
  });

  return qualification ? { status: "understood", summary, retrieval, qualification } : { status: "understood", summary, retrieval };
}
