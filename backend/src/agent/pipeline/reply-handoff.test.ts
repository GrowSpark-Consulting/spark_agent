import { describe, expect, it } from "vitest";
import { A, CONV, LEAD, NOW, runner, understood, world } from "../../test-support/booking-world";
import { HOT_LEAD_ACTION, HOT_LEAD_EVENT } from "./events";
import { replyTurn } from "./reply";
import type { QualificationSummary } from "./understand";

// Day 4, through the reply step: a customer who asks for a discount, and a lead that turns hot. (A complaint and a request for a person are in reply.test.ts.)

const hot: QualificationSummary = { score: 75, temperature: "hot", ask: [], missingRequired: [], readyForSlots: false, hardFail: null, bookingKind: null };
const hotEvents = (w: ReturnType<typeof world>) => w.sendEvent.mock.calls.filter(([event]) => event.name === HOT_LEAD_EVENT);

describe("a customer who asks for a discount", () => {
  it("is told by the model that a person will look at it, the chat goes to a person at high priority, and staff are alerted by the handoff event", async () => {
    const w = world({ script: ["I am not able to change prices myself, but a team member will look at this and get back to you."] });
    const out = await replyTurn(runner().step, w.turn, understood({ intent: "price_negotiation", hasQuestion: false }, { ...hot, bookingKind: null }), NOW, w.deps);
    expect(out).toMatchObject({ case: "negotiation", reply: { status: "sent", source: "model" }, handoff: { trigger: "negotiation", opened: true, switched: true } });
    expect(w.handoffs).toEqual([expect.objectContaining({ trigger: "negotiation", priority: "high" })]);
    expect(w.conversations.get(CONV)?.mode).toBe("human");
    expect(w.sendEvent).toHaveBeenCalledWith(expect.objectContaining({ name: "handoff.opened", id: `handoff_opened:${w.handoffs[0].id}` }));
    expect(w.complete.mock.calls[0][0].messages[0].content).toMatch(/cannot agree to any price change/i);
  });

  it("a reply that promises a discount is caught by the post-check, so the safe line goes instead", async () => {
    const w = world({ script: ["Sure, I can give you ₹5 lakh off.", "Of course, ₹5 lakh off is fine."] });
    const out = await replyTurn(runner().step, w.turn, understood({ intent: "price_negotiation", hasQuestion: false }, { ...hot, bookingKind: null }), NOW, w.deps);
    expect(out.reply).toMatchObject({ status: "sent", source: "fixed" });
    expect(w.send.mock.calls[0][2].text).not.toContain("5 lakh");
    expect(out.handoff).toMatchObject({ trigger: "negotiation" }); // the person is still told
  });
});

describe("a lead that turns hot", () => {
  it("staff are told once, after the customer has their reply, and the chat stays with the AI", async () => {
    const w = world({ script: ["Sounds good! What area are you looking at?"] });
    const r = runner();
    const out = await replyTurn(r.step, w.turn, understood({ intent: "give_details", hasQuestion: false }, hot), NOW, w.deps);
    expect(out).toMatchObject({ reply: { status: "sent" }, handoff: null, hotLead: "announced" });
    expect(r.ran).toEqual(["plan", "reply", "hot-lead"]);
    expect(hotEvents(w)).toEqual([[{ id: `lead_hot:${LEAD}`, name: "lead.hot", data: { tenantId: A, leadId: LEAD, conversationId: CONV } }]]);
    expect(w.audits).toContainEqual(expect.objectContaining({ action: HOT_LEAD_ACTION, entity: "lead", entityId: LEAD }));
    expect(w.handoffs).toEqual([]); // not a handover: the inbox must not call this chat "needs a person"
    expect(w.conversations.get(CONV)?.mode).toBe("ai");
  });

  it("not again on the lead's next turn", async () => {
    const w = world({ script: ["Sounds good!", "Great, noted."] });
    await replyTurn(runner().step, w.turn, understood({ intent: "give_details", hasQuestion: false }, hot), NOW, w.deps);
    const again = await replyTurn(runner().step, w.turn, understood({ intent: "give_details", hasQuestion: false }, hot), NOW, w.deps);
    expect(hotEvents(w)).toHaveLength(1);
    expect(again.reply.status).toBe("already_answered");
  });

  it("a second message of a lead that was already announced does not announce it again", async () => {
    const w = world({ script: ["Sounds good!"] });
    w.hotAlerted.add(LEAD);
    const out = await replyTurn(runner().step, w.turn, understood({ intent: "give_details", hasQuestion: false }, hot), NOW, w.deps);
    expect(out.hotLead).toBeUndefined();
    expect(hotEvents(w)).toEqual([]);
  });

  it("a lead that is only warm is not announced", async () => {
    const w = world({ script: ["Sounds good!"] });
    const out = await replyTurn(runner().step, w.turn, understood({ intent: "give_details", hasQuestion: false }, { ...hot, score: 50, temperature: "warm" }), NOW, w.deps);
    expect(out.hotLead).toBeUndefined();
    expect(hotEvents(w)).toEqual([]);
  });

  it("a business that switched it off is not announced", async () => {
    const w = world({ script: ["Sounds good!"], agentSettings: { handoffTriggers: [{ key: "hot_lead", enabled: false }] } });
    await replyTurn(runner().step, w.turn, understood({ intent: "give_details", hasQuestion: false }, hot), NOW, w.deps);
    expect(hotEvents(w)).toEqual([]);
  });

  it("when no reply could be sent the announcement waits for the next turn", async () => {
    const w = world({ script: ["Sounds good!"] });
    w.send.mockResolvedValueOnce({ status: "skipped", reason: "insufficient_credits" });
    const out = await replyTurn(runner().step, w.turn, understood({ intent: "give_details", hasQuestion: false }, hot), NOW, w.deps);
    expect(out.reply.status).toBe("no_credits");
    expect(hotEvents(w)).toEqual([]);
  });

  it("a lost audit row does not fail the turn: the event id drops a repeat", async () => {
    const w = world({ script: ["Sounds good!"] });
    w.deps.audit = async (entry) => {
      if (entry.action === HOT_LEAD_ACTION) throw new Error("audit down");
      w.audits.push(entry);
    };
    const out = await replyTurn(runner().step, w.turn, understood({ intent: "give_details", hasQuestion: false }, hot), NOW, w.deps);
    expect(out.hotLead).toBe("announced");
  });

  it("the event carries ids only: no words, no phone number, no name", async () => {
    const w = world({ script: ["Sounds good!"] });
    await replyTurn(runner().step, w.turn, understood({ intent: "give_details", hasQuestion: false }, hot), NOW, w.deps);
    const [event] = hotEvents(w)[0];
    expect(Object.keys(event.data).sort()).toEqual(["conversationId", "leadId", "tenantId"]);
  });
});
