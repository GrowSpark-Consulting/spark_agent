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

  it("with no preference, looks at the next few days", async () => {
    const p = port();
    const result = await runAct({ kind: "offer", serviceId: SERVICE, preferredText: null }, ctx(p));
    expect(result).toMatchObject({ kind: "offered", asked: false });
    expect(p.findSlots.mock.calls[0][1].from).toEqual(NOW);
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
