import { describe, expect, it, vi } from "vitest";
import type { AuditEntry } from "../../lib/audit";
import type { SendOutcome } from "../../notify/send";
import { fakePipelineStore, type FakeMessage } from "../../test-support/fake-pipeline-store";
import type { LlmClient } from "../llm/anthropic";
import { areaText } from "./fixed-texts";
import type { SystemNoticePort } from "./ports";
import type { StepRunner, TurnContext } from "./process-message";
import { replyTurn, type ReplyDeps } from "./reply";
import type { QualificationSummary, UnderstandResult } from "./understand";

// A customer names an area the business has no sites in (Raja, 14 Oct), end to end through the reply step: the first reply lists the areas the
// business has; naming the same area again is told there is nothing there for now, and staff are reminded, once, after the reply has gone. The
// fixed lines never call the model. The reading itself is made by the understanding step (understand-coverage.test.ts); plan-area.test.ts has the table.

const A = "e0000000-0000-0000-0000-00000000000a";
const CONV = "c0000000-0000-0000-0000-00000000000c";
const CONTACT = "b0000000-0000-0000-0000-0000000000b1";
const LEAD = "10000000-0000-0000-0000-0000000000f1";
const M0 = "a0000000-0000-0000-0000-0000000000a0";
const M1 = "a0000000-0000-0000-0000-0000000000a1";
const NOW = Date.now();
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();
const AREAS = ["Velachery", "Tambaram", "Anna Nagar"];
const SENT: SendOutcome = { status: "sent", messageId: "m-out", providerMsgId: "wamid.OUT", creditsCharged: 1, usedTemplate: false };

const reading = (over: Record<string, unknown> = {}) => ({ served: false, area: "adyar", shown: "Adyar", areas: AREAS, named: true, ...over });
const ready: QualificationSummary = { score: 55, temperature: "warm", ask: [], missingRequired: [], readyForSlots: true, hardFail: null, bookingKind: "site_visit" };
const understood = (over: Record<string, unknown> = {}): UnderstandResult =>
  ({ status: "understood", summary: { intent: "give_details", language: "en", sentiment: "neutral", asksIfHuman: false, notInterested: false, confidence: 0.9, hasQuestion: false, fieldKeys: ["location"], ...over }, retrieval: { outcome: "skipped" }, qualification: ready }) as UnderstandResult;

interface Options {
  reading?: Record<string, unknown> | null;
  before?: { coverage?: unknown } | null;
  mode?: "ai" | "human";
  optedOut?: boolean;
  language?: string | null;
  send?: SendOutcome;
  reminder?: "none" | "fails";
  understood?: UnderstandResult;
}

function world(over: Options = {}) {
  const customer = (id: string, secondsAgo: number, agent: Record<string, unknown> | null): FakeMessage => ({
    id, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "text", createdAt: at(secondsAgo), body: "Adyar", meta: agent ? { agent } : {},
  });
  const messages = [
    ...(over.before ? [customer(M0, 120, over.before)] : []),
    customer(M1, 3, { extraction: { fields: { location: "Adyar" } }, ...(over.reading === null ? {} : { coverageReading: over.reading ?? reading() }) }),
  ];
  const fake = fakePipelineStore({
    tenants: [{ id: A, vertical: "sample-pack", verticalVersion: 1 }],
    messages,
    conversations: [{ id: CONV, tenantId: A, contactId: CONTACT, mode: over.mode ?? "ai" }],
    contacts: [{ id: CONTACT, tenantId: A, language: over.language ?? null, optedOut: over.optedOut ?? false, consentAt: "2026-10-01T00:00:00Z" }],
    leads: [{ id: LEAD, tenantId: A, contactId: CONTACT, stage: "engaged", createdAt: 1, fields: { location: "Adyar" } }],
    tenantInfo: { [A]: { name: "Skyline Homes", agentSettings: {} } },
  });
  const complete = vi.fn(async () => {
    throw new Error("the model must not be called for a fixed line");
  });
  const llm = { complete } as unknown as LlmClient;
  const send = vi.fn<ReplyDeps["send"]>(async () => over.send ?? SENT);
  const audits: AuditEntry[] = [];
  const audit = vi.fn(async (entry: AuditEntry) => {
    audits.push(entry);
    if (entry.action === "message.answered" && entry.entityId) fake.answered.set(entry.entityId, Date.now());
  });
  const sendEvent = vi.fn<ReplyDeps["sendEvent"]>(async () => undefined);
  const systemNotice = { send: vi.fn(async () => ({ status: "awaiting_notify_kind" as const })) };
  const areaReminder = vi.fn<NonNullable<ReplyDeps["areaReminder"]>>(async () => {
    if (over.reminder === "fails") throw new Error("staff alerts are down");
    return { recipients: 2, sent: 2, skipped: 0, failed: 0 };
  });
  const deps: ReplyDeps = { store: fake.store, llm, send, audit, sendEvent, systemNotice: systemNotice as SystemNoticePort, privacyPolicyUrl: "https://example.test/privacy", now: () => Date.now(), ...(over.reminder === "none" ? {} : { areaReminder }) };
  const turn: TurnContext = { tenantId: A, conversationId: CONV, contactId: CONTACT, leadId: LEAD, leadCreated: false, messageIds: [M1], language: null, vertical: "sample-pack", verticalVersion: 1 };
  return { ...fake, complete, send, audit, sendEvent, areaReminder, deps, turn, understood: over.understood ?? understood() };
}

function runner() {
  const memo = new Map<string, unknown>();
  const ran: string[] = [];
  const step: StepRunner = {
    async run(id, fn) {
      if (memo.has(id)) return memo.get(id) as never;
      ran.push(id);
      const value = await fn();
      memo.set(id, value);
      return value;
    },
  };
  return { step, memo, ran };
}

const run = (w: ReturnType<typeof world>, r = runner()) => replyTurn(r.step, w.turn, w.understood, NOW, w.deps);
const metaOf = (w: ReturnType<typeof world>) => w.messages.get(M1)?.meta?.agent as Record<string, unknown>;
const sentText = (w: ReturnType<typeof world>) => w.send.mock.calls[0][2].text;

describe("the first time an unserved area is named", () => {
  it("sends the areas the business has, in one fixed line, with no model call, and keeps what was said", async () => {
    const w = world();
    const outcome = await run(w);
    expect(outcome).toMatchObject({ case: "area_options", reply: { status: "sent", source: "fixed" }, handoff: null });
    expect(w.send).toHaveBeenCalledTimes(1);
    expect(w.send.mock.calls[0][1]).toBe("ai_reply");
    expect(sentText(w)).toBe(areaText("area_options", "en", { area: "Adyar", areas: AREAS }));
    expect(sentText(w)).toContain("Velachery, Tambaram, Anna Nagar");
    expect(w.complete).not.toHaveBeenCalled();
    expect(metaOf(w)).toMatchObject({ planCase: "area_options", coverage: { area: "adyar", stage: "options" } });
    expect(w.answered.has(M1)).toBe(true);
  });

  it("lists the areas BEFORE any refusal: this first reply says nothing about 'for now' or being updated later", async () => {
    const w = world();
    await run(w);
    expect(sentText(w)).not.toMatch(/for now|update you|any property/i);
  });

  it("sends no staff reminder, opens no handover, and leaves the lead open and the chat with the assistant", async () => {
    const w = world();
    await run(w);
    expect(w.areaReminder).not.toHaveBeenCalled();
    expect(w.handoffs).toHaveLength(0);
    expect(w.leads.get(LEAD)?.stage).toBe("engaged");
    expect(w.conversations.get(CONV)?.mode).toBe("ai");
  });

  it("says it in the customer's language", async () => {
    const w = world({ understood: understood({ language: "ta-en" }) });
    await run(w);
    expect(sentText(w)).toBe(areaText("area_options", "ta-en", { area: "Adyar", areas: AREAS }));
  });

  it("is the options again when the earlier turn was about another area", async () => {
    const w = world({ before: { coverage: { area: "mylapore", stage: "options" } } });
    expect(await run(w)).toMatchObject({ case: "area_options" });
    expect(w.areaReminder).not.toHaveBeenCalled();
  });

  it("is the options again when the earlier turn's state was ended by a place the business has (null)", async () => {
    const w = world({ before: { coverage: null } });
    expect(await run(w)).toMatchObject({ case: "area_options" });
  });
});

describe("the same area again, after the options", () => {
  it("is told there is nothing there for now, with no model call and no visit offered", async () => {
    const w = world({ before: { coverage: { area: "adyar", stage: "options" } } });
    expect(await run(w)).toMatchObject({ case: "area_unavailable", reply: { status: "sent", source: "fixed" }, handoff: null });
    expect(sentText(w)).toBe(areaText("area_unavailable", "en", { area: "Adyar", areas: AREAS }));
    expect(w.complete).not.toHaveBeenCalled();
    expect(metaOf(w)).toMatchObject({ planCase: "area_unavailable", coverage: { area: "adyar", stage: "unavailable" } });
    expect(w.leads.get(LEAD)?.stage).toBe("engaged"); // the lead stays open
    expect(w.handoffs).toHaveLength(0);
  });

  it("reminds the staff once, after the reply has gone, with the customer's own words for the area and the area as it is compared", async () => {
    const w = world({ before: { coverage: { area: "adyar", stage: "options" } } });
    await run(w);
    expect(w.areaReminder).toHaveBeenCalledTimes(1);
    expect(w.areaReminder).toHaveBeenCalledWith({ tenantId: A, conversationId: CONV, leadId: LEAD, area: "Adyar", areaKey: "adyar" });
    expect(w.send.mock.invocationCallOrder[0]).toBeLessThan(w.areaReminder.mock.invocationCallOrder[0]);
  });

  it("does not remind again when the customer keeps asking (the state is already 'unavailable')", async () => {
    const w = world({ before: { coverage: { area: "adyar", stage: "unavailable" } } });
    expect(await run(w)).toMatchObject({ case: "area_unavailable" });
    expect(w.areaReminder).not.toHaveBeenCalled();
  });

  it("is the same reminder if the run is repeated after the reply went: the key inside it is the same, so staff are told once", async () => {
    const w = world({ before: { coverage: { area: "adyar", stage: "options" } } });
    await run(w);
    await run(w); // a fresh run of the same turn: the reply is found answered, nothing is sent again
    expect(w.send).toHaveBeenCalledTimes(1);
    const inputs = w.areaReminder.mock.calls.map(([input]) => input);
    expect(new Set(inputs.map((i) => JSON.stringify(i))).size).toBe(1);
  });

  it("never fails the turn when the reminder cannot be sent: the customer has their reply", async () => {
    const w = world({ before: { coverage: { area: "adyar", stage: "options" } }, reminder: "fails" });
    await expect(run(w)).resolves.toMatchObject({ case: "area_unavailable", reply: { status: "sent" } });
    expect(w.send).toHaveBeenCalledTimes(1);
  });

  it("reports a reminder that reached nobody as failed, without failing the turn (the counts say so; it is not thrown, so the reply is never repeated)", async () => {
    const w = world({ before: { coverage: { area: "adyar", stage: "options" } } });
    w.areaReminder.mockResolvedValueOnce({ recipients: 2, sent: 0, skipped: 0, failed: 2 });
    await expect(run(w)).resolves.toMatchObject({ case: "area_unavailable", reply: { status: "sent" }, areaReminder: "failed" });
    const none = world({ before: { coverage: { area: "adyar", stage: "options" } } });
    none.areaReminder.mockResolvedValueOnce({ recipients: 0, sent: 0, skipped: 0, failed: 0 });
    await expect(run(none)).resolves.toMatchObject({ areaReminder: "sent" }); // nobody has an alert number: nothing to send is not a failure
  });

  it("works without a reminder dependency (nothing is sent, nothing fails)", async () => {
    const w = world({ before: { coverage: { area: "adyar", stage: "options" } }, reminder: "none" });
    await expect(run(w)).resolves.toMatchObject({ case: "area_unavailable" });
  });

  it("sends no reminder when the reply did not go out", async () => {
    const w = world({ before: { coverage: { area: "adyar", stage: "options" } }, send: { status: "skipped", reason: "outside_window" } as SendOutcome });
    await run(w);
    expect(w.areaReminder).not.toHaveBeenCalled();
  });
});

describe("a place the business has", () => {
  it("ends what was said about an unserved one: the state is null on the message, so the options come first next time", async () => {
    const w = world({ reading: reading({ served: true, area: "velachery", shown: "Velachery" }), before: { coverage: { area: "adyar", stage: "unavailable" } } });
    await run(w);
    expect(Object.hasOwn(metaOf(w), "coverage")).toBe(true);
    expect(metaOf(w).coverage).toBeNull();
    expect(w.areaReminder).not.toHaveBeenCalled();
  });
});

describe("no reading, or nobody to answer", () => {
  it("a turn with no reading keeps no state and is planned as before", async () => {
    const w = world({ reading: null });
    await run(w);
    expect(Object.hasOwn(metaOf(w), "coverage")).toBe(false);
    expect(metaOf(w).planCase).not.toMatch(/^area_/);
  });

  it("a reading that is not in the shape the step writes is ignored: a broken meta never stops a reply", async () => {
    const w = world({ reading: { served: "no", areas: 3 } });
    await run(w);
    expect(metaOf(w).planCase).not.toMatch(/^area_/);
    expect(w.send).toHaveBeenCalledTimes(1);
  });

  it("a customer who opted out gets nothing and no reminder is sent", async () => {
    const w = world({ before: { coverage: { area: "adyar", stage: "options" } }, optedOut: true });
    await run(w);
    expect(w.send).not.toHaveBeenCalled();
    expect(w.areaReminder).not.toHaveBeenCalled();
  });

  it("a chat a person has taken over gets nothing and no reminder is sent", async () => {
    const w = world({ before: { coverage: { area: "adyar", stage: "options" } }, mode: "human" });
    await run(w);
    expect(w.send).not.toHaveBeenCalled();
    expect(w.areaReminder).not.toHaveBeenCalled();
  });
});

describe("what the steps remember", () => {
  it("holds none of the customer's place or the business's places: Inngest keeps every step's result", async () => {
    const w = world({ before: { coverage: { area: "adyar", stage: "options" } } });
    const r = runner();
    await run(w, r);
    expect(JSON.stringify([...r.memo.entries()])).not.toMatch(/adyar|velachery|tambaram|anna nagar/i);
    expect(r.ran).toContain("area-reminder");
  });
});
