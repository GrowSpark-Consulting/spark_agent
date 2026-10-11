import { describe, expect, it } from "vitest";
import { MAX_WINDOW_DAYS } from "../../booking/slots";
import { addDays, localParts } from "../../booking/time";
import { offerFacts, searchWindows, toOffered, type OfferedSlot } from "./offer";
import { parsePreferredTime } from "./preferred-time";

const IST = "Asia/Kolkata";
const NOW = new Date("2026-10-10T04:30:00.000Z"); // Sat 10 Oct, 10:00 in Chennai
const DAY = 24 * 60 * 60_000;
const ID = "10000000-0000-0000-0000-000000000001";
const RES = "20000000-0000-0000-0000-000000000002";

describe("what is remembered about an offer", () => {
  const slot = { start: "2026-10-11T04:30:00.000Z", end: "2026-10-11T05:30:00.000Z", resourceId: RES, resourceName: "Anand", serviceId: ID, label: "Sun 11 Oct, 10:00 am", extra: "dropped" };

  it("keeps what is needed to book the time later, and nothing else", () => {
    expect(toOffered([slot])).toEqual([{ start: slot.start, end: slot.end, resourceId: RES, serviceId: ID, label: "Sun 11 Oct, 10:00 am" }]);
  });

  it("offers at most three", () => {
    expect(toOffered([slot, slot, slot, slot, slot])).toHaveLength(3);
  });
});

describe("the facts the reply may use", () => {
  const offered: OfferedSlot[] = [
    { start: "2026-10-11T04:30:00.000Z", end: "2026-10-11T05:30:00.000Z", resourceId: RES, serviceId: ID, label: "Sun 11 Oct, 10:00 am" },
    { start: "2026-10-11T09:30:00.000Z", end: "2026-10-11T10:30:00.000Z", resourceId: RES, serviceId: ID, label: "Sun 11 Oct, 3:00 pm" },
  ];

  it("lists each time exactly as its label reads, so the post-check can find it", () => {
    expect(offerFacts(offered, { asked: true })).toEqual(["Free times: Sun 11 Oct, 10:00 am; Sun 11 Oct, 3:00 pm."]);
  });

  it("says so when nothing was free at the time the customer asked", () => {
    expect(offerFacts(offered, { asked: false })).toEqual([
      "Nothing was free at the time the customer asked for. These are the closest free times.",
      "Free times: Sun 11 Oct, 10:00 am; Sun 11 Oct, 3:00 pm.",
    ]);
  });

  it("with no times, says there are none and promises nothing", () => {
    expect(offerFacts([], { asked: false })).toEqual(["No free time was found in the coming days. A team member will follow up with the customer."]);
  });
});

describe("where to look for free times", () => {
  const window = (text: string) => parsePreferredTime(text, { timeZone: IST, now: NOW });

  it("with no preference: the next three days, then a wider look", () => {
    const tries = searchWindows(null, NOW, IST);
    expect(tries.map((t) => t.kind)).toEqual(["soon", "later"]);
    expect(tries[0].from).toEqual(NOW);
    expect(tries[0].to.getTime() - NOW.getTime()).toBe(3 * DAY);
    expect(tries[1].to.getTime() - NOW.getTime()).toBe(MAX_WINDOW_DAYS * DAY);
  });

  it("with a preference: that window first, then the whole day, then the days after it", () => {
    const evening = window("tomorrow evening")!;
    const tries = searchWindows(evening, NOW, IST);
    expect(tries.map((t) => t.kind)).toEqual(["asked", "day", "soon", "later"]);
    expect(tries[0]).toMatchObject({ from: evening.from, to: evening.to });
    expect(localParts(tries[1].from, IST)).toMatchObject({ date: "2026-10-11", minuteOfDay: 0 });
    expect(localParts(tries[1].to, IST).date).toBe(addDays("2026-10-11", 1));
  });

  it("a whole-day preference has no separate whole-day try", () => {
    expect(searchWindows(window("sunday")!, NOW, IST).map((t) => t.kind)).toEqual(["asked", "soon", "later"]);
  });

  it("never looks into the past, and never further than the booking engine allows", () => {
    const today = window("today morning")!; // 9 to 12 today: already part gone at 10:00
    for (const t of searchWindows(today, NOW, IST)) {
      expect(t.from.getTime()).toBeGreaterThanOrEqual(NOW.getTime());
      expect(t.to.getTime()).toBeGreaterThan(t.from.getTime());
      expect(t.to.getTime() - t.from.getTime()).toBeLessThanOrEqual(MAX_WINDOW_DAYS * DAY);
    }
  });

  it("a preference wholly in the past starts looking from now", () => {
    const tries = searchWindows(window("today 7am")!, NOW, IST);
    expect(tries.map((t) => t.kind)).not.toContain("asked");
    expect(tries[0].from).toEqual(NOW);
  });

  it("a day far ahead is not searched beyond the engine's limit", () => {
    for (const t of searchWindows(window("20 oct")!, NOW, IST)) expect(t.to.getTime() - t.from.getTime()).toBeLessThanOrEqual(MAX_WINDOW_DAYS * DAY);
  });
});
