// SAMPLE DATA in the PROPOSED lead-card shape (docs/dashboard-screen-contracts.md, `LeadCard`). It is invented for
// tests and for building the panel before Dev 1's schema exists. It is not a record of any real customer and not
// evidence that a lead-card API exists. See features/inbox/lead-card-provisional.ts for what is still undecided.

import type { ProvisionalLeadCardJson } from "@/features/inbox/lead-card-provisional";

/** A lead that has been handed over, with a booking, in the proposed shape. */
export const PROVISIONAL_CARD_HANDED_OVER: ProvisionalLeadCardJson = {
  need: "2BHK near Velachery, ready in 3 months",
  languageNote: "Writes in Tanglish; reply in Tamil script only if they do.",
  source: "WhatsApp",
  answers: ["Budget: ₹80 lakh", "Area: Velachery", "Timeline: 0-3 months"],
  score: 82,
  temperature: "hot",
  booking: "Site visit Mon 12 Oct, 10:00 am · Asha",
  trigger: "asked_human",
  sentiment: "positive",
  summary: "Wants a 2BHK in Velachery within three months and has a loan approved. Asked to speak to someone about the payment plan.",
  nextStep: "Call back today about the payment plan, before the site visit.",
  owner: "Meera",
};

/** A new lead with only some of the optional text, nothing booked and nobody assigned. */
export const PROVISIONAL_CARD_SPARSE: ProvisionalLeadCardJson = {
  need: "Looking for a 1BHK",
  languageNote: "",
  source: "",
  answers: [],
  score: 0,
  temperature: "cold",
  booking: null,
  trigger: null,
  sentiment: "neutral",
  summary: "",
  nextStep: "Ask for a budget and an area.",
  owner: null,
};

/** The same sample with text that must never be treated as markup. */
export const PROVISIONAL_CARD_HOSTILE_TEXT: ProvisionalLeadCardJson = {
  ...PROVISIONAL_CARD_HANDED_OVER,
  need: `<script>alert("x")</script> 2BHK`,
  summary: `<img src=x onerror=alert(1)> line one\n\nline two`,
  nextStep: "javascript:alert(1)",
};
