import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { NonRetriableError } from "inngest";
import { vi } from "vitest";
import { MessageReceived } from "../agent/pipeline/events";
import { LlmError, type LlmClient, type LlmRequest, type LlmResult } from "../agent/llm/anthropic";
import { createSystemNoticePort } from "../agent/pipeline/ports";
import { answerAfterFailure, replyTurn, type ReplyDeps } from "../agent/pipeline/reply";
import { BATCH_WINDOW_MS, runTurn, type StepRunner } from "../agent/pipeline/process-message";
import { stopCheck, stopCheckAfterGate } from "../agent/pipeline/stop";
import { isAiLimit, type AiLimit } from "../lib/ai-limits";
import { turnClock } from "../agent/pipeline/turn-deadline";
import { understandTurn, type UnderstandDeps } from "../agent/pipeline/understand";
import { markReadStep, type MarkReadDeps } from "../channels/whatsapp/mark-read";
import { createSentReplyRecorded } from "../agent/pipeline/reply-record";
import { keyedMessageId } from "../notify/send";
import type { AuditEntry } from "../lib/audit";
import type { NotifyPayload, SendOutcome } from "../notify/send";
import { fakePipelineStore, type FakeMessage } from "./fake-pipeline-store";

// The WHOLE-TURN world (Day 7, PR A): one customer message goes in through the REAL inbound webhook handler, becomes a `whatsapp/message.received`
// event, and is run through the pipeline in the same order as inngest/process-message.ts, by an emulator that behaves like Inngest (the function body
// is replayed after a step fails, finished steps return what they returned, 3 retries per step, then the failure handler). Everything that costs money or
// touches the outside is a FAKE: the language model (scripted), the database (fakePipelineStore) and notify.send (FakeNotify below).
//
// FakeNotify IS A FAKE. It is not Dev 2's notify.send (backend/src/notify/send.ts) and proves nothing about it. It copies only the parts of its contract
// the pipeline relies on, so that a test can count what a customer would receive: a send under an idempotency key that was recorded returns the first
// outcome and sends nothing; credits are spent by reference before the send and refunded by reference when it fails (as #163 made them); an unknown
// outcome refunds the credits and is never resent (contracts decision 16); an opted-out contact is refused; and (Day 7, Dev 2, migration 0045) a keyed
// send is CLAIMED before the provider is asked, so a repeat after an attempt that never recorded or released its claim (the process died, notify_record
// failed, or the outcome was unknown) is answered "unknown" and sends nothing, while a refusal for certain releases the claim. Delivery by the provider
// and the record notify_record writes are counted separately, because "may have gone out" and "recorded" are different things.

// WHERE THE FAKE IS MORE FORGIVING THAN THE REAL notify.send (backend/src/notify/send.ts), found by review: an error reading the earlier send of a key,
// or claiming it (the real one throws); the template fallback under key <key>#template and its different cost; the 24-hour window and the feature check; spend and refund that can
// throw; unexpected sender errors (non-retryable upstream_failed); credits locked in a transaction; the dedupe is not scoped to the business; and "never
// negative" is enforced by the fake itself. None of these can be shown wrong by these tests.

export const TENANT = "e0000000-0000-4000-8000-00000000000a";
export const CONV = "c0000000-0000-4000-8000-00000000000c";
export const CONTACT = "b0000000-0000-4000-8000-0000000000b1";
const CHANNEL = "ch-1";
const WABA = "100000000000001";
const PNID = "200000000000001";
const CONNECTION = "c0000000-0000-4000-8000-0000000000a1";
const PHONE = "910000000101";
const APP_SECRET = "synthetic-meta-app-secret";
const PACKS_DIR = fileURLToPath(new URL("../../../packs", import.meta.url));

// ---------------------------------------------------------------------------------------------------------------------
// The language model, scripted

/** A string is the answer, an Error is thrown, a function runs (it may change the world mid-run: an opt-out, a takeover) and returns the answer. */
export type ModelItem = string | Error | (() => string);
export interface ModelScript {
  /** What the extraction model answers, one item per call; the last one repeats. */
  extraction?: ModelItem[];
  /** What the reply model answers, one item per call; the last one repeats. */
  reply?: ModelItem[];
}

export const GOOD_EXTRACTION = JSON.stringify({ language: "en", intent: "question", fields: {}, question: "price of a 2BHK?", preferredTime: null, sentiment: "neutral", asksIfHuman: false, confidence: 0.9 });
export const GOOD_REPLY = "A 2BHK starts at ₹78 lakh. Would you like to visit?";
export const timeout = () => new LlmError("timeout", undefined, 3);

const llmResult = (text: string): LlmResult => ({ text, model: "mock", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, latencyMs: 0, attempts: 1, requestId: null });

function scriptedLlm(script: ModelScript) {
  const next = { extraction: 0, reply: 0 };
  const calls = { extraction: 0, reply: 0 };
  const client: LlmClient = {
    async complete(request: LlmRequest) {
      const role = request.role === "extraction" ? "extraction" : "reply";
      calls[role]++;
      const items = (role === "extraction" ? script.extraction : script.reply) ?? [role === "extraction" ? GOOD_EXTRACTION : GOOD_REPLY];
      const item = items[Math.min(next[role]++, items.length - 1)];
      if (item instanceof Error) throw item;
      return llmResult(typeof item === "function" ? item() : item);
    },
  };
  return { client, calls };
}

// ---------------------------------------------------------------------------------------------------------------------
// FAKE notify.send

/** What the fake does on one ai_reply attempt (consumed in order; after the list, `ok`). */
export type SendScript =
  | "ok" // delivered and recorded
  | "retryable" // refused, and waiting may fix it (rate limit): nothing delivered, credits refunded
  | "permanent" // refused for good (the number is not connected): nothing delivered, credits refunded
  | "unknown_delivered" // no answer in time, and the provider DID deliver: failed + outcomeUnknown, credits refunded, nothing recorded
  | "unknown_lost" // no answer in time, and the provider did NOT deliver: failed + outcomeUnknown, credits refunded, nothing recorded
  | "ok_unrecorded" // delivered, reported as sent, but notify_record failed (send.ts logs it and reports sent): nothing recorded; the claim stays, so a later send of the key is answered "unknown"
  | "crash_after_accept"; // the provider delivered, then the process died before notify_record: nothing recorded, credits kept, the claim stays, the caller sees an exception

export interface Delivery {
  kind: string;
  key: string | undefined;
  text: string;
}

export class FakeNotify {
  /** FAKE of notify.send. See the note at the top of this file. */
  readonly isFake = true;
  balance: number;
  /** Per reference: credits spent and refunded. */
  readonly ledger = new Map<string, { spent: number; refunded: number }>();
  /** What the provider delivered to the customer (a send that "may have gone out" counts when the script says it did). */
  readonly deliveries: Delivery[] = [];
  /** What notify_record wrote (the outbound rows). */
  readonly rows: Delivery[] = [];
  /** Every call, answered or not. */
  readonly calls: { kind: string; key: string | undefined }[] = [];
  private readonly recorded = new Map<string, SendOutcome>();
  /** Keyed sends claimed before the provider is asked (0045): "sending" until recorded, or released by a refusal for certain. */
  private readonly claims = new Map<string, "sending" | "released">();
  private scripts: SendScript[];
  private seq = 0;

  private readonly isOptedOut: () => boolean;

  /** Called right after a reply was delivered and reported as sent, recorded or not (`ok` and `ok_unrecorded`). */
  afterDelivered: () => void = () => undefined;
  /** Called when a send is recorded (the row notify_record writes), with the id notify.send gives it (keyedMessageId, as the real one does). */
  onRecorded: (delivery: Delivery, messageId: string) => void = () => undefined;
  /** Called right after a reply was delivered and recorded (a test uses it to make the NEXT store write fail, as when a process dies between the send and its records). */
  afterRecorded: () => void = () => undefined;

  constructor(options: { balance?: number; scripts?: SendScript[]; isOptedOut: () => boolean }) {
    this.balance = options.balance ?? 10;
    this.scripts = [...(options.scripts ?? [])];
    this.isOptedOut = options.isOptedOut;
  }

  /** Credits spent and not given back, in all. */
  get creditsNet(): number {
    return [...this.ledger.values()].reduce((sum, e) => sum + e.spent - e.refunded, 0);
  }

  private spend(ref: string): boolean {
    if (this.balance < 1) return false;
    this.balance -= 1;
    const entry = this.ledger.get(ref) ?? { spent: 0, refunded: 0 };
    entry.spent += 1;
    this.ledger.set(ref, entry);
    return true;
  }

  /** Gives back what the reference has spent and not had refunded (#163: every failed attempt of a retried keyed send is refunded). */
  private refund(ref: string): void {
    const entry = this.ledger.get(ref);
    if (!entry) return;
    const owed = entry.spent - entry.refunded;
    this.balance += owed;
    entry.refunded += owed;
  }

  send = async (_tenantId: string, kind: "ai_reply" | "system_notice", payload: NotifyPayload): Promise<SendOutcome> => {
    const key = payload.idempotencyKey;
    this.calls.push({ kind, key });
    const recordedKey = key === undefined ? undefined : `${kind}:${key}`;
    if (recordedKey !== undefined) {
      const earlier = this.recorded.get(recordedKey);
      if (earlier) return earlier;
    }
    if (kind === "ai_reply" && this.isOptedOut()) return { status: "skipped", reason: "opted_out" };
    const inDoubt: SendOutcome = { status: "failed", error: { code: "upstream_failed", message: "fake: an earlier attempt may have gone out", retryable: true, outcomeUnknown: true } };
    if (recordedKey !== undefined) {
      if (this.claims.get(recordedKey) === "sending") return inDoubt;
      this.claims.set(recordedKey, "sending");
    }
    const release = () => void (recordedKey !== undefined && this.claims.set(recordedKey, "released"));
    const cost = kind === "ai_reply" ? 1 : 0;
    const ref = recordedKey ?? `anon:${++this.seq}`;
    if (cost > 0 && !this.spend(ref)) {
      release();
      return { status: "skipped", reason: "insufficient_credits" };
    }

    const text = payload.interactive ? payload.interactive.body : (payload.text ?? "");
    const delivery: Delivery = { kind, key, text };
    const script: SendScript = kind === "ai_reply" ? (this.scripts.shift() ?? "ok") : "ok";
    const failed = (retryable: boolean, outcomeUnknown: boolean, code: string): SendOutcome => ({ status: "failed", error: { code, message: "fake", retryable, outcomeUnknown } });
    switch (script) {
      case "ok": {
        this.deliveries.push(delivery);
        this.rows.push(delivery);
        // The real one gives a keyed send the id keyedMessageId(business, kind, key): the failure handler finds the recorded reply by it.
        const messageId = key !== undefined ? keyedMessageId(_tenantId, kind, key) : `m-${++this.seq}`;
        const outcome: SendOutcome = { status: "sent", messageId, providerMsgId: `wamid.OUT${++this.seq}`, creditsCharged: cost, usedTemplate: false };
        if (recordedKey !== undefined) this.recorded.set(recordedKey, outcome);
        this.onRecorded(delivery, messageId);
        if (kind === "ai_reply") {
          this.afterRecorded();
          this.afterDelivered();
        }
        return outcome;
      }
      case "ok_unrecorded":
        this.deliveries.push(delivery);
        this.afterDelivered();
        return { status: "sent", messageId: `m-${++this.seq}`, providerMsgId: `wamid.OUT${this.seq}`, creditsCharged: cost, usedTemplate: false };
      case "retryable":
        this.refund(ref);
        release();
        return failed(true, false, "rate_limited");
      case "permanent":
        this.refund(ref);
        release();
        return failed(false, false, "whatsapp_not_connected");
      case "unknown_delivered":
        this.deliveries.push(delivery);
        this.refund(ref);
        return failed(false, true, "timeout");
      case "unknown_lost":
        this.refund(ref);
        return failed(false, true, "timeout");
      case "crash_after_accept":
        this.deliveries.push(delivery);
        throw new Error("the process died after the provider accepted the message (simulated)");
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// An Inngest-like runner

class RetryNow extends Error {}
class RunFailed extends Error {
  constructor(
    readonly stepId: string,
    readonly cause: unknown,
  ) {
    super(`the run failed in step ${stepId}`);
  }
}

/** A step that fails on purpose: `before` it runs (nothing was done), or `after` it ran (its work is done and its result is lost, as when a process dies). */
export interface Injection {
  stepId: string;
  when: "before" | "after";
  /** For how many attempts (default 1). */
  times?: number;
}

export interface RunReport {
  status: "completed" | "failed";
  /** Step ids in the order they first finished. */
  steps: string[];
  /** How often each step was attempted. */
  attempts: Record<string, number>;
  returned: unknown;
  /** What the failure handler did, for a run that gave up. */
  giveUp?: string;
}

export interface StepApi extends StepRunner {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

const UNDEFINED = "\u0000undefined";

// ---------------------------------------------------------------------------------------------------------------------
// The world

export interface WorldOptions {
  model?: ModelScript;
  sends?: SendScript[];
  balance?: number;
  optedOut?: boolean;
  mode?: "ai" | "human" | "external";
  /** isEnabled(tenant, "ai_auto_reply"): the business has the assistant on (the default). */
  featureEnabled?: boolean;
  /** A rate limit or the daily AI spend cap the chat has reached (lib/ai-limits.ts); none by default. */
  aiLimit?: AiLimit | null;
  /** Inngest drops an event whose id it has seen (the default). False: both copies are delivered. */
  dedupeEvents?: boolean;
}

export interface Event {
  id: string;
  name: string;
  data: Record<string, string>;
}

export async function createWorld(options: WorldOptions = {}) {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-service-key");
  vi.stubEnv("EMBEDDINGS_API_KEY", "synthetic-embeddings-key");
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-anthropic-key");
  vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "synthetic-route-token");
  vi.stubEnv("META_APP_SECRET", APP_SECRET);
  const { handleWhatsAppWebhook } = await import("../channels/whatsapp/inbound");

  const pack = JSON.parse(readFileSync(`${PACKS_DIR}/real-estate.json`, "utf8")) as { key: string; version: number };
  const fake = fakePipelineStore({
    tenants: [{ id: TENANT, vertical: pack.key, verticalVersion: pack.version }],
    messages: [],
    conversations: [{ id: CONV, tenantId: TENANT, contactId: CONTACT, mode: options.mode ?? "ai" }],
    contacts: [{ id: CONTACT, tenantId: TENANT, language: null, optedOut: options.optedOut ?? false, consentAt: "2026-10-01T00:00:00Z" }],
    leads: [],
    tenantInfo: { [TENANT]: { name: "Skyline Homes", agentSettings: {} } },
  });
  const notify = new FakeNotify({ balance: options.balance, scripts: options.sends, isOptedOut: () => fake.contacts.get(CONTACT)?.optedOut === true });
  // notify_record wrote a row: it is a message of the chat, under the id notify.send gave it.
  notify.onRecorded = (delivery, messageId) => {
    fake.messages.set(messageId, { id: messageId, tenantId: TENANT, conversationId: CONV, direction: "out", sender: delivery.kind === "ai_reply" ? "ai" : "system", kind: "text", createdAt: new Date().toISOString(), body: delivery.text, meta: {} } as FakeMessage);
  };
  const model = scriptedLlm(options.model ?? {});

  // Messages the webhook stored, by the provider's id (the database's store_inbound_message is idempotent on it).
  const stored = new Map<string, string>();
  let storedCount = 0;
  const events: (Event & { dropped: boolean; ran: boolean })[] = [];
  const seenEventIds = new Set<string>();
  const dedupe = options.dedupeEvents ?? true;
  const handoffEvents: Event[] = [];
  const audits: AuditEntry[] = [];

  const webhookDeps = {
    findConnections: async (ids: string[]) => (ids.includes(PNID) ? [{ id: CONNECTION, tenantId: TENANT, channelId: CHANNEL, phoneNumberId: PNID, wabaId: WABA, method: "platform", status: "active" }] : []),
    findConnectionsByWaba: async () => [],
    findByoSecrets: async () => [],
    storeInboundMessage: async (args: { providerMsgId: string; kind: string; body: string | null; sentAt: string }) => {
      const existing = stored.get(args.providerMsgId);
      if (existing) return { conversationId: CONV, messageId: existing, inserted: false };
      const messageId = `a0000000-0000-4000-8000-${String(++storedCount).padStart(12, "0")}`;
      stored.set(args.providerMsgId, messageId);
      const message: FakeMessage = { id: messageId, tenantId: TENANT, conversationId: CONV, direction: "in", sender: "customer", kind: args.kind as FakeMessage["kind"], createdAt: args.sentAt, body: args.body, meta: {} };
      fake.messages.set(messageId, message);
      return { conversationId: CONV, messageId, inserted: true };
    },
    applyMessageStatus: async () => true,
    templateBelongsToTenant: async () => false,
    setTemplateStatus: async () => false,
    updateConnectionHealth: async () => undefined,
    sendEvent: async (event: Event) => {
      const dropped = dedupe && seenEventIds.has(event.id);
      seenEventIds.add(event.id);
      events.push({ ...event, dropped, ran: false });
    },
  };

  /** The base of the customer's clock: a little in the past, so a burst and a later turn are both "before now". */
  const base = Math.floor(Date.now() / 1000) - 120;

  /** A message from the customer, through the real webhook handler. `at` is seconds after the base. */
  async function post(providerMsgId: string, content: { text: string } | { audio: true }, at = 0): Promise<Response> {
    const message = "text" in content ? { type: "text", text: { body: content.text } } : { type: "audio", audio: { id: `media-${providerMsgId}`, mime_type: "audio/ogg; codecs=opus" } };
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: WABA,
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "910000000001", phone_number_id: PNID },
                contacts: [{ profile: { name: "Test Customer" }, wa_id: PHONE }],
                messages: [{ from: PHONE, id: providerMsgId, timestamp: String(base + at), ...message }],
              },
            },
          ],
        },
      ],
    });
    const signature = `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;
    const request = new Request("http://localhost:4000/api/webhooks/whatsapp", { method: "POST", body, headers: { "content-type": "application/json", "x-hub-signature-256": signature } });
    return handleWhatsAppWebhook(request, webhookDeps as unknown as Parameters<typeof handleWhatsAppWebhook>[1]);
  }

  // The pipeline's dependencies, as inngest/process-message.ts gets them from runtime.ts, with fakes behind them.
  let auditFailures = 0;
  const audit = async (entry: AuditEntry) => {
    if (auditFailures > 0) {
      auditFailures--;
      throw new Error("the audit log is down (simulated)");
    }
    audits.push(entry);
    if (entry.action === "message.answered" && entry.entityId) fake.answered.set(entry.entityId, Date.now());
  };
  const replyDeps: ReplyDeps = {
    store: fake.store,
    llm: model.client,
    send: (tenantId, kind, payload) => notify.send(tenantId, kind, payload),
    audit,
    sendEvent: async (event) => void handoffEvents.push(event as Event),
    sentReplyRecorded: createSentReplyRecorded(fake.store),
    systemNotice: createSystemNoticePort((tenantId, kind, payload) => notify.send(tenantId, kind, payload)),
    privacyPolicyUrl: "https://example.test/privacy",
  };
  const understandDeps = (signal?: AbortSignal): UnderstandDeps => ({
    store: fake.store,
    llm: model.client,
    loadPackDefinition: async (key, version) => (key === pack.key && version === pack.version ? (pack as unknown) : null),
    retrieve: async () => [{ chunkId: "c1", documentId: "d1", title: "Price list", content: "2BHK of 950 sq ft in Velachery starts at ₹78 lakh.", similarity: 0.8 }],
    signal,
    // Qualifying is on, as in runtime.ts (an empty catalog: no rule that needs one earns anything), so its step is part of the turn.
    scoring: { loadCatalog: async () => [], isEnabled: async () => true },
  });
  // The read receipt reaches Meta and the database in production; here it is always "late", so it skips without touching either (it never fails a turn).
  const lateMarkRead = (startedAt: number): MarkReadDeps => ({ db: {} as MarkReadDeps["db"], markRead: vi.fn() as unknown as MarkReadDeps["markRead"], now: () => startedAt + 60_000 });

  /**
   * The body of the process-message function, in the order of inngest/process-message.ts (whole-turn.test.ts guards that it stays so). Left out: the
   * "external-notice" step for a chat a team member handles from their own number, and the "limit-notice" step that tells the owners a limit stopped
   * the assistant (both need the database; they have their own tests).
   */
  async function processMessageBody(event: { data: unknown }, step: StepApi): Promise<unknown> {
    const startedAt = await step.run("started", async () => Date.now());
    const turn = await runTurn(step, event.data, { store: fake.store, isEnabled: async () => options.featureEnabled ?? true, aiLimit: async () => options.aiLimit ?? null });
    if (turn.status !== "ready") {
      if (turn.status === "gated_off" && (turn.reason === "not_ai_mode" || turn.reason === "feature_off" || isAiLimit(turn.reason))) {
        const ids = MessageReceived.safeParse(event.data);
        if (ids.success) await stopCheckAfterGate(step, ids.data, replyDeps);
      }
      return turn;
    }
    const stop = await stopCheck(step, turn.turn, replyDeps);
    if (stop.status === "opted_out") return { status: "opted_out" };
    const [understood] = await Promise.all([understandTurn(step, turn.turn, understandDeps(turnClock(startedAt).signal)), markReadStep(step, turn.turn, startedAt, lateMarkRead(startedAt))]);
    const replied = await replyTurn(step, turn.turn, understood, startedAt, replyDeps);
    return { status: understood.status, reply: replied.reply.status };
  }

  /** The failure handler of the function: one safe line if the customer is still unanswered (give-up.ts, without its own database client). */
  async function onFailure(event: { data: unknown }): Promise<string> {
    const ids = MessageReceived.safeParse(event.data);
    if (!ids.success) return "invalid_event";
    try {
      return await answerAfterFailure(ids.data, BATCH_WINDOW_MS, replyDeps);
    } catch {
      return "not_sent";
    }
  }

  /** Runs the function once for an event, like Inngest: a failing step is retried (the body is replayed, finished steps return what they returned), 3 retries, then the failure handler. */
  async function runFunction(event: { data: unknown }, inject: Injection[] = [], retries = 3): Promise<RunReport> {
    const memo = new Map<string, string>();
    const attempts = new Map<string, number>();
    const inflight = new Map<string, Promise<unknown>>();
    const finished: string[] = [];
    const step: StepApi = {
      run<T>(id: string, fn: () => Promise<T>): Promise<T> {
        // Inngest never runs one step concurrently with itself: a replay that reaches a step still running waits for it.
        const running = inflight.get(id);
        if (running) return running as Promise<T>;
        const promise = runOnce<T>(id, fn);
        inflight.set(id, promise);
        const forget = () => void (inflight.get(id) === promise && inflight.delete(id));
        promise.then(forget, forget);
        return promise;
      },
    };
    const runOnce = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
      {
        if (memo.has(id)) {
          const kept = memo.get(id) as string;
          return (kept === UNDEFINED ? undefined : JSON.parse(kept)) as T;
        }
        const n = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, n);
        const injected = inject.find((i) => i.stepId === id);
        const times = injected?.times ?? 1;
        let value: T;
        try {
          if (injected?.when === "before" && n <= times) throw new Error(`step ${id} failed before it ran (injected)`);
          value = await fn();
          if (injected?.when === "after" && n <= times) throw new Error(`step ${id} failed after it ran (injected)`);
        } catch (error) {
          if (error instanceof NonRetriableError || n > retries) throw new RunFailed(id, error);
          throw new RetryNow();
        }
        // What Inngest keeps is the JSON of the result.
        memo.set(id, value === undefined ? UNDEFINED : JSON.stringify(value));
        finished.push(id);
        return value;
      }
    };
    const report = (status: RunReport["status"], returned: unknown, giveUp?: string): RunReport => ({ status, steps: finished, attempts: Object.fromEntries(attempts), returned, ...(giveUp === undefined ? {} : { giveUp }) });
    for (;;) {
      try {
        const returned = await processMessageBody(event, step);
        return report("completed", returned);
      } catch (error) {
        if (error instanceof RetryNow) continue;
        if (error instanceof RunFailed) return report("failed", undefined, await onFailure(event));
        throw error;
      }
    }
  }

  /** Runs the function for every event that has not run and was not dropped (`debounce`: only the last one of the conversation, as the debounce keeps only the last). */
  async function drain(run: { debounce?: boolean; inject?: Injection[] } = {}): Promise<RunReport[]> {
    let queue = events.filter((e) => e.name === "whatsapp/message.received" && !e.dropped && !e.ran);
    if (run.debounce && queue.length > 1) {
      for (const e of queue.slice(0, -1)) e.ran = true;
      queue = queue.slice(-1);
    }
    const reports: RunReport[] = [];
    for (const e of queue) {
      e.ran = true;
      reports.push(await runFunction({ data: e.data }, run.inject));
    }
    return reports;
  }

  /** What happened, from the customer's side and the books'. */
  function report() {
    const inbound = [...fake.messages.values()].filter((m) => m.direction === "in" && m.sender === "customer").map((m) => m.id);
    return {
      /** AI replies the customer received. */
      replies: notify.deliveries.filter((d) => d.kind === "ai_reply"),
      /** System notices the customer received (the STOP confirmation, the holding line). */
      notices: notify.deliveries.filter((d) => d.kind === "system_notice"),
      /** Outbound AI-reply rows notify_record wrote. */
      replyRows: notify.rows.filter((d) => d.kind === "ai_reply").length,
      creditsNet: notify.creditsNet,
      balance: notify.balance,
      inbound,
      answered: inbound.filter((id) => fake.answered.has(id)),
      handoffs: fake.handoffs.length,
      sendCalls: notify.calls.filter((c) => c.kind === "ai_reply").length,
    };
  }

  /** The next `count` audit writes fail (the answered rows and the handover's row are audit writes). */
  const failAudits = (count: number) => void (auditFailures = count);

  return { fake, notify, model, post, drain, runFunction, report, events, handoffEvents, audits, processMessageBody, failAudits };
}

export type World = Awaited<ReturnType<typeof createWorld>>;
