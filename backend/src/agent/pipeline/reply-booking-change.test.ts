import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../lib/errors";
import { A, agentMeta, NOW, OFFER, plain, ready, runner, SUN_10, SUN_15, MON_17, understood, userPrompt, WORDS, world } from "../../test-support/booking-world";
import { HIDDEN } from "../../test-support/fake-pipeline-store";
import type { SchedulingPort } from "../scheduling/act";
import { replyTurn } from "./reply";

// Moving or cancelling a booking through the reply step. The customer already has a confirmed booking (the calendar says so); a move is
// offered times and then done with Dev 2's rescheduleBooking, a cancellation is asked about first and only a clear yes cancels it.

const MINE = "50000000-0000-0000-0000-000000000005";
const mine = { id: MINE, start: SUN_15.start, end: SUN_15.end, status: "confirmed" };
const withBooking = { activeBooking: vi.fn<SchedulingPort["activeBooking"]>(async () => mine) };
const moving = { ...OFFER, rescheduleBookingId: MINE };
const asking = { cancel: { bookingId: MINE, label: "Sun 11 Oct, 3:00 pm" }, at: new Date(NOW - 60_000).toISOString() };
const turnOf = (over: Record<string, unknown> = {}, confidence = 0.9) => understood({ confidence, ...over });

describe("moving a booking", () => {
  it("looks for times for moving it, and offers them with the booking they are moving", async () => {
    const w = world({ port: withBooking, script: ["Sure, I can move your Sun 11 Oct, 3:00 pm visit. I have Sun 11 Oct, 10:00 am or Mon 12 Oct, 5:30 pm. Which suits you?"] });
    const r = runner();
    const out = await replyTurn(r.step, w.turn, turnOf({ intent: "reschedule" }), NOW, w.deps);
    expect(out).toMatchObject({ case: "reschedule_offer", reply: { status: "sent", source: "model" } });
    expect(r.ran).toEqual(["plan", "act", "plan-act", "reply"]);
    expect(userPrompt(w)).toContain("The customer's booking is on Sun 11 Oct, 3:00 pm and they want to move it.");
    expect(w.port.holdSlot).not.toHaveBeenCalled();
    expect(w.port.rescheduleBooking).not.toHaveBeenCalled();
    expect(agentMeta(w).offer).toMatchObject({ rescheduleBookingId: MINE });
  });

  it("moves it to the time the customer picks, with Dev 2's function, and tells them", async () => {
    const w = world({
      offer: { ...moving, at: new Date(NOW - 120_000).toISOString() } as never,
      port: withBooking,
      text: "monday evening",
      script: ["Done, your visit is now Mon 12 Oct, 5:30 pm."],
    });
    const out = await replyTurn(runner().step, w.turn, turnOf({ intent: "give_details" }), NOW, w.deps);
    expect(out).toMatchObject({ case: "rescheduled", reply: { status: "sent", source: "model" } });
    expect(w.port.rescheduleBooking).toHaveBeenCalledWith(A, MINE, plain(MON_17));
    expect(w.port.holdSlot).not.toHaveBeenCalled(); // a new booking is not made
    expect(userPrompt(w)).toContain("Booking moved to: Mon 12 Oct, 5:30 pm.");
    expect(agentMeta(w).offer).toBeNull();
  });

  it("when someone took that time first: the booking stays where it was, and the others are offered", async () => {
    const w = world({
      offer: { ...moving, at: new Date(NOW - 120_000).toISOString() } as never,
      port: { ...withBooking, rescheduleBooking: vi.fn(async () => { throw new AppError("slot_taken", "taken"); }), findSlots: vi.fn(async () => [SUN_10]) },
      text: "monday evening",
      script: ["Sorry, that one was just taken. I have Sun 11 Oct, 10:00 am. Does that work?"],
    });
    const out = await replyTurn(runner().step, w.turn, turnOf({ intent: "give_details" }), NOW, w.deps);
    expect(out).toMatchObject({ case: "offer_retaken", reply: { status: "sent" } });
    expect(agentMeta(w).offer).toMatchObject({ rescheduleBookingId: MINE });
  });
});

describe("cancelling a booking", () => {
  it("a first message asks whether to cancel: nothing is cancelled, and the question is remembered", async () => {
    const w = world({ port: withBooking, script: ["Sure. Shall I cancel your visit on Sun 11 Oct, 3:00 pm? Just say yes or no."] });
    const out = await replyTurn(runner().step, w.turn, turnOf({ intent: "cancel" }), NOW, w.deps);
    expect(out).toMatchObject({ case: "cancel_ask", reply: { status: "sent", source: "model" } });
    expect(w.port.cancelBooking).not.toHaveBeenCalled();
    expect(userPrompt(w)).toContain("Nothing has been cancelled yet");
    expect(agentMeta(w).offer).toMatchObject({ cancel: { bookingId: MINE, label: "Sun 11 Oct, 3:00 pm" } });
  });

  it("a yes cancels it with Dev 2's function, tells the customer, and ends the question", async () => {
    const w = world({ offer: asking as never, port: withBooking, text: "yes please", script: ["Done, your visit on Sun 11 Oct, 3:00 pm is cancelled. You are welcome to book again."] });
    const out = await replyTurn(runner().step, w.turn, turnOf({ intent: "give_details" }), NOW, w.deps);
    expect(out).toMatchObject({ case: "cancelled", reply: { status: "sent", source: "model" }, handoff: null });
    expect(w.port.cancelBooking).toHaveBeenCalledWith(A, MINE, expect.stringMatching(/customer/i));
    expect(userPrompt(w)).toContain("Cancelled: Sun 11 Oct, 3:00 pm.");
    expect(agentMeta(w).offer).toBeNull();
  });

  it("a no keeps it: nothing is cancelled, and the question is over", async () => {
    const w = world({ offer: asking as never, port: withBooking, text: "no, keep it", script: ["No problem, your visit on Sun 11 Oct, 3:00 pm stays."] });
    const out = await replyTurn(runner().step, w.turn, turnOf({ intent: "give_details" }), NOW, w.deps);
    expect(out).toMatchObject({ case: "kept", reply: { status: "sent" } });
    expect(w.port.cancelBooking).not.toHaveBeenCalled();
    expect(agentMeta(w).offer).toBeNull();
  });

  it("anything else asks again and cancels nothing, with no calendar change", async () => {
    const w = world({ offer: asking as never, port: withBooking, text: "hmm what time was it", script: ["Your visit is on Sun 11 Oct, 3:00 pm. Shall I cancel it? Yes or no?"] });
    const r = runner();
    const out = await replyTurn(r.step, w.turn, turnOf({ intent: "give_details" }), NOW, w.deps);
    expect(out).toMatchObject({ case: "cancel_reask", reply: { status: "sent" } });
    expect(r.ran).toEqual(["plan", "reply"]);
    expect(w.port.cancelBooking).not.toHaveBeenCalled();
  });

  it("a question not answered for a day is forgotten: a yes then cancels nothing", async () => {
    const stale = { ...asking, at: new Date(NOW - 3 * 24 * 3_600_000).toISOString() };
    const w = world({ offer: stale as never, port: withBooking, text: "yes", script: ["Hello! How can I help you?"] });
    await replyTurn(runner().step, w.turn, turnOf({ intent: "give_details" }), NOW, w.deps);
    expect(w.port.cancelBooking).not.toHaveBeenCalled();
  });

  it("a model that is not sure the customer wants to cancel is not even asked about it", async () => {
    const w = world({ port: withBooking, script: ["Sure, how can I help?"] });
    const r = runner();
    await replyTurn(r.step, w.turn, turnOf({ intent: "cancel" }, 0.5), NOW, w.deps);
    expect(r.ran).toEqual(["plan", "reply"]);
    expect(w.port.cancelBooking).not.toHaveBeenCalled();
  });

  it("a retry of the whole turn cancels once and sends one reply", async () => {
    const w = world({ offer: asking as never, port: withBooking, text: "yes", script: ["Done, your visit on Sun 11 Oct, 3:00 pm is cancelled."] });
    await replyTurn(runner().step, w.turn, turnOf({ intent: "give_details" }), NOW, w.deps);
    const again = await replyTurn(runner().step, w.turn, turnOf({ intent: "give_details" }), NOW, w.deps);
    expect(again.reply.status).toBe("already_answered");
    expect(w.port.cancelBooking).toHaveBeenCalledOnce();
    expect(w.send).toHaveBeenCalledOnce();
  });

  it("the steps remember small facts only: not the customer's words", async () => {
    const w = world({ offer: asking as never, port: withBooking, text: `${WORDS} yes`, script: ["Done, your visit on Sun 11 Oct, 3:00 pm is cancelled."] });
    const r = runner();
    await replyTurn(r.step, w.turn, turnOf({ intent: "give_details" }), NOW, w.deps);
    const kept = JSON.stringify([...r.memo.values()]);
    for (const secret of [WORDS, HIDDEN.phone, HIDDEN.name]) expect(kept).not.toContain(secret);
  });
});

describe("a lead that is not a fit", () => {
  it("can still cancel a booking it already has", async () => {
    const failed = { ...ready, temperature: "disqualified" as const, readyForSlots: false, hardFail: { field: "budget", rule: "below x" } };
    const w = world({ port: withBooking, script: ["Shall I cancel your visit on Sun 11 Oct, 3:00 pm? Yes or no?"] });
    const out = await replyTurn(runner().step, w.turn, understood({ intent: "cancel", confidence: 0.9 }, failed), NOW, w.deps);
    expect(out).toMatchObject({ case: "cancel_ask" });
  });
});
