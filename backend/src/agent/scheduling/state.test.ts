import { describe, expect, it } from "vitest";
import { freshOffer, OFFER_MAX_AGE_MS, parseOfferState, parsePendingState } from "./state";

const ID = "10000000-0000-0000-0000-000000000001";
const RES = "20000000-0000-0000-0000-000000000002";
const slot = { start: "2026-10-13T04:30:00.000Z", end: "2026-10-13T05:30:00.000Z", resourceId: RES, serviceId: ID, label: "Tue 13 Oct, 10:00 am" };
const AT = "2026-10-10T04:30:00.000Z";

describe("reading the remembered offer back (it comes from a database column, so nothing is trusted)", () => {
  it("accepts an offer as it was written", () => {
    expect(parseOfferState({ slots: [slot], at: AT })).toEqual({ slots: [slot], at: AT });
  });

  it("keeps only the known fields of each time", () => {
    expect(parseOfferState({ slots: [{ ...slot, extra: "x" }], at: AT })?.slots[0]).toEqual(slot);
  });

  it.each([
    ["null (the offer was ended)", null],
    ["undefined", undefined],
    ["a string", "x"],
    ["an array", []],
    ["no times", { slots: [], at: AT }],
    ["more than three times", { slots: [slot, slot, slot, slot], at: AT }],
    ["a time with no label", { slots: [{ ...slot, label: "" }], at: AT }],
    ["a time that is not a time", { slots: [{ ...slot, start: "soon" }], at: AT }],
    ["an end before the start", { slots: [{ ...slot, end: "2026-10-13T04:00:00.000Z" }], at: AT }],
    ["a resource that is not an id", { slots: [{ ...slot, resourceId: "r1" }], at: AT }],
    ["no offer time", { slots: [slot] }],
  ])("is no offer for %s", (_why, value) => {
    expect(parseOfferState(value)).toBeNull();
  });
});

describe("an offer goes stale", () => {
  const offer = { slots: [slot], at: AT };
  const at = Date.parse(AT);

  it("is outstanding for a day", () => {
    expect(freshOffer(offer, new Date(at + 60_000))).toEqual(offer);
    expect(freshOffer(offer, new Date(at + OFFER_MAX_AGE_MS))).toEqual(offer);
  });

  it("is forgotten after that, and when it is already in the past or cannot be dated", () => {
    expect(freshOffer(offer, new Date(at + OFFER_MAX_AGE_MS + 1))).toBeNull();
    expect(freshOffer({ slots: [slot], at: "never" }, new Date(at))).toBeNull();
  });

  it("is forgotten once its first time has passed (a time that has gone cannot be booked), even when it is not a day old", () => {
    const early = { slots: [slot], at: "2026-10-13T03:00:00.000Z" };
    expect(freshOffer(early, new Date("2026-10-13T04:00:00.000Z"))).toEqual(early);
    expect(freshOffer(early, new Date(Date.parse(slot.start) + 1))).toBeNull();
  });

  it("no offer stays no offer", () => {
    expect(freshOffer(null, new Date(at))).toBeNull();
  });
});

// Moving or cancelling a booking (Day 3): the same remembered state also carries "this offer is for moving booking X" and "we asked whether
// to cancel booking X". Nothing is cancelled until the customer answers yes.
describe("moving a booking, and asking before cancelling one", () => {
  const BOOKING = "40000000-0000-0000-0000-000000000004";

  it("an offer can be for moving a booking", () => {
    expect(parseOfferState({ slots: [slot], at: AT, rescheduleBookingId: BOOKING })).toEqual({ slots: [slot], at: AT, rescheduleBookingId: BOOKING });
    expect(parseOfferState({ slots: [slot], at: AT, rescheduleBookingId: "b1" })).toEqual({ slots: [slot], at: AT }); // an id that is not an id is dropped, not trusted
  });

  it("a question whether to cancel is read back as such", () => {
    expect(parsePendingState({ cancel: { bookingId: BOOKING, label: "Tue 13 Oct, 10:00 am" }, at: AT })).toEqual({ cancel: { bookingId: BOOKING, label: "Tue 13 Oct, 10:00 am" }, at: AT });
  });

  it("an offer is read as before", () => {
    expect(parsePendingState({ slots: [slot], at: AT })).toEqual({ slots: [slot], at: AT });
  });

  it.each([
    ["null", null],
    ["a booking that is not an id", { cancel: { bookingId: "b1", label: "x" }, at: AT }],
    ["no label", { cancel: { bookingId: BOOKING, label: "" }, at: AT }],
    ["no time", { cancel: { bookingId: BOOKING, label: "x" } }],
    ["both an offer and a cancellation (it is neither)", { slots: [slot], cancel: { bookingId: BOOKING, label: "x" }, at: AT }],
    ["nothing", {}],
  ])("a pending state that is %s is nothing", (_why, value) => {
    expect(parsePendingState(value)).toBeNull();
  });

  it("a question whether to cancel goes stale after a day", () => {
    const ask = { cancel: { bookingId: BOOKING, label: "x" }, at: AT };
    expect(freshOffer(ask, new Date(Date.parse(AT) + 60_000))).toEqual(ask);
    expect(freshOffer(ask, new Date(Date.parse(AT) + OFFER_MAX_AGE_MS + 1))).toBeNull();
  });
});
