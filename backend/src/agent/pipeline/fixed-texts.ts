import type { Extraction } from "@pakka/types";

// The lines the assistant sends without asking the model: when it has nothing safe to say, when it did not understand,
// when a person takes over, and the hint about STOP. Fixed words, so they cannot be wrong about a price, cannot
// be steered by a customer, and cost no model call. One per language the assistant writes in: English, Tamil
// (script), Tamil in English letters (Tanglish) and Hindi. Any other language gets English.
//
// The wording is Dev 1's (docs/task-notes, "Decisions"); Raja is welcome to change it, and a change is only an edit here.

export type FixedTextKey = "fallback" | "clarify" | "handoff" | "handoff_sorry" | "stop_hint" | "credits_holding" | "consent_notice" | "opt_out_confirmation" | "exit_question" | "exit_prompt";
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
