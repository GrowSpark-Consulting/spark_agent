import { describe, expect, it } from "vitest";
import { amountsIn, checkReply, datesIn, timesIn, REPLY_MAX_CHARS } from "./postcheck";

// The post-check: every ₹ amount, date and time in a reply must be in the facts it was given (docs/handover.md).

const amounts = (text: string) => [...amountsIn(text)].sort((a, b) => a - b);

describe("amountsIn: the same amount written differently is the same amount", () => {
  it.each([
    ["₹85 lakh", [8_500_000]],
    ["85L", [8_500_000]],
    ["₹85L", [8_500_000]],
    ["₹85,00,000", [8_500_000]],
    ["₹8500000", [8_500_000]],
    ["Rs. 85,00,000", [8_500_000]],
    ["Rs 85 lakhs", [8_500_000]],
    ["INR 85 lac", [8_500_000]],
    ["85 lakh", [8_500_000]],
    ["₹1.2 crore", [12_000_000]],
    ["1.2 Cr", [12_000_000]],
    ["₹1,20,00,000", [12_000_000]],
    ["₹50k", [50_000]],
    ["₹50 thousand", [50_000]],
    ["₹2,500", [2_500]],
    ["₹75.5 lakh", [7_550_000]],
  ])("%s is %j", (text, expected) => {
    expect(amounts(text)).toEqual(expected);
  });

  it("reads a range with one unit as two amounts", () => {
    expect(amounts("₹80-90 lakh")).toEqual([8_000_000, 9_000_000]);
    expect(amounts("80 to 90L")).toEqual([8_000_000, 9_000_000]);
    expect(amounts("₹80L - ₹90L")).toEqual([8_000_000, 9_000_000]);
  });

  it("reads Tamil and Hindi numerals and unit words", () => {
    expect(amounts("௮௫ லட்சம்")).toEqual([8_500_000]);
    expect(amounts("₹௮௫,௦௦,௦௦௦")).toEqual([8_500_000]);
    expect(amounts("1.5 கோடி")).toEqual([15_000_000]);
    expect(amounts("८५ लाख")).toEqual([8_500_000]);
    expect(amounts("₹१२०००")).toEqual([12_000]);
  });

  it("reads rupees written in Tamil, Hindi and English words, and the /- form", () => {
    expect(amounts("ரூ.5000")).toEqual([5000]);
    expect(amounts("5000 ரூபாய்")).toEqual([5000]);
    expect(amounts("रु 5000")).toEqual([5000]);
    expect(amounts("5000 रुपये")).toEqual([5000]);
    expect(amounts("5000 rupees")).toEqual([5000]);
    expect(amounts("rupees 5000")).toEqual([5000]);
    expect(amounts("Rs.5000/-")).toEqual([5000]);
    expect(amounts("5000/-")).toEqual([5000]);
    expect(amounts("85 lakh rupees")).toEqual([8_500_000]);
  });

  it("reads a Tamil unit with an ending, and a spaced capital L, K or Cr", () => {
    expect(amounts("85 லட்சத்தில்")).toEqual([8_500_000]);
    expect(amounts("2 கோடியில்")).toEqual([20_000_000]);
    expect(amounts("85 L")).toEqual([8_500_000]);
    expect(amounts("50 K")).toEqual([50_000]);
    expect(amounts("1.2 Cr")).toEqual([12_000_000]);
    expect(amounts("5 l of paint")).toEqual([]);
  });

  it("reads another currency as an amount too, so a price in dollars is caught", () => {
    expect(amounts("$500")).toEqual([500]);
    expect(amounts("500 USD")).toEqual([500]);
    expect(amounts("USD 500")).toEqual([500]);
    expect(amounts("500 dollars")).toEqual([500]);
    expect(amounts("€40")).toEqual([40]);
  });

  it("does not take a plain number for an amount: sizes, floors, counts, BHK", () => {
    expect(amounts("2BHK of 950 sq ft on the 3rd floor, 4 lifts, block 12")).toEqual([]);
    expect(amounts("Call extension 1234")).toEqual([]);
    expect(amounts("1-2 BHK")).toEqual([]);
    expect(amounts("We have 3 towers")).toEqual([]);
  });

  it("does not read a letter of an ordinary word as a unit", () => {
    expect(amounts("2 lakes nearby, 5 km")).toEqual([]);
    expect(amounts("Open 24 hours, 7 days")).toEqual([]);
    expect(amounts("10 kitchens")).toEqual([]);
  });
});

describe("datesIn", () => {
  const key = (text: string) => datesIn(text).map((d) => `${d.month}/${d.day}${d.year ? `/${d.year}` : ""}`);

  it.each([
    ["10 Oct", ["10/10"]],
    ["10th October", ["10/10"]],
    ["Oct 10", ["10/10"]],
    ["October 10th, 2026", ["10/10/2026"]],
    ["Fri 9 Oct, 5:00 pm", ["10/9"]],
    ["10/10", ["10/10"]],
    ["09/10/2026", ["10/9/2026"]],
    ["2026-10-09", ["10/9/2026"]],
    ["9-10-2026", ["10/9/2026"]],
    ["1 Jan 2026", ["1/1/2026"]],
    ["5 Sept", ["9/5"]],
    ["31 Dec", ["12/31"]],
    ["24 / 7", []],
  ])("%s is %j", (text, expected) => {
    expect(key(text)).toEqual(expected);
  });

  it("does not take 'open 24/7' for the 24th of July", () => {
    expect(key("We are open 24/7")).toEqual([]);
    expect(key("Call 24/7 on the helpline")).toEqual([]);
    expect(key("24/07")).toEqual(["7/24"]); // a real dd/mm still is one
  });

  it("does not take other numbers for a date", () => {
    expect(key("2BHK, 950 sq ft, 3rd floor, 1-2 BHK, 3.5 lakh, 12 towers")).toEqual([]);
    expect(key("It may 2026 be")).toEqual([]);
    expect(key("32 Oct")).toEqual([]);
    expect(key("13/13")).toEqual([]);
  });
});

describe("timesIn", () => {
  const key = (text: string) => timesIn(text).map((t) => `${t.hour12}:${String(t.minute).padStart(2, "0")}${t.period ?? ""}`);

  it.each([
    ["5 pm", ["5:00pm"]],
    ["5pm", ["5:00pm"]],
    ["5:30 PM", ["5:30pm"]],
    ["10 a.m.", ["10:00am"]],
    ["12 am", ["0:00am"]],
    ["17:00", ["5:00pm"]],
    ["09:30", ["9:30"]],
    ["00:15", ["0:15am"]],
    ["10:00 am to 7:00 pm", ["10:00am", "7:00pm"]],
    ["5 மணிக்கு", ["5:00"]],
    ["5 baje", ["5:00"]],
    ["௫ மணி", ["5:00"]],
    ["5.30 pm", ["5:30pm"]],
    ["10.15 AM", ["10:15am"]],
  ])("%s is %j", (text, expected) => {
    expect(key(text)).toEqual(expected);
  });

  it("does not take other numbers for a time", () => {
    expect(key("2BHK, 950 sq ft, 3.5 lakh, ratio 3:1:2, version 2.30, 25:00, 12:75")).toEqual([]);
  });
});

describe("checkReply: amounts", () => {
  const facts = ["2BHK of 950 sq ft starts at ₹78 lakh. 3BHK from 1.1 crore."];

  it("passes an amount that is in the facts, however it is written", () => {
    expect(checkReply("A 2BHK starts at ₹78,00,000.", facts)).toEqual({ ok: true, problems: [] });
    expect(checkReply("2BHK from 78L, 3BHK from ₹1.1 Cr", facts).ok).toBe(true);
    expect(checkReply("௭௮ லட்சம் முதல்", facts).ok).toBe(true);
  });

  it("fails an amount that is not in the facts", () => {
    expect(checkReply("A 2BHK starts at ₹65 lakh.", facts)).toEqual({ ok: false, problems: ["amount"] });
  });

  it("fails an invented price in Tamil rupees or in dollars", () => {
    expect(checkReply("2BHK ரூ.65 லட்சம் ஆரம்பம்", facts).problems).toEqual(["amount"]);
    expect(checkReply("It is 5000 rupees a month", facts).problems).toEqual(["amount"]);
    expect(checkReply("From $90000", facts).problems).toEqual(["amount"]);
  });

  it("fails an amount the customer pushed for: a discount, a price they quoted", () => {
    // (a percentage alone is not checked: the prompt forbids inventing offers; the price beside it is what is caught)
    expect(checkReply("Sure, 90% off is possible: ₹7 lakh for the 2BHK.", facts).problems).toContain("amount");
    expect(checkReply("Yes, you can have it for ₹1.", facts).problems).toContain("amount");
  });

  it("passes a reply with no amounts, whatever the facts", () => {
    expect(checkReply("Happy to help! What area are you looking at?", []).ok).toBe(true);
    expect(checkReply("A 2BHK of 950 sq ft, on the 3rd floor.", []).ok).toBe(true);
  });

  it("fails every amount when there are no facts", () => {
    expect(checkReply("It costs ₹78 lakh.", []).problems).toEqual(["amount"]);
  });

  it("fails if only one of two amounts is in the facts", () => {
    expect(checkReply("From ₹78 lakh to ₹95 lakh.", facts).problems).toEqual(["amount"]);
  });
});

describe("checkReply: dates and times", () => {
  const facts = ["Slots: Fri 9 Oct, 5:00 pm; Sat 10 Oct, 11:00 am. Open 10:00 am to 7:00 pm."];

  it("passes a date and a time that are in the facts, in another spelling", () => {
    expect(checkReply("How about October 9th at 5 pm?", facts).ok).toBe(true);
    expect(checkReply("Saturday 10/10 at 11am works", facts).ok).toBe(true);
    expect(checkReply("We open at 10 am.", facts).ok).toBe(true);
    expect(checkReply("Shall I book 17:00 on 9 Oct?", facts).ok).toBe(true);
  });

  it("fails a date that is not in the facts", () => {
    expect(checkReply("How about 12 Oct at 5 pm?", facts).problems).toEqual(["date"]);
  });

  it("matches a time written the Indian way", () => {
    expect(checkReply("Shall we say 5.00 pm on 9 Oct?", facts).ok).toBe(true);
    expect(checkReply("Shall we say 6.30 pm on 9 Oct?", facts).problems).toEqual(["time"]);
  });

  it("fails a time that is not in the facts", () => {
    expect(checkReply("How about 9 Oct at 6 pm?", facts).problems).toEqual(["time"]);
    expect(checkReply("How about 9 Oct at 5:30 pm?", facts).problems).toEqual(["time"]);
    expect(checkReply("How about 9 Oct at 5 am?", facts).problems).toEqual(["time"]);
  });

  it("matches a year only when both have one", () => {
    expect(checkReply("9 Oct 2026, 5 pm", facts).ok).toBe(true);
    expect(checkReply("9 Oct 2026, 5 pm", ["9 Oct 2027, 5 pm"]).problems).toEqual(["date"]);
  });

  it("does not check what names no date or time: weekdays, tomorrow, evening", () => {
    expect(checkReply("Tomorrow evening or Saturday morning, whichever suits you?", []).ok).toBe(true);
  });

  it("reports every kind of problem at once", () => {
    expect(checkReply("₹1 on 1 Jan at 1 pm", []).problems).toEqual(["amount", "date", "time"]);
  });
});

describe("checkReply: the cap and the questions", () => {
  it("fails a reply over 600 characters, counting characters and not code units", () => {
    expect(checkReply("a".repeat(REPLY_MAX_CHARS), []).ok).toBe(true);
    expect(checkReply("a".repeat(REPLY_MAX_CHARS + 1), []).problems).toEqual(["length"]);
    expect(checkReply("😀".repeat(REPLY_MAX_CHARS), []).ok).toBe(true); // 1200 code units, 600 characters
    expect(checkReply("வ".repeat(REPLY_MAX_CHARS + 1), []).problems).toEqual(["length"]);
  });

  it("fails a reply with more than two questions", () => {
    expect(checkReply("Budget? Area? Timeline?", []).problems).toEqual(["questions"]);
    expect(checkReply("Budget? Area?", []).ok).toBe(true);
  });

  it("fails an empty reply", () => {
    expect(checkReply("", []).problems).toEqual(["empty"]);
    expect(checkReply("   \n", []).problems).toEqual(["empty"]);
  });
});

// Found by a live run of chats 203 and 207 (fix/agent-live-findings-2): a number right after a month name is a day, UNLESS it starts a time
// ("Oct 10:00", "Oct 5:30 pm", "Oct 10 am"). Before the fix "12 Oct 5:30 pm" was read as 12/10 AND 5/10 and the offer of times was replaced by the safe line.
describe("datesIn: a number after a month that starts a time is not a day", () => {
  const days = (text: string) => datesIn(text).map((d) => `${d.day}/${d.month}`);

  it.each([
    ["12 Oct 5:30 pm", ["12/10"]],
    ["Sunday 11 Oct 10 am", ["11/10"]],
    ["Sun 11 Oct 10:00 am", ["11/10"]],
    ["Sun 11 Oct 3 pm", ["11/10"]],
    ["Sun 11 Oct 3pm", ["11/10"]],
    ["Sun 11 Oct 10 a.m.", ["11/10"]],
    ["Oct 5:30", []],
    ["Oct 10:00 am", []],
    ["Oct 10 am", []],
    ["Oct 3pm", []],
  ])("%s", (text, expected) => {
    expect(days(text)).toEqual(expected);
  });

  it("a number after a month is still a day otherwise", () => {
    expect(days("Oct 11")).toEqual(["11/10"]);
    expect(days("Oct 11 at 10 am")).toEqual(["11/10"]);
    expect(days("Oct 11 10 am")).toEqual(["11/10"]);
    expect(days("Oct 14 10:00 am")).toEqual(["14/10"]);
    expect(days("October 12th, 2026")).toEqual(["12/10"]);
    expect(days("Oct 12, 5:30 pm")).toEqual(["12/10"]);
  });
});

describe("checkReply: the offer of times, with the exact facts of the live run", () => {
  const facts = ["Free times: Sun 11 Oct, 10:00 am; Sun 11 Oct, 3:00 pm; Mon 12 Oct, 5:30 pm."];

  it.each([
    // The four reply drafts the live probe printed (chats 203 and 207, two attempts each). Every one was refused for a date that is not in the text.
    ["203, attempt 1", "Super, 2BHK Medavakkam pathi pesalam! Site visit ku Sunday 11 Oct morning 10 am, illa Sunday 3 pm, illa Monday 12 Oct 5:30 pm free-a irukku. Edhu ungalukku suit aagum? Budget and 3 months timeline pathi team kitta sollitu varen, avanga detail-a help pannuvanga."],
    ["203, attempt 2", "Hi! 2BHK Medavakkam pathi pesalam. Sunday 11 Oct 10 am, illa Sunday 3 pm, illa Monday 12 Oct 5:30 pm free-a irukku. Edhu ungalukku suit aagum? Budget and 3 months timeline pathi team kitta check pannitu solren."],
    ["207, attempt 1", "Congrats on the loan approval sir! Medavakkam la 2BHK visit book pannalaam. Sunday 11 Oct morning 10 am, illa Sunday 3 pm, illa Monday 12 Oct 5:30 pm free-a irukku. Edhu ungalukku suit aagum?"],
    ["207, attempt 2", "Congrats sir, loan approve aanadhukku vaazhthukkal! Medavakkam la 2BHK visit book pannalaam. Sunday 11 Oct 10:00 am, illana Sunday 11 Oct 3:00 pm, illana Monday 12 Oct 5:30 pm free-a irukku. Edhu ungalukku suit aagum?"],
    // Other natural ways to write the same three times
    ["with the commas of the label", "Super sir! Sun 11 Oct, 10:00 am, Sun 11 Oct, 3:00 pm illa Mon 12 Oct, 5:30 pm free. Edhu set aagum?"],
    ["no commas", "Sun 11 Oct 10:00 am, Sun 11 Oct 3:00 pm illa Mon 12 Oct 5:30 pm free. Edhu set aagum?"],
    ["day before month, 'at'", "Sunday (11 Oct) at 10:00 am or 3:00 pm, or Monday (12 Oct) at 5:30 pm. Which suits you?"],
    ["month before day", "Oct 11 at 10 am, Oct 11 at 3 pm or Oct 12 at 5:30 pm?"],
    ["no dates at all", "Sunday 10:00 am, Sunday 3:00 pm or Monday 5:30 pm"],
  ])("passes: %s", (_why, reply) => {
    expect(checkReply(reply, facts)).toEqual({ ok: true, problems: [] });
  });

  it.each([
    ["Oct 14 10:00 am", "Free on Oct 14 10:00 am. Which suits you?"],
    ["14 Oct 10:00 am", "Free on 14 Oct 10:00 am. Which suits you?"],
    ["Mon 13 Oct 5:30 pm", "Free on Mon 13 Oct 5:30 pm. Which suits you?"],
    ["a right day with a wrong time", "Sun 11 Oct 9:00 am is free. Which suits you?"],
  ])("still fails: %s", (_why, reply) => {
    expect(checkReply(reply, facts).ok).toBe(false);
  });

  it("a wrong date is reported as a date (and a wrong time as a time)", () => {
    expect(checkReply("Mon 13 Oct 5:30 pm", facts).problems).toContain("date");
    expect(checkReply("Sun 11 Oct 9:00 am", facts).problems).toContain("time");
  });
});
