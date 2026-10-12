import type { Page, Route } from "@playwright/test";

// GET /api/conversations/:id/lead-card (backend/src/agent/leadcard/route.ts, card.ts), emulated in the browser with page.route.
// The real route builds the card with the model and the service-role database, neither of which the e2e API has, so it is
// stood in for here. The stand-in speaks the contract only: the path, the method, the `{ error: { code, message } }` envelope and the
// `LeadCard` fields of card.ts. Like the real API, the business comes from X-Pakka-Tenant and a chat that isn't the caller's is
// `not_found`; nothing is read from the body. The answers are SAMPLE data, not any real customer.

export type LeadCardAnswer = { status: number; body: unknown };
export type LeadCardCall = { path: string; tenant: string | null; authorization: string | null };

/** A scored lead that asked for a discount: every field the card can hold (card.ts `LeadCard`), plus the customer's full number. */
export const CARD_HANDED_OVER = {
  contact: { name: "Karthik R", phone: "+919812345621", phoneMasked: "+91 98xxx xxx21", language: "ta-en" },
  need: "2BHK near Velachery, ready in 3 months",
  languageNote: "Writes in Tanglish (Tamil in English letters)",
  source: "WhatsApp",
  answers: ["Budget: ₹80 lakh", "Area: Velachery"],
  score: 82,
  temperature: "hot",
  isHot: true,
  booking: "Consultation, Mon 12 Oct, 10:00 am · Asha",
  trigger: "negotiation",
  priority: "high",
  sentiment: "positive",
  summary: "Wants a 2BHK in Velachery within three months.\nAsked for ₹70 lakh instead of ₹78 lakh.",
  nextStep: "Decide whether any discount is possible, then reply with a clear answer.",
  suggestedReply: "Thanks for waiting! Let me check what is possible on the price and come back to you today.",
  discount: "Asked for ₹70 lakh instead of ₹78 lakh",
  owner: null,
  aiWritten: true,
};

/** A lead nobody has scored: `score` and `temperature` are null. Written by code, not the model. */
export const CARD_UNSCORED = {
  contact: { name: null, phone: "+919000000052", phoneMasked: "+91 90xxx xxx52", language: null },
  need: "Looking for a callback",
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
  summary: "Looking for a callback.\nNo budget or area yet.",
  nextStep: "Read the last messages and reply to the customer.",
  suggestedReply: null,
  discount: null,
  owner: null,
  aiWritten: false,
};

export const ok = (body: unknown): LeadCardAnswer => ({ status: 200, body });
export const failure = (status: number, code: string, message: string): LeadCardAnswer => ({ status, body: { error: { code, message } } });

export interface LeadCardApi {
  calls: LeadCardCall[];
  /** Answers one chat's card from now on. */
  set(chatId: string, answer: LeadCardAnswer | "abort"): void;
  /** Holds a chat's card until the returned function is called, to see the loading state. */
  hold(chatId: string): () => void;
}

const LEAD_CARD_PATH = /\/api\/conversations\/([0-9a-f-]{36})\/lead-card$/i;

export async function mockLeadCardApi(page: Page, answers: Record<string, LeadCardAnswer | "abort">): Promise<LeadCardApi> {
  const calls: LeadCardCall[] = [];
  const current = new Map(Object.entries(answers));
  const holds = new Map<string, Promise<void>>();

  await page.route(LEAD_CARD_PATH, async (route: Route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fallback();
    const id = new URL(req.url()).pathname.match(LEAD_CARD_PATH)![1];
    calls.push({ path: new URL(req.url()).pathname, tenant: req.headers()["x-pakka-tenant"] ?? null, authorization: req.headers()["authorization"] ?? null });
    const held = holds.get(id);
    if (held) await held;
    const answer = current.get(id) ?? failure(404, "not_found", "That conversation was not found.");
    if (answer === "abort") return route.abort("failed");
    return route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body) });
  });

  return {
    calls,
    set: (chatId, answer) => void current.set(chatId, answer),
    hold(chatId) {
      let release!: () => void;
      holds.set(chatId, new Promise<void>((r) => (release = r)));
      return () => {
        holds.delete(chatId);
        release();
      };
    },
  };
}
