// SAMPLE DATA in the shape GET /api/conversations/:id/lead-card answers with (backend/src/agent/leadcard/card.ts, `LeadCard`).
// Invented for tests; not a record of any real customer. The keys are those of the contract, including `contact.phone`
// (the customer's full number), which the frontend drops on parsing.

import type { LeadCardResponse } from "@/features/inbox/lead-card-api";

type Wire = LeadCardResponse & { contact: LeadCardResponse["contact"] & { phone: string } };

/** A scored lead that asked for a person: every field the card can hold. */
export const LEAD_CARD_HANDED_OVER: Wire = {
  contact: { name: "Karthik R", phone: "+919812345621", phoneMasked: "+91 98xxx xxx21", language: "ta-en" },
  need: "2BHK near Velachery, ready in 3 months",
  languageNote: "Writes in Tanglish (Tamil in English letters)",
  source: "WhatsApp",
  answers: ["Budget: ₹80 lakh", "Area: Velachery", "Timeline: 0-3 months"],
  score: 82,
  temperature: "hot",
  isHot: true,
  booking: "Site visit, Mon 12 Oct, 10:00 am · Asha",
  trigger: "negotiation",
  priority: "high",
  sentiment: "positive",
  summary: "Wants a 2BHK in Velachery within three months and has a loan approved.\nAsked for ₹70 lakh instead of ₹78 lakh.",
  nextStep: "Decide whether any discount is possible, then reply with a clear answer.",
  suggestedReply: "Thanks for waiting! Let me check what is possible on the price and come back to you today.",
  discount: "Asked for ₹70 lakh instead of ₹78 lakh",
  owner: null,
  aiWritten: true,
};

/** A new lead nobody has scored: `score` and `temperature` are null, not zero and not "cold". Written by code, not the model. */
export const LEAD_CARD_UNSCORED: Wire = {
  contact: { name: null, phone: "+919000000052", phoneMasked: "+91 90xxx xxx52", language: null },
  need: "Looking for a 1BHK",
  languageNote: "Language not known yet",
  source: "WhatsApp",
  answers: [],
  score: null,
  temperature: null,
  isHot: false,
  booking: null,
  trigger: null,
  priority: null,
  sentiment: "neutral",
  summary: "Looking for a 1BHK.\nNo budget or area yet.",
  nextStep: "Read the last messages and reply to the customer.",
  suggestedReply: null,
  discount: null,
  owner: null,
  aiWritten: false,
};

/** Text that must never be treated as markup. */
export const LEAD_CARD_HOSTILE_TEXT: Wire = {
  ...LEAD_CARD_HANDED_OVER,
  need: `<script>alert("x")</script> 2BHK`,
  summary: `<img src=x onerror=alert(1)> line one\n\nline two`,
  nextStep: "javascript:alert(1)",
};
