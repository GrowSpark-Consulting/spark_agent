import { describe, expect, it } from "vitest";
import { matchSlotChoice, type OfferedTime } from "./slot-choice";

const IST = "Asia/Kolkata";
// Sat 10 Oct 2026, 10:00 in Chennai.
const NOW = new Date("2026-10-10T04:30:00.000Z");
const ist = (date: string, hour: number, minute = 0) => new Date(Date.parse(`${date}T00:00:00.000Z`) + (hour * 60 + minute) * 60_000 - 330 * 60_000).toISOString();

// What was offered: Sunday 10:00 am, Sunday 3:00 pm, Monday 5:30 pm.
const offered: OfferedTime[] = [{ start: ist("2026-10-11", 10) }, { start: ist("2026-10-11", 15) }, { start: ist("2026-10-12", 17, 30) }];
const pick = (text: string, list = offered) => matchSlotChoice(text, list, { timeZone: IST, now: NOW });
const chosen = (index: number) => ({ kind: "chosen", index });

describe("which one, by its place in the offer", () => {
  it.each([
    ["the first one", 0],
    ["first", 0],
    ["1st", 0],
    ["option 1", 0],
    ["the second one", 1],
    ["2nd please", 1],
    ["number two", 1],
    ["the third", 2],
    ["#3", 2],
    ["the last one", 2],
    ["last", 2],
    ["ok the first one works", 0],
  ])("%s", (text, index) => {
    expect(pick(text)).toEqual(chosen(index));
  });

  it("Tanglish and Tamil", () => {
    expect(pick("mudhal onnu")).toEqual(chosen(0));
    expect(pick("rendavathu")).toEqual(chosen(1));
    expect(pick("moonravathu")).toEqual(chosen(2));
    expect(pick("kadaisi")).toEqual(chosen(2));
    expect(pick("இரண்டாவது")).toEqual(chosen(1));
  });

  it("a place that is not in the offer is not a choice", () => {
    expect(pick("the fourth one")).toEqual({ kind: "unclear" });
    expect(pick("option 7")).toEqual({ kind: "unclear" });
  });
});

describe("which one, by its time", () => {
  it.each([
    ["10 am", 0],
    ["10am please", 0],
    ["3pm", 1],
    ["15:00", 1],
    ["5:30 pm", 2],
    ["at 5", 2], // 5 pm, and the 5:30 pm one is within half an hour
    ["around 10", 0],
    ["the 3 pm one", 1],
  ])("%s", (text, index) => {
    expect(pick(text)).toEqual(chosen(index));
  });

  it("a time that is not offered is a different time", () => {
    expect(pick("4 pm")).toEqual({ kind: "other" });
    expect(pick("11 am")).toEqual({ kind: "other" });
  });

  it("a time with a day picks that day's one", () => {
    expect(pick("monday 5:30 pm")).toEqual(chosen(2));
    expect(pick("sunday 3pm")).toEqual(chosen(1));
    expect(pick("monday 10 am")).toEqual({ kind: "other" });
  });
});

describe("which one, by its day or part of the day", () => {
  it.each([
    ["monday", 2],
    ["the morning one", 0],
    ["morning", 0],
    ["afternoon", 1],
    ["evening", 2],
    ["sunday morning", 0],
    ["naalai kaalai", 0], // tomorrow, Sunday, morning
  ])("%s", (text, index) => {
    expect(pick(text)).toEqual(chosen(index));
  });

  it("a day with two times is not enough to choose", () => {
    expect(pick("sunday")).toEqual({ kind: "unclear" });
  });

  it("a day or part with nothing offered is a different time", () => {
    expect(pick("saturday")).toEqual({ kind: "other" });
    expect(pick("tomorrow evening")).toEqual({ kind: "other" });
  });
});

describe("a bare number is a time or a place, never a guess", () => {
  it("is the place when no time fits it", () => {
    expect(pick("1")).toEqual(chosen(0));
    expect(pick("2")).toEqual(chosen(1));
  });
  it("is the time when it is not a place", () => {
    expect(pick("5")).toEqual(chosen(2));
    expect(pick("10")).toEqual(chosen(0));
  });
  it("is not a choice when the time and the place disagree", () => {
    expect(pick("3")).toEqual({ kind: "unclear" }); // 3 pm is the second, the third place is Monday
  });
});

describe("no preference, or the extremes", () => {
  it.each([
    ["any is fine", 0],
    ["whichever works", 0],
    ["you pick", 0],
    ["any time works", 0],
    ["the earliest", 0],
    ["first available", 0],
    ["the latest one", 2],
    ["the later one", 2],
  ])("%s", (text, index) => {
    expect(pick(text)).toEqual(chosen(index));
  });
});

describe("a plain yes", () => {
  it("is a choice only when one time was offered", () => {
    expect(pick("ok", [offered[1]])).toEqual(chosen(0));
    expect(pick("yes please", [offered[1]])).toEqual(chosen(0));
    expect(pick("ok")).toEqual({ kind: "unclear" });
    expect(pick("yes")).toEqual({ kind: "unclear" });
  });

  it.each([["yes that works"], ["ok that works for me"], ["sounds good"], ["perfect, thanks"], ["yes, please go ahead"], ["great"], ["seri"], ["aama"], ["👍"], ["Yes!"]])("%s says yes to the one time offered", (text) => {
    expect(pick(text, [offered[1]])).toEqual(chosen(0));
    expect(pick(text)).toEqual({ kind: "unclear" }); // with three on offer, a yes does not say which
  });

  it("a yes with something else in it is not a plain yes", () => {
    expect(pick("yes but what is the address", [offered[1]])).toEqual({ kind: "unclear" });
    expect(pick("ok let me ask my wife first", [offered[1]])).toEqual({ kind: "unclear" });
  });
});

describe("none of them", () => {
  it.each([["none of these"], ["no"], ["nope"], ["not available"], ["can't make any of these"], ["another day please"], ["something else"], ["different time"], ["illa"], ["can we reschedule"]])("%s", (text) => {
    expect(pick(text)).toEqual({ kind: "other" });
  });

  it("a no that is not about the times is not read as one", () => {
    expect(pick("no problem, 10 am")).toEqual(chosen(0));
  });
});

describe("nothing to go on", () => {
  it.each([[""], ["   "], ["?"], ["what is the price?"], ["2BHK in Velachery"], ["hello"]])("%j is unclear", (text) => {
    expect(pick(text)).toEqual({ kind: "unclear" });
  });

  it("with nothing offered nothing can be chosen", () => {
    expect(pick("the first one", [])).toEqual({ kind: "unclear" });
  });

  it("never throws on odd text", () => {
    for (const text of ["😀", "a".repeat(5000), "0", "99", "-1", "1e9", "\u0000"]) expect(() => pick(text)).not.toThrow();
  });
});

// Spoken picks (fix/agent-chat-findings): how people really type "the first / second / third one" in Tamil, Tanglish and Hindi.
describe("spoken ordinals in Tamil script", () => {
  it.each([
    ["ஒண்ணாவது", 0],
    ["ஒன்னாவது", 0],
    ["ஒன்றாவது", 0],
    ["முதல்ல உள்ளது", 0],
    ["முதல்", 0],
    ["ரெண்டாவது", 1],
    ["ரெண்டாவதுதான்", 1],
    ["ரெண்டாவது ஓகே", 1],
    ["இரண்டாவது", 1],
    ["மூணாவது", 2],
    ["மூனாவது", 2],
    ["மூணாவது சரி", 2],
    ["மூன்றாவது", 2],
  ])("%s", (text, index) => {
    expect(pick(text)).toEqual(chosen(index));
  });
});

describe("spoken ordinals in Tanglish", () => {
  it.each([
    ["onnavathu", 0],
    ["onnavadhu", 0],
    ["mudhal onnu", 0],
    ["rendavathu", 1],
    ["rendavadhu", 1],
    ["rendavatu", 1],
    ["randavathu", 1],
    ["rendavathu ok", 1],
    ["moonavathu", 2],
    ["moonavadhu", 2],
    ["moonavatu", 2],
    ["the frist one", 0],
    ["the fisrt one", 0],
    ["the secnd one", 1],
    ["the secound one", 1],
    ["the seccond one", 1],
    ["the thrid one", 2],
    ["the thired one", 2],
  ])("%s", (text, index) => {
    expect(pick(text)).toEqual(chosen(index));
  });
});

describe("spoken ordinals in Hindi", () => {
  it.each([
    ["पहला", 0],
    ["पहला वाला", 0],
    ["पहली वाली", 0],
    ["दूसरा", 1],
    ["दूसरा वाला", 1],
    ["दूसरा वाला बुक कर दो", 1],
    ["दूसरा वाला चलेगा", 1],
    ["दूसरा वाला ठीक है", 1],
    ["हाँ दूसरा वही", 1],
    ["जी दूसरा वाला", 1],
    ["तीसरा", 2],
    ["तीसरा वाला", 2],
    ["2nd वाला", 1],
    ["pehla", 0],
    ["pehla wala", 0],
    ["pahla wala", 0],
    ["doosra", 1],
    ["dusra", 1],
    ["doosra wala", 1],
    ["doosra wala chalega", 1],
    ["doosra wala theek hai", 1],
    ["haan doosra wahi", 1],
    ["ji doosra wala book kar do", 1],
    ["doosra wala kar do", 1],
    ["teesra", 2],
    ["tisra wala", 2],
  ])("%s", (text, index) => {
    expect(pick(text)).toEqual(chosen(index));
  });
});

describe("things that must NOT be read as a pick", () => {
  it.each([
    // "second" as a unit of time, and other words that contain an ordinal
    ["wait a second"],
    ["give me a second"],
    ["10 seconds"],
    ["hold on a second, let me check"],
    ["12nd"],
    // times and counts that are not ordinals
    ["ரெண்டு மணி"],
    ["மூணு மணிக்கு"],
    ["ஒண்ணு"],
    ["rendu mani"],
    // "other" is not "second" in Hindi
    ["दूसरा दिन चलेगा"],
    ["दूसरा टाइम दिखाओ"],
    ["doosra din chalega"],
    ["doosra time dikhao"],
    ["teesra din"],
    ["pehle se bataya hai"],
  ])("%s", (text) => {
    expect(pick(text).kind).not.toBe("chosen");
  });

  it.each([
    // a question is never a pick, even with a pick word in it
    ["दूसरा वाला कितने का है?"],
    ["दूसरा वाला कितने का है"],
    ["doosra wala kitne ka hai"],
    ["doosra wala kitne ka hai?"],
    ["ரெண்டாவது எவ்ளோ?"],
    ["ரெண்டாவது எவ்ளோ"],
    ["மூணாவது எங்க இருக்கு?"],
    ["rendavathu evlo?"],
    ["rendavathu enna time?"],
  ])("%s is a question, so it is asked again, not booked", (text) => {
    expect(pick(text)).toEqual({ kind: "unclear" });
  });
});

// A "?" alone does not make a message a question: only a question word does. A yes/no check on the pick still books.
describe("a pick with a yes/no question mark still books; a real question does not", () => {
  it.each([
    ["ரெண்டாவது ஓகே வா?", 1],
    ["rendavadhu ok ah?", 1],
    ["second one please?", 1],
    ["दूसरा वाला ठीक रहेगा क्या?", 1],
    ["doosra wala chalega kya?", 1],
    ["doosra wala chalega kya", 1],
  ])("%s books", (text, index) => {
    expect(pick(text)).toEqual(chosen(index));
  });

  it.each([["ரெண்டாவது எவ்ளோ?"], ["doosra wala kitne ka hai"], ["what is the second one"], ["दूसरा वाला क्या है"], ["doosra wala kya hai?"], ["दूसरा वाला क्या कीमत है"]])("%s is a question and books nothing", (text) => {
    expect(pick(text).kind).not.toBe("chosen");
  });
});
