import { describe, expect, it } from "vitest";
import { fakeTables, type Row } from "../test-support/fake-tables";
import { handlePhoneReplyReturn, RETURN_NOTE, WAIT, type PhoneReplyReturnDeps } from "./phone-reply-return";

// Raja's answer to question 6 (11 Oct): the owner replied from the phone app and the chat went to a person. If nobody on the team replies for 24
// hours, the AI takes the chat back, with a note in the inbox, so the customer is never left unanswered. One run per echo; each waits 24 hours and then
// looks, so a later reply by the team simply makes the earlier runs do nothing and the last one decide.

const A = "e0000000-0000-0000-0000-00000000000a";
const B = "e0000000-0000-0000-0000-00000000000b";
const CONV = "c0000000-0000-0000-0000-00000000000c";
const NOW = new Date("2026-10-12T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function world(over: { mode?: string; assigned?: string | null; tenant?: string; messages?: Row[]; handoffs?: Row[] } = {}) {
  const t = fakeTables({
    conversations: [{ id: CONV, tenant_id: over.tenant ?? A, mode: over.mode ?? "human", assigned_user_id: over.assigned ?? null }],
    messages: over.messages ?? [{ id: "m1", tenant_id: A, conversation_id: CONV, sender: "staff", direction: "out", created_at: hoursAgo(25), body: "On my way" }],
    handoffs: over.handoffs ?? [],
    audit_logs: [],
  });
  const slept: string[] = [];
  const step = {
    sleep: async (id: string, duration: string) => void slept.push(`${id}:${duration}`),
    run: async <T,>(_id: string, fn: () => Promise<T>) => fn(),
  };
  const deps: PhoneReplyReturnDeps = { db: t.db, now: () => NOW };
  const run = (data: unknown = { tenantId: A, conversationId: CONV }) => handlePhoneReplyReturn({ event: { data }, step }, deps);
  return { ...t, run, slept };
}

describe("after 24 hours with no reply from the team", () => {
  it("waits 24 hours first", async () => {
    const w = world();
    await w.run();
    expect(WAIT).toBe("24h");
    expect(w.slept).toEqual(["wait-24h:24h"]);
  });

  it("the AI takes the chat back, with a note, and the chat's open handoffs are closed", async () => {
    const w = world({ handoffs: [{ id: "h1", tenant_id: A, conversation_id: CONV, trigger: "asked_human", resolved_at: null }] });
    expect(await w.run()).toEqual({ returned: true });
    expect(w.tables.conversations[0]).toMatchObject({ mode: "ai", assigned_user_id: null });
    expect(w.tables.messages.find((m) => m.sender === "system")).toMatchObject({ tenant_id: A, conversation_id: CONV, direction: "out", body: RETURN_NOTE, meta: { event: "auto_return" } });
    expect(w.tables.handoffs[0]).toMatchObject({ resolved_at: NOW.toISOString(), outcome: "auto_returned" });
    expect(w.tables.audit_logs).toEqual([expect.objectContaining({ tenant_id: A, actor: "system", action: "conversation.mode_changed", entity_id: CONV, diff: { from: "human", to: "ai", reason: "no_team_reply_24h" } })]);
  });

  it("the note says why, in plain words", () => {
    expect(RETURN_NOTE).toMatch(/24 hours/);
    expect(RETURN_NOTE).toMatch(/AI/);
  });
});

describe("when it does nothing", () => {
  it("the team replied in the last 24 hours (a later phone reply, or a reply from the inbox): the AI waits, and a later run looks again", async () => {
    const w = world({ messages: [{ id: "m1", tenant_id: A, conversation_id: CONV, sender: "staff", direction: "out", created_at: hoursAgo(10), body: "Call you soon" }] });
    expect(await w.run()).toEqual({ skipped: "team_replied_recently" });
    expect(w.tables.conversations[0].mode).toBe("human");
  });

  it("staff already returned the chat to the AI", async () => {
    const w = world({ mode: "ai" });
    expect(await w.run()).toEqual({ skipped: "not_waiting_for_the_team" });
    expect(w.tables.messages.filter((m) => m.sender === "system")).toEqual([]);
  });

  it("a team member took the chat over in the inbox (it has an assigned person): that is theirs to hand back", async () => {
    const w = world({ assigned: "user-1" });
    expect(await w.run()).toEqual({ skipped: "not_waiting_for_the_team" });
    expect(w.tables.conversations[0].mode).toBe("human");
  });

  it("the chat is being handled from a staff member's own number", async () => {
    const w = world({ mode: "external" });
    expect(await w.run()).toEqual({ skipped: "not_waiting_for_the_team" });
    expect(w.tables.conversations[0].mode).toBe("external");
  });

  it("the chat is gone", async () => {
    const w = world({ tenant: B });
    expect(await w.run()).toEqual({ skipped: "chat_not_found" });
  });

  it("a customer's own message does not count as the team replying", async () => {
    const w = world({ messages: [{ id: "m1", tenant_id: A, conversation_id: CONV, sender: "customer", direction: "in", created_at: hoursAgo(2), body: "hello?" }] });
    expect(await w.run()).toEqual({ returned: true });
  });

  it("an AI reply or a system note does not count as the team replying either", async () => {
    const w = world({
      messages: [
        { id: "m1", tenant_id: A, conversation_id: CONV, sender: "ai", direction: "out", created_at: hoursAgo(3), body: "x" },
        { id: "m2", tenant_id: A, conversation_id: CONV, sender: "system", direction: "out", created_at: hoursAgo(2), body: "note" },
      ],
    });
    expect(await w.run()).toEqual({ returned: true });
  });
});

describe("safe to run again", () => {
  it("a second run finds the chat already with the AI, and does nothing", async () => {
    const w = world();
    await w.run();
    expect(await w.run()).toEqual({ skipped: "not_waiting_for_the_team" });
    expect(w.tables.messages.filter((m) => m.sender === "system")).toHaveLength(1);
  });

  it("two runs at the same moment cannot both return it: the switch is a compare-and-set on the mode", async () => {
    const w = world();
    const [first, second] = await Promise.all([w.run(), w.run()]);
    expect([first, second].filter((r) => "returned" in r)).toHaveLength(1);
  });
});

describe("it only touches this business's chat", () => {
  it("every query names the business named in the event", async () => {
    const w = world();
    await w.run();
    for (const call of w.calls) {
      const named = call.op === "insert" ? (call.payload as { tenant_id?: string }).tenant_id === A : call.filters.some((f) => f.column === "tenant_id" && f.op === "eq" && f.value === A);
      expect(named, `${call.table} ${call.op} is not scoped to the business`).toBe(true);
    }
  });

  it("an event with ids that are not ids is refused before anything is read", async () => {
    const w = world();
    await expect(w.run({ tenantId: "x", conversationId: CONV })).rejects.toThrow();
    expect(w.calls).toEqual([]);
    expect(w.slept).toEqual([]);
  });

  it("failing to write the note or the audit row does not undo the return", async () => {
    const w = world();
    w.tables.audit_logs = { error: { code: "42501" } } as unknown as Row[];
    expect(await w.run()).toEqual({ returned: true });
    expect(w.tables.conversations[0].mode).toBe("ai");
  });
});
