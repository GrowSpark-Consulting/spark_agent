import type { Extraction } from "@pakka/types";

// The lines the assistant sends without asking the model: when it has nothing safe to say, when it did not understand,
// when a person takes over, and the hint about STOP. Fixed words, so they cannot be wrong about a price, cannot
// be steered by a customer, and cost no model call. One per language the assistant writes in: English, Tamil
// (script), Tamil in English letters (Tanglish) and Hindi. Any other language gets English.
//
// The wording is Dev 1's (docs/task-notes, "Decisions"); Raja is welcome to change it, and a change is only an edit here.

export type FixedTextKey = "fallback" | "clarify" | "handoff" | "handoff_sorry" | "voice_note" | "stop_hint" | "credits_holding" | "consent_notice" | "opt_out_confirmation" | "exit_question" | "exit_prompt" | "area_options" | "area_unavailable";
export type TextLanguage = "en" | "ta" | "ta-en" | "hi";

/** The safe line when a reply cannot be trusted (docs/handover.md, post-check): exactly these words in English. */
export const SAFE_FALLBACK_EN = "Let me confirm that with the team";

export const FIXED_TEXTS: Record<FixedTextKey, Record<TextLanguage, string>> = {
  fallback: {
    en: SAFE_FALLBACK_EN,
    ta: "இதை எங்கள் குழுவிடம் உறுதிசெய்து சொல்கிறேன்",
    "ta-en": "Idha engal team kitta confirm panni solren",
    hi: "इसे हमारी टीम से कन्फ़र्म करके बताया जाएगा",
  },
  clarify: {
    en: "Sorry, I couldn't quite understand that. Could you tell me a bit more?",
    ta: "மன்னிக்கவும், எனக்குப் புரியவில்லை. சற்று விளக்கமாகச் சொல்ல முடியுமா?",
    "ta-en": "Sorry, enakku sariya puriyala. Konjam vilakkama sollunga?",
    hi: "माफ़ कीजिए, बात समझ नहीं आई। क्या आप थोड़ा और बताएँगे?",
  },
  handoff: {
    en: "Thanks for your patience. A team member will take over and get in touch with you shortly.",
    ta: "பொறுமைக்கு நன்றி. எங்கள் குழு உறுப்பினர் விரைவில் உங்களைத் தொடர்பு கொள்வார்.",
    "ta-en": "Patience-ku nandri. Engal team member seekkiram ungalai contact pannuvanga.",
    hi: "आपके धैर्य के लिए धन्यवाद। हमारी टीम का कोई सदस्य जल्द ही आपसे संपर्क करेगा।",
  },
  // A voice note (Raja, 11 Oct, question 1): said once, asking the customer to type. Draft wording: Raja and a native speaker to check.
  voice_note: {
    en: "Sorry, I can't listen to voice notes yet. Could you please type your message?",
    ta: "மன்னிக்கவும், என்னால் இன்னும் குரல் செய்திகளைக் கேட்க முடியாது. உங்கள் செய்தியை தட்டச்சு செய்ய முடியுமா?",
    "ta-en": "Sorry, ennala innum voice note ketka mudiyala. Ungal message-a type panna mudiyuma?",
    hi: "माफ़ कीजिए, मैं अभी वॉइस नोट नहीं सुन सकता। क्या आप अपना संदेश टाइप कर सकते हैं?",
  },
  // An angry customer or a complaint (Raja, 11 Oct): one short sorry, then the handover. Draft wording: Raja and a native speaker to check.
  handoff_sorry: {
    en: "I'm sorry about this. A team member will take over right now and get in touch with you shortly.",
    ta: "இதற்காக மன்னிக்கவும். எங்கள் குழு உறுப்பினர் இப்போதே பொறுப்பேற்று விரைவில் உங்களைத் தொடர்பு கொள்வார்.",
    "ta-en": "Idhukku sorry. Engal team member ippove paathukkittu seekkiram ungalai contact pannuvanga.",
    hi: "इसके लिए मुझे खेद है। हमारी टीम का कोई सदस्य अभी इसे संभालेगा और जल्द ही आपसे संपर्क करेगा।",
  },
  // Sent free, when the business has run out of credits and a person must take over (through the system-notice port).
  credits_holding: {
    en: "We can't reply automatically right now. A team member will get back to you soon.",
    ta: "இப்போது தானாகப் பதில் அளிக்க முடியவில்லை. எங்கள் குழு உறுப்பினர் விரைவில் உங்களைத் தொடர்புகொள்வார்.",
    "ta-en": "Ippo automatic-a reply panna mudiyala. Engal team member seekkiram ungalai contact pannuvanga.",
    hi: "अभी हम अपने-आप जवाब नहीं दे पा रहे हैं। हमारी टीम का कोई सदस्य जल्द ही आपसे संपर्क करेगा।",
  },
  // One line at the end of a contact's first AI reply (DPDP): who answers, where the privacy policy is, how to stop.
  // `{url}` is the policy link (PRIVACY_POLICY_URL), last in the line so nothing sticks to it when it is made a link.
  consent_notice: {
    en: "This chat is answered by an AI assistant. Reply STOP to opt out. Privacy policy: {url}",
    ta: "இந்த உரையாடலுக்கு AI உதவியாளர் பதிலளிக்கிறது. நிறுத்த STOP என்று அனுப்புங்கள். தனியுரிமைக் கொள்கை: {url}",
    "ta-en": "Indha chat-ku AI assistant bathil solluthu. Nirutha STOP nu reply pannunga. Privacy policy: {url}",
    hi: "इस चैट का जवाब AI असिस्टेंट देता है। बंद करने के लिए STOP लिखें। गोपनीयता नीति: {url}",
  },
  // A customer asks about an area the business has no sites in (Raja, 14 Oct). First, the areas it does have, so they can choose; only
  // when they name the same area again, that there is nothing there for now and that they will be told when that changes (no visit is
  // offered for it, and staff are reminded to record it in the CRM). `{area}` is the customer's own place, `{areas}` the business's
  // (areaText fills them). MACHINE DRAFTS in Tamil, Tanglish and Hindi: Raja and a native speaker must check them before they are final.
  area_options: {
    en: "We don't have sites in {area} right now. We do have sites in {areas}. Would any of these suit you?",
    ta: "{area} பகுதியில் தற்போது எங்களிடம் இடங்கள் இல்லை. {areas} பகுதிகளில் உள்ளன. இவற்றில் ஏதாவது உங்களுக்குப் பொருந்துமா?",
    "ta-en": "{area}-la ippo engalidam site illa. {areas}-la irukku. Idhula edhavadhu ungalukku set aagumaa?",
    hi: "फ़िलहाल {area} में हमारी कोई साइट नहीं है। हमारी साइटें {areas} में हैं। क्या इनमें से कोई आपके लिए ठीक रहेगा?",
  },
  area_unavailable: {
    en: "Sorry, we don't have any property in {area} for now. We'll update you when that changes.",
    ta: "மன்னிக்கவும், {area} பகுதியில் தற்போது எங்களிடம் சொத்துகள் இல்லை. மாற்றம் இருந்தால் உங்களுக்குத் தெரிவிப்போம்.",
    "ta-en": "Sorry, {area}-la ippo engalidam property illa. Maaruna ungalukku update pannuvom.",
    hi: "माफ़ कीजिए, फ़िलहाल {area} में हमारे पास कोई प्रॉपर्टी नहीं है। कुछ बदलने पर हम आपको बताएँगे।",
  },
  // The one last message after STOP (through the system-notice port).
  opt_out_confirmation: {
    en: "You've been opted out and won't get any more messages from us. Thank you.",
    ta: "நீங்கள் விலகிவிட்டீர்கள். இனி எங்களிடமிருந்து செய்திகள் வராது. நன்றி.",
    "ta-en": "Neenga vilagitteenga. Inime engalidam irundhu messages varaadhu. Nandri.",
    hi: "आपको सूची से हटा दिया गया है। अब हमारी ओर से कोई संदेश नहीं आएगा। धन्यवाद।",
  },
  // Asked once when the customer may be leaving but it is not clear how (Raja, 9 Oct). Sent as TWO REPLY BUTTONS [Talk to the
  // team] [Continue] (exitQuestionButtons below): the text of the message is `exit_prompt`, a short line with the STOP hint.
  // There is never a STOP button: STOP stays something the customer types. `exit_question` is the plain-text version, used only
  // if the buttons are refused: the same, with "Reply 1 to talk to the team, or just continue".
  exit_prompt: {
    en: "Sorry if we've bothered you. If you'd like us to stop messaging you, just reply STOP.",
    ta: "தொந்தரவு செய்திருந்தால் மன்னிக்கவும். செய்திகள் வேண்டாம் என்றால் STOP என்று அனுப்புங்கள்.",
    "ta-en": "Disturb pannirundha sorry. Messages vendam na STOP nu reply pannunga.",
    hi: "अगर हमने परेशान किया हो तो माफ़ कीजिए। संदेश बंद करने के लिए STOP लिखकर भेजें।",
  },
  exit_question: {
    en: "Sorry if we've bothered you. Reply 1 to talk to the team, or just continue. If you'd like us to stop messaging you, just reply STOP.",
    ta: "தொந்தரவு செய்திருந்தால் மன்னிக்கவும். எங்கள் குழுவிடம் பேச 1 என்று அனுப்புங்கள், அல்லது தொடருங்கள். செய்திகள் வேண்டாம் என்றால் STOP என்று அனுப்புங்கள்.",
    "ta-en": "Disturb pannirundha sorry. Engal team kitta pesa 1 nu reply pannunga, illana appadiye continue pannunga. Messages vendam na STOP nu reply pannunga.",
    hi: "अगर हमने परेशान किया हो तो माफ़ कीजिए। टीम से बात करने के लिए 1 लिखें, या यूँ ही जारी रखें। संदेश बंद करने के लिए STOP लिखकर भेजें।",
  },
  stop_hint: {
    en: "If you'd like to stop receiving messages, reply STOP.",
    ta: "செய்திகள் வேண்டாம் என்றால் STOP என்று அனுப்புங்கள்.",
    "ta-en": "Messages vendam na STOP nu reply pannunga.",
    hi: "संदेश बंद करने के लिए STOP लिखकर भेजें।",
  },
};

/** The ids of the exit question's two buttons: a tap comes back as an inbound message with this `meta.buttonId`. */
export const EXIT_BUTTON_IDS = { talk: "exit:talk", continue: "exit:continue" } as const;

// WhatsApp allows 20 characters in a button title.
const EXIT_BUTTON_TITLES: Record<"talk" | "continue", Record<TextLanguage, string>> = {
  talk: { en: "Talk to the team", ta: "குழுவிடம் பேச", "ta-en": "Team kitta pesa", hi: "टीम से बात करें" },
  continue: { en: "Continue", ta: "தொடருங்கள்", "ta-en": "Continue pannunga", hi: "जारी रखें" },
};

/** The exit question as reply buttons: the text (with the STOP hint) and exactly two buttons, never a STOP button. */
export function exitQuestionButtons(language: TextLanguage): { body: string; buttons: [{ id: string; title: string }, { id: string; title: string }] } {
  return {
    body: FIXED_TEXTS.exit_prompt[language],
    buttons: [
      { id: EXIT_BUTTON_IDS.talk, title: EXIT_BUTTON_TITLES.talk[language] },
      { id: EXIT_BUTTON_IDS.continue, title: EXIT_BUTTON_TITLES.continue[language] },
    ],
  };
}

/** The language to write a fixed line in: this message's language, else the contact's, else English. */
export function textLanguage(...candidates: (Extraction["language"] | string | null | undefined)[]): TextLanguage {
  for (const candidate of candidates) {
    if (candidate === "en" || candidate === "ta" || candidate === "ta-en" || candidate === "hi") return candidate;
  }
  return "en";
}

export function fixedText(key: FixedTextKey, language: TextLanguage): string {
  return FIXED_TEXTS[key][language];
}

/** The privacy notice with its link. The link is ours (env, https): it is put in as text, never interpreted. */
export function consentNotice(language: TextLanguage, privacyPolicyUrl: string): string {
  return FIXED_TEXTS.consent_notice[language].split("{url}").join(privacyPolicyUrl);
}

/** What a line about an area is filled in with: the customer's own place, and the places the business has. */
export interface AreaWords {
  area: string;
  areas: string[];
}

/** An area line with the customer's place and the business's places put in, in one pass (what is put in is never read as a place to fill). */
export function areaText(key: "area_options" | "area_unavailable", language: TextLanguage, words: AreaWords): string {
  const values: Record<string, string> = { area: words.area, areas: words.areas.join(", ") };
  return FIXED_TEXTS[key][language].replace(/\{(areas?)\}/g, (_match, name: string) => values[name]);
}
