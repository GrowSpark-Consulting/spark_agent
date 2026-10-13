// What a visitor to the shared demo number is told, and how their short answers are read (Day 6, PR 1b). Code only: no model, no business logic in a prompt.
//
// MACHINE DRAFT. The Tamil and Tanglish wording below was drafted by a model and has NOT been read by a native speaker. It must be reviewed and corrected
// by a native speaker before real visitors see it (docs/task-notes/2026-10-13-day6-dev1-demo-menu.md). The English is the reference. Until Raja's own
// wording arrives, all of it is a placeholder, like the other system messages.
//
// The menu is not written here: it is the demo businesses in the database (demo/db.ts menu()), so no business or industry is named in code.

export type Lang = "en" | "ta" | "tanglish";
export type ReplyKind = "menu" | "bad_code" | "limit" | "trial_taken";
export type MenuEntry = { code: string; label: string };

// Tamil script, or Roman letters with a word that only a Tamil speaker writes. A guess from the words, not from a model: a message that is neither is English.
const TAMIL_SCRIPT = /[஀-௿]/;
const TANGLISH_WORDS = [
  "enna", "venum", "venam", "irukku", "irukkunga", "vanakkam", "vaanga", "sollunga", "eppadi", "evlo", "evvalavu", "illa", "illai", "nandri", "seri", "romba",
  "panna", "pannunga", "anuppunga", "theriyuma", "kidaikkum", "ponga",
];
const TANGLISH = new RegExp(`\\b(?:${TANGLISH_WORDS.join("|")})\\b`, "i");

export function detectLanguage(text: string | undefined): Lang {
  if (!text) return "en";
  if (TAMIL_SCRIPT.test(text)) return "ta";
  return TANGLISH.test(text) ? "tanglish" : "en";
}

/** The longest message that can be a pick from the menu: a number, or one entry's own words. */
export const PICK_MAX_CHARS = 40;

const words = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The entry a short answer picks: its number in the list (1 is the first), or its label, or its code without the prefix. Anything else, a sentence
 * included, picks nothing. Only for a visitor with no route: with one, a bare number is an answer to the assistant (route.ts).
 */
export function menuChoice(text: string | undefined, entries: readonly MenuEntry[]): MenuEntry | null {
  if (text === undefined || entries.length === 0) return null;
  const typed = text.trim();
  if (typed === "" || typed.length > PICK_MAX_CHARS) return null;
  const number = /^0*(\d{1,2})\.?$/.exec(typed);
  if (number) return entries[Number(number[1]) - 1] ?? null;
  const said = words(typed);
  if (said === "") return null;
  // Two entries with the same words (two businesses with one pack label) make the words ambiguous: only the number picks between them.
  const matches = entries.filter((entry) => said === words(entry.label) || said === words(entry.code.replace(/^DEMO-/i, "")));
  return matches.length === 1 ? matches[0] : null;
}

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

const LIMIT = 30;

type Texts = Record<Lang, string>;

const MENU_HEAD: Texts = {
  en: "Hi! This is the Spark Agent demo. Which business would you like to try? Send its code or reply with a number:",
  ta: "வணக்கம்! இது Spark Agent டெமோ. எந்த தொழிலை முயற்சி செய்ய விரும்புகிறீர்கள்? அதன் குறியீட்டை அனுப்புங்கள் அல்லது எண்ணை அனுப்புங்கள்:",
  tanglish: "Vanakkam! Idhu Spark Agent demo. Entha business-a try panna virumbureenga? Code-a anuppunga illa number-a anuppunga:",
};
const MENU_NONE: Texts = {
  en: "Hi! This is the Spark Agent demo. Please send the demo code you were given.",
  ta: "வணக்கம்! இது Spark Agent டெமோ. உங்களுக்குக் கொடுக்கப்பட்ட டெமோ குறியீட்டை அனுப்புங்கள்.",
  tanglish: "Vanakkam! Idhu Spark Agent demo. Ungalukku kuduththa demo code-a anuppunga.",
};
const BAD_CODE_HEAD: Texts = {
  en: "Sorry, that code isn't valid or has expired. Please pick one from the list:",
  ta: "மன்னிக்கவும், அந்தக் குறியீடு செல்லாது அல்லது காலாவதியாகிவிட்டது. பட்டியலில் இருந்து தேர்ந்தெடுக்கவும்:",
  tanglish: "Sorry, antha code sari illa illa expire aayiduchu. List-la irundhu select pannunga:",
};
const BAD_CODE_NONE: Texts = {
  en: "Sorry, that code isn't valid or has expired.",
  ta: "மன்னிக்கவும், அந்தக் குறியீடு செல்லாது அல்லது காலாவதியாகிவிட்டது.",
  tanglish: "Sorry, antha code sari illa illa expire aayiduchu.",
};
const LIMIT_TEXT: Texts = {
  en: `You've reached today's limit of ${LIMIT} demo messages. Come back tomorrow, or start your free trial: `,
  ta: `இன்றைய ${LIMIT} டெமோ செய்திகளின் வரம்பை அடைந்துவிட்டீர்கள். நாளை மீண்டும் வாருங்கள், அல்லது இலவச சோதனையைத் தொடங்குங்கள்: `,
  tanglish: `Innaikku ${LIMIT} demo messages limit mudinjiduchu. Naalaikku thirumba vaanga, illa free trial start pannunga: `,
};
const TRIAL_TAKEN_TEXT: Texts = {
  en: "This number has already used a free trial, so we can't start another one. You can choose a plan here: ",
  ta: "இந்த எண் ஏற்கனவே இலவச சோதனையைப் பயன்படுத்தியுள்ளது, எனவே மற்றொன்றைத் தொடங்க முடியாது. இங்கே ஒரு திட்டத்தைத் தேர்ந்தெடுக்கலாம்: ",
  tanglish: "Indha number-la already free trial use pannitteenga, athunaala innoru trial start panna mudiyaadhu. Inga plan select pannalaam: ",
};

const list = (menu: readonly MenuEntry[]) => menu.map((entry, i) => `${i + 1}. ${oneLine(entry.label)}: ${oneLine(entry.code)}`);

/** The message for one kind of answer, in one language. `menu` is the demo businesses in order (each line: its number, its label, its code); `appUrl` is the app's root. */
export function replyText(kind: ReplyKind, lang: Lang, menu: readonly MenuEntry[], appUrl: string): string {
  const link = appUrl.replace(/\/+$/, "");
  switch (kind) {
    case "menu":
      return menu.length === 0 ? MENU_NONE[lang] : [MENU_HEAD[lang], ...list(menu)].join("\n");
    case "bad_code":
      return menu.length === 0 ? BAD_CODE_NONE[lang] : [BAD_CODE_HEAD[lang], ...list(menu)].join("\n");
    case "limit":
      return `${LIMIT_TEXT[lang]}${link}`;
    case "trial_taken":
      return `${TRIAL_TAKEN_TEXT[lang]}${link}`;
  }
}
