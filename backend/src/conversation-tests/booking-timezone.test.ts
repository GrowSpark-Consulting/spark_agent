import { afterEach, describe, expect, it } from "vitest";
import { loadChats } from "./load";
import { runChat } from "./run-chat";

// Day 3 exit test 5: "tomorrow evening" is the BUSINESS's tomorrow evening, in a test that runs with the server's own clock in a different
// time zone. The chat (53) is set at 01:30 on Sunday 11 Oct in Chennai, which is still Saturday 10 Oct in UTC and in Los Angeles; the right
// answer is Monday 12 Oct at 5:30 pm, never Sunday's 6:00 pm slot. It is run with the server's time zone set to several others, and each
// time the test first checks that the setting really changed what the server thinks the local time is.

const ORIGINAL_TZ = process.env.TZ;
const chat = loadChats().find((c) => c.file.includes("53-booking-tomorrow-evening-business-day"))?.chat;

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe("a booking in the business's time zone, whatever the server's", () => {
  it("has the chat", () => {
    expect(chat).toBeDefined();
  });

  // The offset a server in that zone would see for the moment the chat starts (minutes behind UTC, as Date reports it).
  const MOMENT = new Date("2026-10-10T20:00:00.000Z");
  it.each([
    ["UTC", 0],
    ["Pacific/Auckland", -13 * 60],
    ["America/Los_Angeles", 7 * 60],
    ["Asia/Tokyo", -9 * 60],
    ["Pacific/Kiritimati", -14 * 60],
  ])("with the server in %s", async (zone, offset) => {
    process.env.TZ = zone;
    // The setting must really have changed the server's own idea of local time, or this test proves nothing.
    expect(MOMENT.getTimezoneOffset()).toBe(offset);
    const report = await runChat(chat!, { mode: "mock" });
    expect(report.failures).toEqual([]);
    expect(report.transcript[0].reply).toContain("5:30 pm");
    expect(report.transcript[0].planCase).toBe("offer_slots");
  });
});
