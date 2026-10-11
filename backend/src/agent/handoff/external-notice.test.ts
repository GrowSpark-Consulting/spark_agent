import { describe, expect, it, vi } from "vitest";
import type { SendOutcome } from "../../notify/send";
import { fakeTables, type Row } from "../../test-support/fake-tables";
import { NOTICE_ACTION, NOTICE_EVERY_MS, tellCustomerTeamIsHandling, type ExternalNoticeDeps } from "./external-notice";

// A customer writes again while a staff member handles the chat from their own number (Raja, 11 Oct, question 4): the AI says so, at most once every
// 30 minutes, and staff are pinged by an event. Nothing else.

const A = "e0000000-0000-4000-8000-00000000000a";
const B = "e0000000-0000-4000-8000-00000000000b";
const PRIYA = "f1000000-0000-4000-8000-000000000001";
const CONV = "c0000000-0000-4000-8000-0000000000c1";
const CONTACT = "b0000000-0000-4000-8000-0000000000b1";
const MSG = "d0000000-0000-4000-8000-0000000000d1";
const NOW = new Date("2026-10-11T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const SENT: SendOutcome = { status: "sent", messageId: "m", providerMsgId: "w", creditsCharged: 1, usedTemplate: false };

interface Options {
  mode?: string;
  assigned?: string | null;
  message?: Row;
  contact?: Row;
  audit?: Row[];
  outcome?: SendOutcome | Error;
}

function world(over: Options = {}) {
  const t = fakeTables({
    messages: [{ id: MSG, tenant_id: A, conversation_id: CONV, direction: "in", sender: "customer", ...over.message }],
    conversations: [{ id: CONV, tenant_id: A, contact_id: CONTACT, mode: over.mode ?? "external", assigned_user_id: over.assigned === undefined ? PRIYA : over.assigned }],
    contacts: [{ id: CONTACT, tenant_id: A, language: "en", opted_out_at: null, ...over.contact }],
    audit_logs: over.audit ?? [],
  });
  const sent: { tenantId: string; payload: { conversationId?: string; text?: string; idempotencyKey?: string } }[] = [];
  const events: { id: string; name: string; data: Record<string, string> }[] = [];
  const deps: ExternalNoticeDeps = {
    db: t.db,
    now: () => NOW,
    userName: vi.fn(async (id: string) => (id === PRIYA ? "Priya" : null)),
    send: vi.fn(async (tenantId, _kind, payload) => {
      sent.push({ tenantId, payload });
      if (over.outcome instanceof Error) throw over.outcome;
      return over.outcome ?? SENT;
    }),
    sendEvent: vi.fn(async (event) => {
      events.push(event);
    }),
  };
  return { ...t, deps, sent, events, run: (tenantId = A) => tellCustomerTeamIsHandling({ tenantId, conversationId: CONV, messageId: MSG }, deps) };
}

describe("a customer writes while a team member has the chat on their own number", () => {
  it("is told, once, that the team member is looking after the chat, in their language, as an AI reply", async () => {
    const w = world();
    expect(await w.run()).toEqual({ status: "told" });
    expect(w.sent).toEqual([{ tenantId: A, payload: { conversationId: CONV, text: "Priya is looking after your chat and will reply to you shortly.", idempotencyKey: `external_notice:${MSG}` } }]);
    const ta = world({ contact: { language: "ta-en" } });
    await ta.run();
    expect(ta.sent[0].payload.text).toContain("Priya");
    expect(ta.sent[0].payload.text).toContain("seekkiram");
  });

  it("leaves an audit row that starts the 30 minutes, and pings staff with an event (ids only)", async () => {
    const w = world();
    await w.run();
    expect(w.tables.audit_logs).toEqual([expect.objectContaining({ tenant_id: A, action: NOTICE_ACTION, entity_id: CONV })]);
    expect(w.events).toEqual([{ id: `external_waiting:${MSG}`, name: "chat.external_waiting", data: { tenantId: A, conversationId: CONV, messageId: MSG } }]);
  });

  it("is not told again within 30 minutes, and no ping is sent either", async () => {
    const w = world({ audit: [{ id: "x", tenant_id: A, action: NOTICE_ACTION, entity_id: CONV, created_at: ago(NOTICE_EVERY_MS - 1000) }] });
    expect(await w.run()).toEqual({ status: "skipped", reason: "told_recently" });
    expect(w.sent).toEqual([]);
    expect(w.events).toEqual([]);
  });

  it("is told again once 30 minutes have passed", async () => {
    const w = world({ audit: [{ id: "x", tenant_id: A, action: NOTICE_ACTION, entity_id: CONV, created_at: ago(NOTICE_EVERY_MS + 1000) }] });
    expect(await w.run()).toEqual({ status: "told" });
  });

  it("another chat's notice does not count", async () => {
    const w = world({ audit: [{ id: "x", tenant_id: A, action: NOTICE_ACTION, entity_id: "other-chat", created_at: ago(1000) }] });
    expect(await w.run()).toEqual({ status: "told" });
  });

  it("says 'A team member' when the name is not known", async () => {
    const w = world({ assigned: "f1000000-0000-4000-8000-000000000009" });
    await w.run();
    expect(w.sent[0].payload.text).toMatch(/^A team member is looking after/);
  });
});

describe("when nothing should be said", () => {
  it.each([
    ["a chat the AI has", { mode: "ai" }, "not_external"],
    ["a chat a team member has in the inbox", { mode: "human" }, "not_external"],
    ["a chat with nobody assigned", { assigned: null }, "no_staff_member"],
    ["a customer who said STOP", { contact: { opted_out_at: ago(1000) } }, "opted_out"],
    ["a message that is not the customer's", { message: { direction: "out", sender: "staff" } }, "not_a_customer_message"],
  ] as const)("%s: nothing is sent, written or pinged", async (_name, over, reason) => {
    const w = world(over as Options);
    expect(await w.run()).toEqual({ status: "skipped", reason });
    expect(w.sent).toEqual([]);
    expect(w.events).toEqual([]);
    expect(w.tables.audit_logs).toEqual([]);
  });

  it("another business's ids find nothing", async () => {
    const w = world();
    expect(await w.run(B)).toEqual({ status: "skipped", reason: "not_a_customer_message" });
    expect(w.sent).toEqual([]);
  });

  it("an event that is not ids is refused", async () => {
    await expect(tellCustomerTeamIsHandling({ tenantId: "x" }, world().deps)).rejects.toThrow();
  });
});

describe("when the notice cannot be sent", () => {
  it("out of credits or outside the window: staff are still pinged, and the customer is not tried again for 30 minutes", async () => {
    const w = world({ outcome: { status: "skipped", reason: "insufficient_credits" } });
    expect(await w.run()).toEqual({ status: "skipped", reason: "not_sent" });
    expect(w.events).toHaveLength(1);
    expect(w.tables.audit_logs).toHaveLength(1);
  });

  it("a send that throws marks nothing and pings no one, so the next message tries again", async () => {
    const w = world({ outcome: new Error("down") });
    expect(await w.run()).toEqual({ status: "skipped", reason: "not_sent" });
    expect(w.events).toEqual([]);
    expect(w.tables.audit_logs).toEqual([]);
  });

  it("a ping that cannot be sent does not undo the notice", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world();
    (w.deps.sendEvent as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("down"));
    expect(await w.run()).toEqual({ status: "told" });
  });
});

describe("every query names the business", () => {
  it("filters by tenant_id", async () => {
    const w = world();
    await w.run();
    for (const call of w.calls.filter((c) => c.op === "select")) expect(call.filters).toContainEqual({ column: "tenant_id", op: "eq", value: A });
  });
});
