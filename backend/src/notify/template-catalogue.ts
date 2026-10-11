// The WhatsApp template catalogue (9-day plan, Day 4: "versioned template catalogue … with English and Tamil entries
// ready to submit"). One entry per template our code sends outside the 24-hour window, with the wording, the example
// values Meta asks for, and quick-reply buttons. Names are versioned: a change is a new `_vN` submitted to Meta,
// never an edit. notify.send picks the newest approved `<base>_vN` for a kind (KINDS[kind].template), so `base` here
// matches it, and the variables are exactly the templateParams the jobs send (template-catalogue.test.ts checks both).
//
// The English is a placeholder until Raja's wording arrives; the Tamil is a DRAFT that needs a native speaker's review
// (`reviewed: false`) before anything is submitted. Dev 1's whatsapp/connected submission reads this through
// templateComponents().

export type TemplateLanguage = "en" | "ta";

export interface TemplateText {
  /** The body with {{1}}…{{n}} variables, which may not start or end the text (Meta's rule). */
  body: string;
  footer?: string;
  /** Quick-reply buttons, at most 25 characters each. A tap comes back as a button reply with the button's text. */
  quickReplies?: string[];
}

export interface CatalogueTemplate {
  name: string;
  /** What notify.send looks up: KINDS[kind].template. */
  base: string;
  category: "utility" | "marketing";
  /** What each variable is, in {{1}}… order. */
  variables: string[];
  /** Example values for Meta's review, one per variable. */
  examples: string[];
  text: Record<TemplateLanguage, TemplateText>;
  /** True once a native speaker has checked the Tamil. */
  reviewed: boolean;
}

const MARKETING_FOOTER: Record<TemplateLanguage, string> = {
  en: "Reply STOP to stop these messages",
  ta: "இந்த செய்திகளை நிறுத்த STOP என பதில் அனுப்பவும்",
};

const RATINGS = ["★★★★★", "★★★★", "★★★", "★★", "★"];

export const TEMPLATE_CATALOGUE: CatalogueTemplate[] = [
  {
    name: "booking_confirmed_v1",
    base: "booking_confirmed",
    category: "utility",
    variables: ["what was booked", "the business", "the local date and time"],
    examples: ["site visit", "Skyline Homes", "Sat 10 Oct, 5:00 pm"],
    text: {
      en: { body: "Your {{1}} with {{2}} is confirmed for {{3}}. Need to change it? Tap a button below.", quickReplies: ["Reschedule", "Cancel"] },
      ta: { body: "உங்கள் {{1}} {{2}} உடன் {{3}} அன்று உறுதி செய்யப்பட்டது. மாற்ற வேண்டுமா? கீழே உள்ள பொத்தானை அழுத்தவும்.", quickReplies: ["நேரம் மாற்று", "ரத்து செய்"] },
    },
    reviewed: false,
  },
  {
    name: "reminder_24h_v1",
    base: "reminder_24h",
    category: "utility",
    variables: ["what was booked", "the business", "the local date and time"],
    examples: ["site visit", "Skyline Homes", "Sat 10 Oct, 5:00 pm"],
    text: {
      en: { body: "Reminder: your {{1}} with {{2}} is on {{3}}. Tap a button below to confirm or change it.", quickReplies: ["Confirm", "Reschedule", "Cancel"] },
      ta: {
        body: "நினைவூட்டல்: உங்கள் {{1}} {{2}} உடன் {{3}} அன்று. உறுதி செய்ய அல்லது மாற்ற கீழே உள்ள பொத்தானை அழுத்தவும்.",
        quickReplies: ["உறுதி செய்", "நேரம் மாற்று", "ரத்து செய்"],
      },
    },
    reviewed: false,
  },
  {
    name: "reminder_2h_v1",
    base: "reminder_2h",
    category: "utility",
    variables: ["what was booked", "the business", "the local date and time"],
    examples: ["site visit", "Skyline Homes", "Sat 10 Oct, 5:00 pm"],
    text: {
      en: { body: "Reminder: your {{1}} with {{2}} is soon, on {{3}}. Tap a button below if anything has changed.", quickReplies: ["Confirm", "Reschedule", "Cancel"] },
      ta: {
        body: "நினைவூட்டல்: உங்கள் {{1}} {{2}} உடன் விரைவில், {{3}} அன்று. ஏதாவது மாறியிருந்தால் கீழே உள்ள பொத்தானை அழுத்தவும்.",
        quickReplies: ["உறுதி செய்", "நேரம் மாற்று", "ரத்து செய்"],
      },
    },
    reviewed: false,
  },
  {
    name: "feedback_v1",
    base: "feedback",
    category: "marketing",
    variables: ["what was booked", "the business"],
    examples: ["site visit", "Skyline Homes"],
    text: {
      en: { body: "How was your {{1}} with {{2}}? Tap a rating below, it takes a second.", footer: MARKETING_FOOTER.en, quickReplies: RATINGS },
      ta: { body: "வணக்கம்! {{2}} உடனான உங்கள் {{1}} எப்படி இருந்தது? கீழே ஒரு மதிப்பீட்டை அழுத்தவும்.", footer: MARKETING_FOOTER.ta, quickReplies: RATINGS },
    },
    reviewed: false,
  },
  {
    name: "review_v1",
    base: "review",
    category: "marketing",
    variables: ["the business", "the review link"],
    examples: ["Skyline Homes", "https://g.page/r/skyline/review"],
    text: {
      en: { body: "Thank you for choosing {{1}}! Would you leave us a quick review? {{2}} It really helps.", footer: MARKETING_FOOTER.en },
      ta: { body: "நன்றி! {{1}} பற்றி ஒரு சிறிய மதிப்புரை எழுதுவீர்களா? {{2}} இது எங்களுக்கு மிகவும் உதவும்.", footer: MARKETING_FOOTER.ta },
    },
    reviewed: false,
  },
  {
    name: "nudge_v1",
    base: "nudge",
    category: "marketing",
    variables: ["the customer's name"],
    examples: ["Asha"],
    text: {
      en: { body: "Hi {{1}}, just checking in. Do you have any other questions? Reply here and we'll help.", footer: MARKETING_FOOTER.en },
      ta: { body: "வணக்கம் {{1}}, வேறு ஏதாவது கேள்விகள் உள்ளதா? இங்கே பதில் அனுப்புங்கள், நாங்கள் உதவுகிறோம்.", footer: MARKETING_FOOTER.ta },
    },
    reviewed: false,
  },
  {
    name: "noshow_rebook_v1",
    base: "noshow_rebook",
    category: "marketing",
    variables: ["what was booked", "the business"],
    examples: ["site visit", "Skyline Homes"],
    text: {
      en: { body: "Sorry we missed you for your {{1}} with {{2}}. Would you like to pick a new time? Tap below.", footer: MARKETING_FOOTER.en, quickReplies: ["Pick a new time"] },
      ta: {
        body: "மன்னிக்கவும், {{2}} உடனான உங்கள் {{1}} நேரத்தில் உங்களை சந்திக்க முடியவில்லை. புதிய நேரம் தேர்ந்தெடுக்க விரும்புகிறீர்களா? கீழே அழுத்தவும்.",
        footer: MARKETING_FOOTER.ta,
        quickReplies: ["புதிய நேரம்"],
      },
    },
    reviewed: false,
  },
  {
    name: "staff_alert_v1",
    base: "staff_alert",
    category: "utility",
    variables: ["what happened, in one line", "the dashboard link"],
    examples: ["Asha is waiting for a person on WhatsApp.", "https://app.pakkaagent.in/dashboard/inbox"],
    text: {
      en: { body: "Alert from your assistant: {{1}} Details: {{2}} Reply here if you need help." },
      ta: { body: "உங்கள் உதவியாளரின் அறிவிப்பு: {{1}} விவரங்கள்: {{2}} உதவி தேவைப்பட்டால் இங்கே பதில் அனுப்பவும்." },
    },
    reviewed: false,
  },
  {
    name: "daily_agenda_v1",
    base: "daily_agenda",
    category: "utility",
    variables: ["how many bookings", "the first booking", "the calendar link"],
    examples: ["2 bookings", "10:00 am, Site visit with Asha (Priya)", "https://app.pakkaagent.in/dashboard/calendar"],
    text: {
      en: { body: "Good morning! Today you have {{1}}. First: {{2}}. Full calendar: {{3}} Have a good day!" },
      ta: { body: "காலை வணக்கம்! இன்று உங்களுக்கு {{1}}. முதலாவது: {{2}}. முழு அட்டவணை: {{3}} இனிய நாள்!" },
    },
    reviewed: false,
  },
];

/** The {{n}} numbers a text uses, sorted. */
export function variablesIn(body: string): number[] {
  return [...new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

/**
 * A template as Meta's create-template request wants it (the `components` array), for Dev 1's submission on
 * whatsapp/connected: the body with its examples, the footer, and the quick replies.
 */
export function templateComponents(template: CatalogueTemplate, language: TemplateLanguage): Record<string, unknown>[] {
  const text = template.text[language];
  return [
    { type: "BODY", text: text.body, ...(template.examples.length > 0 && { example: { body_text: [template.examples] } }) },
    ...(text.footer ? [{ type: "FOOTER", text: text.footer }] : []),
    ...(text.quickReplies?.length ? [{ type: "BUTTONS", buttons: text.quickReplies.map((t) => ({ type: "QUICK_REPLY", text: t })) }] : []),
  ];
}
