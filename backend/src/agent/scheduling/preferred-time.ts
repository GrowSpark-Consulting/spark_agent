import { addDays, localParts, WEEKDAYS, weekdayOf, zonedTime, type Weekday } from "../../booking/time";

// "When does the customer want it?", read from their own words ("tomorrow evening", "Saturday 5pm", "after 6", "naalai maalai") as a
// window of real time in the BUSINESS's time zone. Plain code, no model: the extraction only copies the customer's words
// (`preferredTime`); here is where they become a day and a window, which findSlots (booking/bookings.ts) then looks in.
//
// Why the time zone is a parameter and the server's clock is never used for a day: "tomorrow" is the business's tomorrow, and a
// server in another zone (or at the date line) must give the same answer (Day 3 exit test 5).
//
// What it reads (English, Tanglish and Tamil script):
//   day    today, tomorrow, day after tomorrow, a weekday (the next one AFTER today), "this weekend" (the next Saturday), a date
//          ("12 oct", "oct 12th", "14/10", dd/mm), Tanglish naalai / inniki, Tamil நாளை / இன்று
//   part   morning 9-12, afternoon 12-5, evening 5-9 (night is the evening), also kaalai / madhiyam / maalai, காலை / மதியம் / மாலை
//   time   "5pm", "5:30 pm", "17:00", "at 5", "after 6", "6 o'clock", "tomorrow 5". With no am/pm: 1 to 8 is the afternoon or evening,
//          9 to 11 the morning, 12 noon. An exact time gives that time and two hours after it; "after 6" runs to the end of the evening.
//   no day a time or part with no day is today if it is still ahead, otherwise tomorrow.
// Anything else (a budget, "2BHK", a pincode, "whenever") is nothing, and the caller offers its own default window. It never throws.

export interface TimeWindow {
  /** The business's local date, YYYY-MM-DD. */
  date: string;
  from: Date;
  to: Date;
  /** The customer named a time, not just a day or a part of it. */
  exact: boolean;
  /** The customer named the day (a weekday, a date, tomorrow); otherwise `date` is only the likeliest one. */
  dayNamed: boolean;
}

const MAX_TEXT = 300;
const MINUTES_PER_DAY = 24 * 60;
const PARTS = { morning: [9 * 60, 12 * 60], afternoon: [12 * 60, 17 * 60], evening: [17 * 60, 21 * 60] } as const;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const UNIT_AFTER = String.raw`(?!\s*(?:lakhs?|lacs?|lac|l\b|cr\b|crores?|k\b|bhk|sq|sqft|%|\d))`;

const pad = (n: number) => String(n).padStart(2, "0");

function validDate(year: number, month: number, day: number): string | null {
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** The next occurrence of a month and day on or after `today` (this year, or the next). */
function nextDate(today: string, month: number, day: number): string | null {
  const year = Number(today.slice(0, 4));
  const thisYear = validDate(year, month, day);
  if (thisYear && thisYear >= today) return thisYear;
  return validDate(year + 1, month, day);
}

function weekdayDate(today: string, target: Weekday): string {
  const ahead = ((WEEKDAYS.indexOf(target) - WEEKDAYS.indexOf(weekdayOf(today)) + 7) % 7) || 7;
  return addDays(today, ahead);
}

/** A day, or null when none is named, or "impossible" when a date was named that does not exist ("31/02"): never guessed at. */
function findDay(text: string, today: string): string | null | "impossible" {
  if (/\bday after (?:tomorrow|tmrw|tmr)\b/.test(text)) return addDays(today, 2);
  if (/\b(?:tomorrow|tmrw|tmr|tomorow|naalai\w*|nalai\w*)\b|நாளை/u.test(text)) return addDays(today, 1);
  if (/\b(?:today|todays|inniki|innaiku|indru)\b|இன்று/u.test(text)) return today;
  if (/\bweekend\b/.test(text)) return weekdayDate(today, "sat");

  const monthFirst = new RegExp(String.raw`\b${MONTH}\s*(\d{1,2})(?:st|nd|rd|th)?\b`).exec(text);
  const dayFirst = new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s+)?${MONTH}\b`).exec(text);
  const named = dayFirst ? { day: Number(dayFirst[1]), month: dayFirst[2] } : monthFirst ? { day: Number(monthFirst[2]), month: monthFirst[1] } : null;
  if (named) return nextDate(today, MONTHS.indexOf(named.month.slice(0, 3)) + 1, named.day) ?? "impossible";

  const slash = /\b(\d{1,2})\/(\d{1,2})\b/.exec(text);
  if (slash) return nextDate(today, Number(slash[2]), Number(slash[1])) ?? "impossible";

  const weekday = /\b(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b/.exec(text);
  if (weekday) return weekdayDate(today, weekday[1].slice(0, 3) as Weekday);
  return null;
}

function findPart(text: string): keyof typeof PARTS | null {
  if (/\b(?:morning|morn|mrng|kaalai|kalai)\b|காலை/u.test(text)) return "morning";
  if (/\b(?:afternoon|noon|madhiyam|madhyanam|mathiyam)\b|மதியம்/u.test(text)) return "afternoon";
  if (/\b(?:evening|eve|night|maalai|malai|sayantaram)\b|மாலை|இரவு/u.test(text)) return "evening";
  return null;
}

/** A clock time as minutes from midnight, or null. `hour` with no am/pm follows the usual reading of a business day. */
function minutesOf(hour: number, minute: number, meridiem: string | undefined): number | null {
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    return ((hour % 12) + (meridiem === "pm" ? 12 : 0)) * 60 + minute;
  }
  if (hour < 0 || hour > 23) return null;
  if (hour === 0) return null;
  if (hour >= 13) return hour * 60 + minute; // 24-hour
  if (hour === 12) return 12 * 60 + minute;
  return (hour <= 8 ? hour + 12 : hour) * 60 + minute; // 1-8 the afternoon or evening, 9-11 the morning
}

interface Clock {
  start: number;
  after: boolean;
}

function findClock(text: string, hasDay: boolean): Clock | null {
  const after = new RegExp(String.raw`\b(?:after|post)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b${UNIT_AFTER}`).exec(text);
  if (after) {
    const start = minutesOf(Number(after[1]), Number(after[2] ?? 0), after[3]);
    return start === null ? null : { start, after: true };
  }
  const meridiem = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(text);
  if (meridiem) {
    const start = minutesOf(Number(meridiem[1]), Number(meridiem[2] ?? 0), meridiem[3]);
    if (start !== null) return { start, after: false };
  }
  const colon = /\b(\d{1,2}):(\d{2})\b/.exec(text);
  if (colon) {
    const start = minutesOf(Number(colon[1]), Number(colon[2]), undefined);
    if (start !== null) return { start, after: false };
  }
  const oclock = /\b(\d{1,2})\s*o'?\s*clock\b/.exec(text);
  if (oclock) {
    const start = minutesOf(Number(oclock[1]), 0, undefined);
    if (start !== null) return { start, after: false };
  }
  const at = new RegExp(String.raw`\b(?:at|around|by)\s+(\d{1,2})\b${UNIT_AFTER}`).exec(text);
  if (at) {
    const start = minutesOf(Number(at[1]), 0, undefined);
    if (start !== null) return { start, after: false };
  }
  // "tomorrow 5": a bare number straight after a day word, and not the start of something else ("2BHK", "80 lakh").
  if (hasDay) {
    const bare = new RegExp(String.raw`\b(?:today|tomorrow|tmrw|tmr|sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\s+(\d{1,2})\b${UNIT_AFTER}`).exec(text);
    if (bare) {
      const start = minutesOf(Number(bare[1]), 0, undefined);
      if (start !== null) return { start, after: false };
    }
  }
  return null;
}

export function parsePreferredTime(raw: string, { timeZone, now }: { timeZone: string; now: Date }): TimeWindow | null {
  const text = raw.slice(0, MAX_TEXT).toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return null;

  const today = localParts(now, timeZone).date;
  const found = findDay(text, today);
  if (found === "impossible") return null;
  const day = found;
  const part = findPart(text);
  const clock = findClock(text, day !== null);
  if (day === null && part === null && clock === null) return null;

  let range: [number, number];
  let exact = false;
  if (clock) {
    exact = !clock.after;
    range = clock.after ? [clock.start, Math.max(clock.start + 60, PARTS.evening[1])] : [clock.start, clock.start + 120];
  } else if (part) {
    range = [...PARTS[part]];
  } else {
    range = [0, MINUTES_PER_DAY];
  }

  let date = day;
  if (date === null) {
    // No day named: today if the time asked for is still ahead, otherwise tomorrow.
    const local = localParts(now, timeZone);
    const ahead = exact ? range[0] > local.minuteOfDay : range[1] > local.minuteOfDay;
    date = ahead ? today : addDays(today, 1);
  }
  return { date, from: zonedTime(date, range[0], timeZone), to: zonedTime(date, range[1], timeZone), exact, dayNamed: day !== null };
}
