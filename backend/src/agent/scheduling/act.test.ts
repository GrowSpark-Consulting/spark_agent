import { describe, expect, it, vi, type Mock } from "vitest";
import { AppError } from "../../lib/errors";
import { runAct, type FoundSlot, type SchedulingPort } from "./act";
import type { OfferedSlot } from "./offer";

const T = "e0000000-0000-0000-0000-00000000000a";
const LEAD = "10000000-0000-0000-0000-0000000000f1";
const SERVICE = "30000000-0000-0000-0000-000000000003";
const RES = "20000000-0000-0000-0000-000000000002";
const BOOKING = "40000000-0000-0000-0000-000000000004";
const IST = "Asia/Kolkata";
const NOW = new Date("2026-10-10T04:30:00.000Z"); // Sat 10 Oct, 10:00 in Chennai

const found = (start: string, label: string): FoundSlot => ({ start, end: new Date(Date.parse(start) + 3_600_000).toISOString(), resourceId: RES, resourceName: "Anand", serviceId: SERVICE, label });
const SUN_10 = found("2026-10-11T04:30:00.000Z", "Sun 11 Oct, 10:00 am");
const SUN_15 = found("2026-10-11T09:30:00.000Z", "Sun 11 Oct, 3:00 pm");
const MON_17 = found("2026-10-12T12:00:00.000Z", "Mon 12 Oct, 5:30 pm");
const offered = (s: FoundSlot): OfferedSlot => ({ start: s.start, end: s.end, resourceId: s.resourceId, serviceId: s.serviceId, label: s.label });

function port(over: Partial<SchedulingPort> = {}) {
  const p = {
    findSlots: vi.fn<SchedulingPort["findSlots"]>(async () => [SUN_10, SUN_15, MON_17]),
    holdSlot: vi.fn<SchedulingPort["holdSlot"]>(async () => ({ id: BOOKING })),
    confirmBooking: vi.fn<SchedulingPort["confirmBooking"]>(async () => ({ id: BOOKING })),
    activeBooking: vi.fn<SchedulingPort["activeBooking"]>(async () => null),
    rescheduleBooking: vi.fn<SchedulingPort["rescheduleBooking"]>(async () => ({ id: BOOKING })),
    cancelBooking: vi.fn<SchedulingPort["cancelBooking"]>(async () => undefined),
    ...over,
  };
  return p as unknown as { [K in keyof SchedulingPort]: Mock<SchedulingPort[K]> };
}
const ctx = (p: SchedulingPort) => ({ tenantId: T, leadId: LEAD, timeZone: IST, now: NOW, port: p });

describe("offering times", () => {
  it("looks where the customer asked first, for this business and service, and offers what it finds", async () => {
    const p = port();
    const result = await runAct({ kind: "offer", serviceId: SERVICE, preferredText: "sunday morning" }, ctx(p));
    expect(result).toEqual({ kind: "offered", slots: [SUN_10, SUN_15, MON_17].map(offered), asked: true });
    expect(p.findSlots).toHaveBeenCalledTimes(1);
    const [tenant, input] = p.findSlots.mock.calls[0];
    expect(tenant).toBe(T);
    expect(input.serviceId).toBe(SERVICE);
    expect(input.from.toISOString()).toBe("2026-10-11T03:30:00.000Z"); // 9:00 in Chennai
    expect(input.to.toISOString()).toBe("2026-10-11T06:30:00.000Z"); // 12:00
  });

  it("widens the search, step by step, when nothing is free where the customer asked, and says so", async () => {
    const p = port({ findSlots: vi.fn<SchedulingPort["findSlots"]>(async (_t, input) => (input.to.getTime() - input.from.getTime() > 24 * 3_600_000 ? [SUN_15] : [])) });
    const result = await runAct({ kind: "offer", serviceId: SERVICE, preferredText: "tomorrow evening" }, ctx(p));
    expect(result).toEqual({ kind: "offered", slots: [offered(SUN_15)], asked: false });
    expect(p.findSlots.mock.calls.length).toBeGreaterThan(1);
  });

  it("with no preference, looks at the next few days, and the times are what was asked for (nothing was asked for)", async () => {
    const p = port();
    const result = await runAct({ kind: "offer", serviceId: SERVICE, preferredText: null }, ctx(p));
    expect(result).toMatchObject({ kind: "offered", asked: true });
    expect(p.findSlots.mock.calls[0][1].from).toEqual(NOW);
  });

  it("words that name no time are no preference either: the soonest times, said as what was asked for", async () => {
    const p = port();
    expect(await runAct({ kind: "offer", serviceId: SERVICE, preferredText: "I would like to visit" }, ctx(p))).toMatchObject({ kind: "offered", asked: true });
  });

  it("leaves out the times the customer has just turned down, and looks further when that leaves none", async () => {
    const p = port({ findSlots: vi.fn<SchedulingPort["findSlots"]>(async (_t, input) => (input.to.getTime() - input.from.getTime() > 4 * 24 * 3_600_000 ? [SUN_10, SUN_15, MON_17] : [SUN_10, SUN_15])) });
    const result = await runAct({ kind: "offer", serviceId: SERVICE, preferredText: null, exclude: [SUN_10.start, SUN_15.start] }, ctx(p));
    expect(result).toMatchObject({ kind: "offered", slots: [offered(MON_17)] });
    expect(p.findSlots.mock.calls.length).toBeGreaterThan(1);
  });

  it("is no_slots when nothing is free anywhere it looks", async () => {
    const p = port({ findSlots: vi.fn<SchedulingPort["findSlots"]>(async () => []) });
    expect(await runAct({ kind: "offer", serviceId: SERVICE, preferredText: "tomorrow" }, ctx(p))).toEqual({ kind: "no_slots" });
  });

  it("offers at most three times", async () => {
    const p = port({ findSlots: vi.fn<SchedulingPort["findSlots"]>(async () => [SUN_10, SUN_15, MON_17, SUN_10, SUN_15]) });
    const result = await runAct({ kind: "offer", serviceId: SERVICE, preferredText: null }, ctx(p));
    expect(result.kind === "offered" && result.slots).toHaveLength(3);
  });

  it("a service or business that is not found is an error result, not a crash", async () => {
    const p = port({ findSlots: vi.fn<SchedulingPort["findSlots"]>(async () => { throw new AppError("not_found", "That service isn't available."); }) });
    expect(await runAct({ kind: "offer", serviceId: SERVICE, preferredText: null }, ctx(p))).toEqual({ kind: "error" });
  });

  it("an outage is not hidden: it is thrown, so the step is tried again", async () => {
    const p = port({ findSlots: vi.fn<SchedulingPort["findSlots"]>(async () => { throw new Error("database down"); }) });
    await expect(runAct({ kind: "offer", serviceId: SERVICE, preferredText: null }, ctx(p))).rejects.toThrow("database down");
  });
});

describe("booking the time the customer picked", () => {
  const book = { kind: "book", serviceId: SERVICE, bookingKind: "site_visit", slot: offered(SUN_15) } as const;

  it("holds it for this lead, then confirms it", async () => {
    const p = port();
    expect(await runAct(book, ctx(p))).toEqual({ kind: "booked", label: "Sun 11 Oct, 3:00 pm" });
    expect(p.holdSlot).toHaveBeenCalledWith(T, offered(SUN_15), LEAD, "site_visit");
    expect(p.confirmBooking).toHaveBeenCalledWith(T, BOOKING);
    expect(p.holdSlot.mock.invocationCallOrder[0]).toBeLessThan(p.confirmBooking.mock.invocationCallOrder[0]);
  });

  it("when someone else took it first, offers other times and says so (nothing is booked)", async () => {
    const p = port({ holdSlot: vi.fn<SchedulingPort["holdSlot"]>(async () => { throw new AppError("slot_taken", "That time was just taken. Pick another one."); }) });
    const result = await runAct(book, ctx(p));
    expect(result).toMatchObject({ kind: "offered", asked: false, retaken: true });
    expect(p.confirmBooking).not.toHaveBeenCalled();
  });

  it("when someone took it and nothing else is free, says there is nothing", async () => {
    const p = port({
      holdSlot: vi.fn<SchedulingPort["holdSlot"]>(async () => { throw new AppError("slot_taken", "taken"); }),
      findSlots: vi.fn<SchedulingPort["findSlots"]>(async () => []),
    });
    expect(await runAct(book, ctx(p))).toEqual({ kind: "no_slots" });
  });

  it("a retry after the booking was already made does not book twice: it finds it and reports it", async () => {
    const p = port({ activeBooking: vi.fn<SchedulingPort["activeBooking"]>(async () => ({ id: BOOKING, start: SUN_15.start, end: SUN_15.end, status: "confirmed" })) });
    expect(await runAct(book, ctx(p))).toEqual({ kind: "booked", label: "Sun 11 Oct, 3:00 pm" });
    expect(p.holdSlot).not.toHaveBeenCalled();
    expect(p.confirmBooking).not.toHaveBeenCalled();
  });

  it("a retry after the hold was made but not confirmed holds again (a lead has one hold; the engine replaces it) and confirms", async () => {
    const p = port({ activeBooking: vi.fn<SchedulingPort["activeBooking"]>(async () => ({ id: BOOKING, start: SUN_15.start, end: SUN_15.end, status: "held" })) });
    expect(await runAct(book, ctx(p))).toEqual({ kind: "booked", label: "Sun 11 Oct, 3:00 pm" });
    expect(p.holdSlot).toHaveBeenCalledOnce();
    expect(p.confirmBooking).toHaveBeenCalledOnce();
  });

  it("another time the lead already has booked does not stop a new booking", async () => {
    const p = port({ activeBooking: vi.fn<SchedulingPort["activeBooking"]>(async () => ({ id: "50000000-0000-0000-0000-000000000005", start: SUN_10.start, end: SUN_10.end, status: "confirmed" })) });
    expect(await runAct(book, ctx(p))).toEqual({ kind: "booked", label: "Sun 11 Oct, 3:00 pm" });
    expect(p.holdSlot).toHaveBeenCalledOnce();
  });

  it("a time that cannot be held for another reason (gone, service or resource not found) is an error result", async () => {
    const p = port({ holdSlot: vi.fn<SchedulingPort["holdSlot"]>(async () => { throw new AppError("validation_failed", "That time has already passed."); }) });
    expect(await runAct(book, ctx(p))).toEqual({ kind: "error" });
    expect(p.confirmBooking).not.toHaveBeenCalled();
  });

  it("a hold that cannot be confirmed (it expired) is an error result", async () => {
    const p = port({ confirmBooking: vi.fn<SchedulingPort["confirmBooking"]>(async () => { throw new AppError("conflict", "That hold has expired."); }) });
    expect(await runAct(book, ctx(p))).toEqual({ kind: "error" });
  });

  it("an outage is thrown so the step is tried again", async () => {
    const p = port({ confirmBooking: vi.fn<SchedulingPort["confirmBooking"]>(async () => { throw new Error("database down"); }) });
    await expect(runAct(book, ctx(p))).rejects.toThrow("database down");
  });
});

describe("moving a booking", () => {
  const OLD = "50000000-0000-0000-0000-000000000005";
  const move = { kind: "reschedule", serviceId: SERVICE, bookingId: OLD, slot: offered(SUN_15) } as const;

  it("looks for times for it like for a new booking, and says the offer is for moving it", async () => {
    const p = port();
    const result = await runAct({ kind: "offer", serviceId: SERVICE, preferredText: "monday evening", rescheduleBookingId: OLD }, ctx(p));
    expect(result).toMatchObject({ kind: "offered", rescheduleBookingId: OLD });
    expect(p.holdSlot).not.toHaveBeenCalled();
  });

  it("moves it with the booking engine to the time the customer picked", async () => {
    const p = port();
    expect(await runAct(move, ctx(p))).toEqual({ kind: "rescheduled", label: "Sun 11 Oct, 3:00 pm" });
    expect(p.rescheduleBooking).toHaveBeenCalledWith(T, OLD, offered(SUN_15));
    expect(p.holdSlot).not.toHaveBeenCalled();
  });

  it("when someone took that time first: nothing is moved, and the others are offered, still for moving it", async () => {
    const p = port({ rescheduleBooking: vi.fn<SchedulingPort["rescheduleBooking"]>(async () => { throw new AppError("slot_taken", "taken"); }), findSlots: vi.fn<SchedulingPort["findSlots"]>(async () => [SUN_10]) });
    expect(await runAct(move, ctx(p))).toEqual({ kind: "offered", slots: [offered(SUN_10)], asked: false, retaken: true, rescheduleBookingId: OLD });
  });

  it("a retry after it was already moved does not move it again", async () => {
    const p = port({ activeBooking: vi.fn<SchedulingPort["activeBooking"]>(async () => ({ id: BOOKING, start: SUN_15.start, end: SUN_15.end, status: "confirmed" })) });
    expect(await runAct(move, ctx(p))).toEqual({ kind: "rescheduled", label: "Sun 11 Oct, 3:00 pm" });
    expect(p.rescheduleBooking).not.toHaveBeenCalled();
  });

  it("a booking that cannot be moved (not confirmed, not found) is an error result; an outage is thrown", async () => {
    const refused = port({ rescheduleBooking: vi.fn<SchedulingPort["rescheduleBooking"]>(async () => { throw new AppError("conflict", "Only a confirmed booking can be moved."); }) });
    expect(await runAct(move, ctx(refused))).toEqual({ kind: "error" });
    const down = port({ rescheduleBooking: vi.fn<SchedulingPort["rescheduleBooking"]>(async () => { throw new Error("database down"); }) });
    await expect(runAct(move, ctx(down))).rejects.toThrow("database down");
  });
});

describe("cancelling a booking asks first", () => {
  const OLD = "50000000-0000-0000-0000-000000000005";

  it("asking changes nothing in the calendar: it only says the question was asked", async () => {
    const p = port();
    expect(await runAct({ kind: "ask_cancel", bookingId: OLD, label: "Sun 11 Oct, 3:00 pm" }, ctx(p))).toEqual({ kind: "cancel_asked", bookingId: OLD, label: "Sun 11 Oct, 3:00 pm" });
    for (const fn of [p.findSlots, p.holdSlot, p.confirmBooking, p.rescheduleBooking, p.cancelBooking]) expect(fn).not.toHaveBeenCalled();
  });

  it("an answer of yes cancels that booking, with a reason that says who asked", async () => {
    const p = port();
    expect(await runAct({ kind: "cancel", bookingId: OLD, label: "Sun 11 Oct, 3:00 pm" }, ctx(p))).toEqual({ kind: "cancelled", label: "Sun 11 Oct, 3:00 pm" });
    expect(p.cancelBooking).toHaveBeenCalledWith(T, OLD, expect.stringMatching(/customer/i));
  });

  it("a booking that is already gone counts as cancelled; any other refusal is an error result", async () => {
    const gone = port({ cancelBooking: vi.fn<SchedulingPort["cancelBooking"]>(async () => { throw new AppError("not_found", "That booking wasn't found."); }) });
    expect(await runAct({ kind: "cancel", bookingId: OLD, label: "x" }, ctx(gone))).toEqual({ kind: "cancelled", label: "x" });
    const refused = port({ cancelBooking: vi.fn<SchedulingPort["cancelBooking"]>(async () => { throw new AppError("conflict", "Already completed."); }) });
    expect(await runAct({ kind: "cancel", bookingId: OLD, label: "x" }, ctx(refused))).toEqual({ kind: "error" });
  });

  it("an answer of no keeps the booking: nothing is called, and the question is over", async () => {
    const p = port();
    expect(await runAct({ kind: "keep", label: "Sun 11 Oct, 3:00 pm" }, ctx(p))).toEqual({ kind: "kept", label: "Sun 11 Oct, 3:00 pm" });
    expect(p.cancelBooking).not.toHaveBeenCalled();
  });

  it("an outage while cancelling is thrown, so the step is tried again", async () => {
    const p = port({ cancelBooking: vi.fn<SchedulingPort["cancelBooking"]>(async () => { throw new Error("database down"); }) });
    await expect(runAct({ kind: "cancel", bookingId: OLD, label: "x" }, ctx(p))).rejects.toThrow("database down");
  });
});
