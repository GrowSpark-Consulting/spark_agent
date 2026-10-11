import { describe, expect, it } from "vitest";
import { freshOffer, OFFER_MAX_AGE_MS, parseOfferState } from "./state";

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
