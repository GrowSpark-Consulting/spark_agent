import { textLanguage, type TextLanguage } from "../pipeline/fixed-texts";

// The two things the customer sees when a staff member takes their chat to their own WhatsApp number (Raja, 11 Oct, question 3: the customer sees the
// staff member's first name and number, so a message from an unknown number does not look like spam). Wording is a draft in four languages, for Raja
// and a native speaker to check. Placeholders are filled by `fill`, which puts text in and never interprets it.

export interface Handler {
  /** The staff member's name as the customer should read it (a first name or a short name). */
  name: string;
  business: string;
  /** The staff member's WhatsApp number, E.164, as saved. */
  phone: string;
}

const NOTICE: Record<TextLanguage, string> = {
  en: "{name} from {business} will message you from {phone} shortly.",
  ta: "{business} நிறுவனத்தின் {name} விரைவில் {phone} எண்ணிலிருந்து உங்களுக்குச் செய்தி அனுப்புவார்.",
  "ta-en": "{business}-ilirundhu {name} seekkiram {phone} number-la irundhu ungalukku message pannuvanga.",
  hi: "{business} से {name} जल्द ही {phone} से आपको संदेश भेजेंगे।",
};

/** What staff's own WhatsApp opens with, ready to send. `customer` is the customer's first name, if known. */
const GREETING: Record<TextLanguage, { withName: string; plain: string }> = {
  en: { withName: "Hi {customer}, this is {name} from {business}. How can I help you?", plain: "Hi, this is {name} from {business}. How can I help you?" },
  ta: { withName: "வணக்கம் {customer}, நான் {business} நிறுவனத்தின் {name}. உங்களுக்கு எப்படி உதவலாம்?", plain: "வணக்கம், நான் {business} நிறுவனத்தின் {name}. உங்களுக்கு எப்படி உதவலாம்?" },
  "ta-en": { withName: "Vanakkam {customer}, naan {business}-la irundhu {name}. Ungalukku eppadi help pannalam?", plain: "Vanakkam, naan {business}-la irundhu {name}. Ungalukku eppadi help pannalam?" },
  hi: { withName: "नमस्ते {customer}, मैं {business} से {name} बोल रहा हूँ। मैं आपकी कैसे मदद कर सकता हूँ?", plain: "नमस्ते, मैं {business} से {name} बोल रहा हूँ। मैं आपकी कैसे मदद कर सकता हूँ?" },
};

/** Replaces each {placeholder} once, with the text as it is: a value that itself contains a {placeholder} is not filled again. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (Object.hasOwn(values, key) ? values[key] : whole));
}

export function ownNumberNotice(language: string | null, who: Handler): string {
  return fill(NOTICE[textLanguage(language)], { name: who.name, business: who.business, phone: who.phone });
}

export function ownNumberGreeting(language: string | null, who: Pick<Handler, "name" | "business">, customerName: string | null): string {
  const first = customerName?.trim().split(/\s+/)[0] ?? "";
  const template = GREETING[textLanguage(language)];
  return fill(first ? template.withName : template.plain, { name: who.name, business: who.business, customer: first });
}

const EXTERNAL: Record<TextLanguage, string> = {
  en: "{name} is looking after your chat and will reply to you shortly.",
  ta: "{name} உங்கள் உரையாடலைப் பார்த்துக்கொள்கிறார், விரைவில் உங்களுக்குப் பதிலளிப்பார்.",
  "ta-en": "{name} ungal chat-a paathukkitu irukkanga, seekkiram reply pannuvanga.",
  hi: "{name} आपकी चैट देख रहे हैं और जल्द ही आपको जवाब देंगे।",
};

/** What a customer reads when they write again while a staff member handles the chat from their own number (Raja, 11 Oct, question 4). */
export function externalNotice(language: string | null, name: string): string {
  return fill(EXTERNAL[textLanguage(language)], { name });
}
