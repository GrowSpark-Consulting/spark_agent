import { describe, expect, it } from "vitest";
import { parsePreferredTime } from "./preferred-time";

const IST = "Asia/Kolkata";
// Sat 10 Oct 2026, 10:00 in Chennai (04:30 UTC).
const NOW = new Date("2026-10-10T04:30:00.000Z");

const parse = (text: string, now = NOW, timeZone = IST) => {
  const result = parsePreferredTime(text, { timeZone, now });
  return result && { date: result.date, from: result.from.toISOString(), to: result.to.toISOString(), exact: result.exact };
};
// The business's local wall time as UTC, for readable expectations: ist("2026-10-11", 17, 0).
const ist = (date: string, hour: number, minute = 0) => new Date(Date.parse(`${date}T00:00:00.000Z`) + (hour * 60 + minute) * 60_000 - 330 * 60_000).toISOString();

describe("the day", () => {
  it.each([
    ["today", "2026-10-10"],
    ["tomorrow", "2026-10-11"],
    ["tmrw", "2026-10-11"],
    ["day after tomorrow", "2026-10-12"],
    ["naalai", "2026-10-11"],
    ["naalaikku", "2026-10-11"],
    ["inniki", "2026-10-10"],
    ["நாளை", "2026-10-11"],
    ["இன்று", "2026-10-10"],
  ])("%s", (text, date) => {
    expect(parse(text)?.date).toBe(date);
  });

  it.each([
    ["sunday", "2026-10-11"],
    ["on Monday", "2026-10-12"],
    ["next monday", "2026-10-12"],
    ["fri", "2026-10-16"],
    ["saturday", "2026-10-17"], // today is a Saturday: the next one, a week away
    ["this weekend", "2026-10-17"],
  ])("a weekday, %s: the next one after today", (text, date) => {
    expect(parse(text)?.date).toBe(date);
  });

  it.each([
    ["12 oct", "2026-10-12"],
    ["Oct 14th", "2026-10-14"],
    ["20 October", "2026-10-20"],
    ["14/10", "2026-10-14"],
    ["1 jan", "2027-01-01"], // already past this year: the next one
  ])("a date, %s", (text, date) => {
    expect(parse(text)?.date).toBe(date);
  });

  it("is the business's day, not the server's: an evening in Chennai that is already tomorrow in UTC", () => {
    const lateIst = new Date("2026-10-10T20:00:00.000Z"); // 01:30 on Sun 11 Oct in Chennai
    expect(parse("tomorrow evening", lateIst)).toMatchObject({ date: "2026-10-12", from: ist("2026-10-12", 17), to: ist("2026-10-12", 21) });
    expect(parse("today", lateIst)?.date).toBe("2026-10-11");
  });

  it("follows the business's time zone: the same moment is a different local day elsewhere", () => {
    const moment = new Date("2026-10-10T20:00:00.000Z"); // 13:00 on Sat 10 Oct in Los Angeles
    expect(parsePreferredTime("tomorrow", { timeZone: "America/Los_Angeles", now: moment })?.date).toBe("2026-10-11");
    expect(parsePreferredTime("tomorrow", { timeZone: IST, now: moment })?.date).toBe("2026-10-12");
  });
});

describe("the part of the day", () => {
  it.each([
    ["tomorrow morning", 9, 12],
    ["tomorrow afternoon", 12, 17],
    ["tomorrow evening", 17, 21],
    ["tomorrow night", 17, 21],
    ["naalai kaalai", 9, 12],
    ["naalai maalai", 17, 21],
    ["நாளை மாலை", 17, 21],
    ["naalai madhiyam", 12, 17],
  ])("%s", (text, from, to) => {
    expect(parse(text)).toMatchObject({ date: "2026-10-11", from: ist("2026-10-11", from), to: ist("2026-10-11", to), exact: false });
  });

  it("a day with no part is the whole of it", () => {
    expect(parse("sunday")).toMatchObject({ from: ist("2026-10-11", 0), to: ist("2026-10-12", 0), exact: false });
  });
});

describe("a time", () => {
  it.each([
    ["tomorrow 5pm", 17, 0],
    ["tomorrow at 5:30 pm", 17, 30],
    ["tomorrow 17:00", 17, 0],
    ["tomorrow 10 am", 10, 0],
    ["tomorrow at 5", 17, 0], // 1 to 8 with no am/pm is the afternoon or evening
    ["tomorrow at 10", 10, 0], // 9 to 11 is the morning
    ["tomorrow 12", 12, 0],
    ["tomorrow 6 o'clock", 18, 0],
  ])("%s is that time, with two hours around it", (text, hour, minute) => {
    expect(parse(text)).toMatchObject({ date: "2026-10-11", from: ist("2026-10-11", hour, minute), to: ist("2026-10-11", hour + 2, minute), exact: true });
  });

  it("after a time runs to the end of the evening", () => {
    expect(parse("tomorrow after 6")).toMatchObject({ from: ist("2026-10-11", 18), to: ist("2026-10-11", 21), exact: false });
    expect(parse("tomorrow after 6pm")).toMatchObject({ from: ist("2026-10-11", 18), to: ist("2026-10-11", 21) });
  });

  it("a time with no day is today if it is still ahead, otherwise tomorrow", () => {
    expect(parse("5pm")?.date).toBe("2026-10-10"); // 10:00 now
    expect(parse("9am")?.date).toBe("2026-10-11"); // already past today
    expect(parse("evening")?.date).toBe("2026-10-10");
    const lateEvening = new Date("2026-10-10T16:00:00.000Z"); // 21:30 in Chennai
    expect(parse("evening", lateEvening)?.date).toBe("2026-10-11");
  });

  it("a time that is not a time is ignored: 2BHK, a budget, a pincode", () => {
    expect(parse("2BHK in Velachery")).toBeNull();
    expect(parse("80 lakh budget")).toBeNull();
    expect(parse("600042")).toBeNull();
  });
});

describe("nothing usable", () => {
  it.each([[""], ["   "], ["whenever"], ["any time works"], ["hello"], ["?"]])("%j is null, so the caller offers its default window", (text) => {
    expect(parse(text)).toBeNull();
  });

  it("never throws on odd text", () => {
    for (const text of ["32 oct", "31/02", "0 pm", "25:99", "😀", "a".repeat(5000)]) expect(() => parsePreferredTime(text, { timeZone: IST, now: NOW })).not.toThrow();
  });

  it("an impossible date is not guessed", () => {
    expect(parse("31/02")).toBeNull();
    expect(parse("32 oct")).toBeNull();
  });
});
