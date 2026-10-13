import { describe, expect, it } from "vitest";
import { A, CONV, LEAD, M1, NOW, runner, world } from "../../test-support/booking-world";
import { HIDDEN } from "../../test-support/fake-pipeline-store";
import { VOICE_NOTE_EVENT } from "./events";
import { fixedText } from "./fixed-texts";
import { replyTurn } from "./reply";
import type { UnderstandResult } from "./understand";

// A voice note through the reply step (Day 4, Raja 11 Oct): one polite line asking the customer to type, as a normal AI reply (so it costs the
// credit and goes through notify.send), and staff are told one is waiting. A burst of voice notes gets one reply.

const noText: UnderstandResult = { status: "fallback", reason: "no_text" };
const voice = { kind: "audio", body: null } as const;
const alerts = (w: ReturnType<typeof world>) => w.sendEvent.mock.calls.filter(([event]) => event.name === VOICE_NOTE_EVENT);

describe("a voice note on its own", () => {
  it("is answered with one line asking the customer to type, sent as an ai_reply through notify.send, without a model", async () => {
    const w = world(voice);
    const r = runner();
    const out = await replyTurn(r.step, w.turn, noText, NOW, w.deps);
    expect(out).toMatchObject({ case: "voice_note", reply: { status: "sent", source: "fixed" }, handoff: null, voiceNote: "alerted" });
    expect(w.send).toHaveBeenCalledOnce();
    expect(w.send.mock.calls[0]).toEqual([A, "ai_reply", { conversationId: CONV, text: fixedText("voice_note", "en"), idempotencyKey: expect.stringMatching(/^reply:[0-9a-f-]{36}$/) }]);
    expect(w.complete).not.toHaveBeenCalled();
    expect(r.ran).toEqual(["plan", "reply", "voice-alert"]);
  });

  it("is recorded as answered, so a retry does not reply twice", async () => {
    const w = world(voice);
    await replyTurn(runner().step, w.turn, noText, NOW, w.deps);
    const again = await replyTurn(runner().step, w.turn, noText, NOW, w.deps);
    expect(again.reply.status).toBe("already_answered");
    expect(w.send).toHaveBeenCalledOnce();
    // The alert is at-least-once, so a crash between the reply and the alert cannot lose it; the event id is the same, so the queue drops a repeat.
    expect(new Set(alerts(w).map(([event]) => event.id)).size).toBe(1);
  });

  it("tells staff once, with ids only: the business, the chat and the lead", async () => {
    const w = world(voice);
    await replyTurn(runner().step, w.turn, noText, NOW, w.deps);
    expect(alerts(w)).toEqual([[{ id: `voice_note:${M1}`, name: "voice_note.received", data: { tenantId: A, conversationId: CONV, leadId: LEAD } }]]);
    const [event] = alerts(w)[0];
    expect(JSON.stringify(event)).not.toContain(HIDDEN.phone);
  });

  it("the chat stays with the AI: no handoff, no change of mode", async () => {
    const w = world(voice);
    await replyTurn(runner().step, w.turn, noText, NOW, w.deps);
    expect(w.handoffs).toEqual([]);
    expect(w.conversations.get(CONV)?.mode).toBe("ai");
  });
});

describe("a second voice note right after", () => {
  it("is not answered again and staff are not told again, yet it counts as answered", async () => {
    const w = world({ ...voice, earlier: [{ body: null, kind: "audio", agent: { planCase: "voice_note" } }] });
    const out = await replyTurn(runner().step, w.turn, noText, NOW, w.deps);
    expect(out).toMatchObject({ case: "voice_note_repeat", reply: { status: "already_answered" } });
    expect(out.voiceNote).toBeUndefined();
    expect(w.send).not.toHaveBeenCalled();
    expect(alerts(w)).toEqual([]);
    expect(w.audits.filter((a) => a.action === "message.answered")).toHaveLength(1); // the message is answered, so it is not picked up again
  });

  it("but a voice note after something else was said is answered again", async () => {
    const w = world({ ...voice, earlier: [{ body: null, kind: "audio", agent: { planCase: "voice_note" } }, { body: "2BHK price?", agent: { planCase: "answered_from_kb" } }] });
    const out = await replyTurn(runner().step, w.turn, noText, NOW, w.deps);
    expect(out.case).toBe("voice_note");
    expect(w.send).toHaveBeenCalledOnce();
  });
});

describe("when it cannot be sent", () => {
  it("out of credits: the usual out-of-credits path (a person takes over, one holding line), and no voice alert yet", async () => {
    const w = world(voice);
    w.send.mockResolvedValueOnce({ status: "skipped", reason: "insufficient_credits" });
    const out = await replyTurn(runner().step, w.turn, noText, NOW, w.deps);
    expect(out.reply.status).toBe("no_credits");
    expect(out.handoff).toMatchObject({ trigger: "credits_exhausted", opened: true });
    expect(alerts(w)).toEqual([]);
  });

  it("a person has the chat: nothing is sent and nobody is told by this step", async () => {
    const w = world(voice);
    w.conversations.get(CONV)!.mode = "human";
    const out = await replyTurn(runner().step, w.turn, noText, NOW, w.deps);
    expect(out.reply).toMatchObject({ status: "not_sent", reason: "not_ai_mode" });
    expect(w.send).not.toHaveBeenCalled();
    expect(alerts(w)).toEqual([]);
  });
});

describe("a voice note next to typed words", () => {
  it("is just part of the message: no voice line, no voice alert", async () => {
    const w = world({ earlier: [], text: "I want a 2BHK", script: ["Sure, which area?"] });
    const out = await replyTurn(runner().step, w.turn, noText, NOW, w.deps);
    expect(out.case).toBe("clarify_no_text");
    expect(alerts(w)).toEqual([]);
  });
});
