import { localParts } from "../../booking/time";
import { parsePreferredTime } from "./preferred-time";

// Which of the times we offered did the customer pick? Read from their own words, in plain code. The times are offered as ordinary
// sentences (no list, no buttons: the chat should read like a person), so the customer answers the way people do: "the second one",
// "3pm", "Monday", "evening is better", "any is fine", "none of these". The model plays no part in this decision.
//
// The result is one of:
//   chosen   exactly one of the offered times, by its index
//   other    the customer wants something that was not offered: none of them, another day, a time we did not give
//   unclear  nothing that points at one time (or at more than one): the assistant asks again, kindly
//
// Never a guess: a message that fits two times, or a bare number that is both a place ("3rd") and a time (3 pm) and they differ, is
// `unclear`. A time is matched within half an hour, so "5" picks the 5:30 pm one when nothing else is near.

export interface OfferedTime {
  /** ISO 8601 UTC start of the offered time. */
  start: string;
}

export type SlotPick = { kind: "chosen"; index: number } | { kind: "other" } | { kind: "unclear" };

const MAX_TEXT = 300;
const NEAR_MIN = 30;
// An English ordinal counts as a place only where a customer names one ("the first", "option 2", "I will take the third", or the message starts with it):
// "let me ask my wife first" uses the same word for something else, and must not pick a time.
const LEAD = String.raw`(?:^|\b(?:the|option|number|slot|choice|take|pick|choose|go with|with|ok|okay|yes|yeah|please|prefer)\s+)`;
const place = (words: string) => new RegExp(LEAD + String.raw`(?:${words})\b`);
// A Hindi pick counts only when the message is nothing but the pick and small filler words ("दूसरा वाला बुक कर दो", "doosra wala chalega"):
// दूसरा / doosra also means "other" ("दूसरा दिन" is another day), so it is never read inside a longer message. क्या / kya is allowed only as the LAST
// word ("दूसरा वाला ठीक रहेगा क्या?" is a yes/no check on the pick); "दूसरा वाला क्या है" asks something, so it is not a pick.
const GAP = String.raw`[^\p{L}\p{M}\p{N}]`;
const HINDI_FILLER = [
  "वाला", "वाली", "वाले", "ही", "वही", "वो", "वह", "ये", "यह", "ठीक", "सही", "है", "हैं", "चलेगा", "चलेगी", "रहेगा", "चाहिए", "मुझे", "हाँ", "हां", "जी", "ओके", "प्लीज", "बुक", "कर दो", "कर दीजिए", "कर दें", "करो", "लो", "लीजिए",
  "wala", "wali", "wale", "hi", "wahi", "vahi", "woh", "vo", "ye", "yeh", "theek", "thik", "sahi", "hai", "hain", "chalega", "chalegi", "rahega", "chahiye", "mujhe", "haan", "han", "ha", "ji", "ok", "okay", "please", "plz", "book", "kar do", "kardo", "karo", "kar dijiye", "le lo", "lo", "leejiye",
].join("|");
const hindiPick = (words: string) => String.raw`^${GAP}*(?:(?:${HINDI_FILLER})${GAP}+)*(?:${words})(?:${GAP}+(?:${HINDI_FILLER}))*(?:${GAP}+(?:क्या|kya))?${GAP}*$`;
const ORDINALS: [RegExp, number][] = [
  [new RegExp(place("first|1st|frist|fisrt|firts").source + "|" + String.raw`\b(?:mudhal\w*|muthal\w*)\b|\bonn?a+va(?:th|dh|t|d)\w*\b|முதல்|ஒண்ணாவ|ஒன்னாவ|ஒன்றாவ|` + hindiPick("पहला|पहली|पहले|pehla|pehli|pehle|pahla|pahli|pahle"), "u"), 1],
  [new RegExp(place("second|2nd|secnd|secound|seccond|sencond").source + "|" + String.raw`\b(?:rend\w*vath\w*|rend\w*vadh\w*|irand\w*vath\w*|irand\w*vadh\w*)\b|\br[ae]nd\w*va(?:th|dh|t|d)\w*\b|இரண்டாவது|ரெண்டாவ|` + hindiPick("दूसरा|दूसरी|दूसरे|doosra|doosri|doosre|dusra|dusri|dusre"), "u"), 2],
  [new RegExp(place("third|3rd|thrid|thired").source + "|" + String.raw`\b(?:moon\w*vath\w*|moon\w*vadh\w*|moondr\w*)\b|\bmoon\w*va(?:th|dh|t|d)\w*\b|மூன்றாவது|மூணாவ|மூனாவ|` + hindiPick("तीसरा|तीसरी|तीसरे|teesra|teesri|teesre|tisra|tisri|tisre"), "u"), 3],
  [place("fourth|4th"), 4],
  [place("fifth|5th"), 5],
];
// A message that asks something ("ரெண்டாவது எவ்ளோ?", "दूसरा वाला कितने का है") is never a pick: the question is answered first. Whole words only, so a Tamil
// word that merely starts like one ("என்னால" is not "என்ன") does not count.
const QUESTION_WORDS = [
  "how much", "how many", "what", "why", "price",
  "evlo", "evvalavu", "ethana", "ethanai", "enna", "yen", "eppo", "epdi", "enga", "yaaru", "edhu", "ethu",
  "kitna", "kitne", "kitni", "kaun", "kaunsa", "kab", "kahan", "kyun", "kaise", "kaisa",
  "எவ்ளோ", "எவ்வளவு", "எத்தனை", "என்ன", "ஏன்", "எப்போ", "எப்ப", "எப்பொழுது", "எங்க", "எங்கே", "எப்படி", "யார்", "எது",
  "कितना", "कितने", "कितनी", "कौन", "कौनसा", "कब", "कहाँ", "कहां", "क्यों", "कैसे", "कैसा",
].join("|");
const QUESTION = new RegExp(String.raw`(?<![\p{L}\p{M}])(?:${QUESTION_WORDS})(?![\p{L}\p{M}])`, "u");
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };

const NEGATIVE =
  /\b(?:none|neither|nothing works?|not (?:free|available|possible|suitable|convenient|good)|can'?t|cannot|won'?t work|busy|another (?:day|time|slot)|different (?:day|time|slot)|other (?:day|time|slot)|something else|someone else|re-?schedule|later date|next week)\b/;
const NEGATIVE_WHOLE = /^\W*(?:no|nope|nahi|illa|illai|venam)\W*$/;
const ANY = /\b(?:any(?: one| time| slot)?(?: is| will be| would be| works?| should)?(?: fine| ok| okay| good| works?)?|whichever(?: works| is fine| one)?|you pick|your choice|up to you|no preference)\W*$/;
const EARLIEST = /\b(?:earliest|first available|soonest|as early as possible|asap)\b/;
const LATEST = /\b(?:latest|later one|the later|last one|last|kadaisi|kadasi)\b|கடைசி/u;
// A plain yes: nothing but agreeing words ("yes that works", "ok sounds good", "perfect, thanks"), so a yes with a question in it is not one.
const AGREE = String.raw`(?:ok(?:ay)?|yes|yeah|yep|yup|sure|fine|done|confirm(?:ed)?|sounds good|works(?: for me| fine)?|that works(?: for me| fine)?|that is fine|that's fine|perfect|great|good|nice|please|thanks|thank you|go ahead|seri|sari|aama|aam|haan|han|ஆமா|ஆம்|சரி|👍)`;
const YES = new RegExp(String.raw`^\W*(?:${AGREE}\W*)+$`, "u");

const chosen = (index: number): SlotPick => ({ kind: "chosen", index });
const UNCLEAR: SlotPick = { kind: "unclear" };
const OTHER: SlotPick = { kind: "other" };

/** The place a customer names in words ("the second one", "option 2", "#3"), 1-based, or null. */
function namedPlace(text: string): number | null {
  if (QUESTION.test(text)) return null;
  for (const [pattern, place] of ORDINALS) if (pattern.test(text)) return place;
  const numbered = /\b(?:option|number|no\.?|slot|choice)\s*(\d{1,2}|one|two|three|four|five)\b|#\s*(\d{1,2})\b/.exec(text);
  if (numbered) {
    const raw = numbered[1] ?? numbered[2];
    return /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
  }
  return null;
}

/** A bare hour in a business day: 1 to 8 is the afternoon or evening, 9 to 11 the morning, 12 noon, 13 to 23 as written. */
function bareHourMinutes(hour: number): number | null {
  if (!Number.isInteger(hour) || hour < 1 || hour > 23) return null;
  if (hour >= 12) return hour * 60;
  return (hour <= 8 ? hour + 12 : hour) * 60;
}

export function matchSlotChoice(raw: string, offered: readonly OfferedTime[], context: { timeZone: string; now: Date }): SlotPick {
  const count = offered.length;
  if (count === 0) return UNCLEAR;
  const text = raw.slice(0, MAX_TEXT).toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
  if (!text) return UNCLEAR;

  const { timeZone, now } = context;
  const local = offered.map((o) => {
    const start = new Date(o.start);
    return { start: start.getTime(), ...localParts(start, timeZone) };
  });
  const byPlace = (place: number): SlotPick => (place >= 1 && place <= count ? chosen(place - 1) : UNCLEAR);

  if (NEGATIVE.test(text) || NEGATIVE_WHOLE.test(text)) return OTHER;
  if (EARLIEST.test(text)) return chosen(0);

  const place = namedPlace(text);
  if (place !== null) return byPlace(place);

  // A time, a day, a part of the day: "3pm", "monday", "sunday morning", "evening".
  const when = parsePreferredTime(text, { timeZone, now });
  if (when) {
    const fromMinute = localParts(when.from, timeZone).minuteOfDay;
    const toMinute = fromMinute + Math.round((when.to.getTime() - when.from.getTime()) / 60_000);
    const candidates = local
      .map((slot, index) => ({ slot, index }))
      .filter(({ slot }) => {
        if (when.dayNamed) {
          if (!when.exact) return slot.start >= when.from.getTime() && slot.start < when.to.getTime();
          return slot.date === when.date && Math.abs(slot.minuteOfDay - fromMinute) <= NEAR_MIN;
        }
        return when.exact ? Math.abs(slot.minuteOfDay - fromMinute) <= NEAR_MIN : slot.minuteOfDay >= fromMinute && slot.minuteOfDay < toMinute;
      });
    if (candidates.length === 0) return OTHER;
    if (candidates.length === 1) return chosen(candidates[0].index);
    if (when.exact) {
      const distance = (c: (typeof candidates)[number]) => Math.abs(c.slot.minuteOfDay - fromMinute);
      const best = Math.min(...candidates.map(distance));
      const closest = candidates.filter((c) => distance(c) === best);
      if (closest.length === 1) return chosen(closest[0].index);
    }
    return UNCLEAR;
  }

  // A bare number: a time ("5" is 5 pm) or a place ("2" is the second), and when they are different times it is neither.
  const bare = /^\W*(\d{1,2})\W*$/.exec(text);
  if (bare) {
    const value = Number(bare[1]);
    const minutes = bareHourMinutes(value);
    const byTime = minutes === null ? [] : local.map((slot, index) => ({ slot, index })).filter(({ slot }) => Math.abs(slot.minuteOfDay - minutes) <= NEAR_MIN);
    const byPlaceIndex = value >= 1 && value <= count ? value - 1 : null;
    if (byTime.length === 1 && (byPlaceIndex === null || byPlaceIndex === byTime[0].index)) return chosen(byTime[0].index);
    if (byTime.length === 0 && byPlaceIndex !== null) return chosen(byPlaceIndex);
    return UNCLEAR;
  }

  if (LATEST.test(text)) return chosen(count - 1);
  if (ANY.test(text)) return chosen(0);
  if (YES.test(text)) return count === 1 ? chosen(0) : UNCLEAR;
  return UNCLEAR;
}
