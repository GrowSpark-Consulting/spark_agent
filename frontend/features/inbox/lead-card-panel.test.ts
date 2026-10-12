import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LEAD_CARD_HANDED_OVER, LEAD_CARD_HOSTILE_TEXT, LEAD_CARD_UNSCORED } from "@/fixtures/inbox/lead-card-response";
import type { Lead } from "@/features/leads/data";
import type { ConversationSummary } from "./data";
import { handoffReason } from "./data";
import { toLeadCardAi, type LeadCardAiState } from "./lead-card-api";
import type { LeadCard } from "./lead-card-data";
import { LeadCardPanel, type LeadCardState } from "./lead-card-panel";

// The lead card panel: the stored lead (score, stage, answers, booking) plus the AI-written rows from the lead-card route
// (lead-card-api.ts), read apart from it. Rendered to static markup (react-dom/server): words, structure and links, not
// browser layout (Playwright covers that).

const CONV_A = "c1000000-0000-4000-8000-00000000000a";
const CONV_B = "c2000000-0000-4000-8000-00000000000b";
const LEAD_ID = "d0000000-0000-4000-8000-000000000001";

const conversation = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: CONV_A,
  contactId: "e0000000-0000-4000-8000-000000000001",
  name: "Karthik R",
  firstName: "Karthik",
  initials: "KR",
  phoneMasked: "+91 98xxx xxx21",
  phoneDigits: "919812345621",
  language: "Tanglish",
  mode: "ai",
  status: "open",
  openHandoffs: [],
  lastMessage: null,
  lastCustomerMsgAt: null,
  createdAt: "2026-10-10T10:00:00.000Z",
  ...over,
});

const lead = (over: Partial<Lead> = {}): Lead => ({
  id: LEAD_ID, contactId: "e0000000-0000-4000-8000-000000000001", name: "Karthik R", hasName: true, phoneMasked: "+91 98xxx xxx21",
  stage: "qualified", score: 82, temperature: "hot", answers: {}, ownerUserId: null,
  createdAt: "2026-10-10T10:00:00.000Z", updatedAt: "2026-10-11T10:00:00.000Z", ...over,
});

const card = (over: Partial<LeadCard> = {}): LeadCard => ({
  lead: lead(),
  stage: "Qualified",
  answers: [
    { key: "area", label: "Preferred area", value: "Velachery", required: true, inPack: true },
    { key: "budget", label: "Budget", value: null, required: true, inPack: true },
  ],
  booking: { id: "b1", title: "Site visit with Asha", when: "Mon 12 Oct, 10:00 am", status: "confirmed", statusLabel: "Confirmed" },
  ...over,
});

const LOADING: LeadCardAiState = { status: "loading" };
const aiReady = (json: unknown, conversationId = CONV_A): LeadCardAiState => {
  const ai = toLeadCardAi(json, conversationId);
  if (!ai) throw new Error("fixture is not a lead card");
  return { status: "ready", ai };
};

const render = (state: LeadCardState, ai: LeadCardAiState = LOADING, conv: ConversationSummary = conversation()) =>
  renderToStaticMarkup(createElement(LeadCardPanel, { state, ai, conversation: conv, onRetry: () => {} }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
const aiRows = (html: string) => [...html.matchAll(/data-testid="lead-card-ai-row"[^>]*><dt[^>]*>([^<]*)<\/dt><dd[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]);
const ready = (c: LeadCard | null = card()): LeadCardState => ({ status: "ready", card: c });

describe("the stored lead", () => {
  it("shows score, name, stage, answers and booking", () => {
    const words = text(render(ready()));
    expect(words).toContain("Karthik R");
    expect(words).toMatch(/Hot 82|82 Hot/);
    expect(words).toContain("Qualified");
    expect(words).toContain("Preferred area: Velachery");
    expect(words).toContain("Budget: Not answered yet");
    expect(words).toContain("Site visit with Asha");
    expect(words).toContain("Mon 12 Oct, 10:00 am · Confirmed");
  });

  it("says there is no lead, no booking and no answers instead of leaving gaps", () => {
    expect(text(render(ready(null)))).toContain("isn’t on the Leads board");
    const words = text(render(ready(card({ booking: null, answers: [], lead: lead({ score: null, temperature: null }) }))));
    expect(words).toContain("No booking yet");
    expect(words).toContain("No answers collected yet.");
    expect(words).toContain("Not scored yet");
  });

  it("shows the handover from the database's handoffs, with the reason in words", () => {
    const html = render(ready(), LOADING, conversation({ openHandoffs: [{ id: "h1", trigger: "asked_human" }] }));
    expect(text(html)).toContain(`Handed over ${handoffReason("asked_human")}`);
    expect(text(render(ready()))).not.toContain("Handed over");
  });

  it("shows loading and error states, with a retry only on the error", () => {
    expect(text(render({ status: "loading" }))).toContain("Loading the lead");
    const error = render({ status: "error", error: { code: "network", title: "You're offline", message: "We couldn't reach Spark Agent.", retryable: true } });
    expect(text(error)).toContain("We couldn't reach Spark Agent.");
    expect(error).toMatch(/Try again/);
  });
});

describe("the AI part of the card", () => {
  it("adds the AI rows in a fixed order, only the ones the answer holds", () => {
    const html = render(ready(), aiReady(LEAD_CARD_HANDED_OVER));
    expect(aiRows(html).map(([name]) => name)).toEqual(["Need", "Summary", "Suggested next step", "Discount request", "Sentiment", "Language", "Source", "Suggested reply"]);
    expect(aiRows(html).find(([name]) => name === "Discount request")?.[1]).toBe("Asked for ₹70 lakh instead of ₹78 lakh");
    expect(aiRows(html).find(([name]) => name === "Suggested reply")?.[1]).toMatch(/^Thanks for waiting/);
    expect(text(html)).toContain("Summary written by the AI from this chat.");
  });

  it("shows the hot and high-priority flags only when the answer says so", () => {
    const flags = (html: string) => html.match(/data-testid="lead-card-flags"[^>]*>([^<]*)</)?.[1] ?? null;
    expect(flags(render(ready(), aiReady(LEAD_CARD_HANDED_OVER)))).toBe("Hot lead · High priority");
    expect(flags(render(ready(), aiReady({ ...LEAD_CARD_HANDED_OVER, isHot: false })))).toBe("High priority");
    expect(flags(render(ready(), aiReady({ ...LEAD_CARD_HANDED_OVER, isHot: false, priority: "normal" })))).toBeNull();
    expect(flags(render(ready(), aiReady(LEAD_CARD_UNSCORED)))).toBeNull();
    expect(flags(render(ready(), LOADING))).toBeNull();
  });

  it("renders an unscored lead (score: null) without a number, and leaves out what the answer doesn't hold", () => {
    const html = render(ready(card({ lead: lead({ score: null, temperature: null }) })), aiReady(LEAD_CARD_UNSCORED));
    expect(text(html)).toContain("Not scored yet");
    const names = aiRows(html).map(([name]) => name);
    expect(names).toEqual(["Need", "Summary", "Suggested next step", "Sentiment", "Language", "Source"]);
    expect(names).not.toContain("Discount request");
    expect(names).not.toContain("Suggested reply");
    expect(names).not.toContain("Owner");
    expect(html).not.toMatch(/<dd[^>]*>\s*<\/dd>/);
  });

  it("says when the summary was put together without the AI", () => {
    const words = text(render(ready(), aiReady(LEAD_CARD_UNSCORED)));
    expect(words).toContain("The AI couldn’t write the summary this time");
    expect(words).not.toContain("Summary written by the AI");
  });

  it("keeps the booking and handover rows from the database, once each, and never draws the answer's own", () => {
    const html = render(ready(), aiReady(LEAD_CARD_HANDED_OVER), conversation({ openHandoffs: [{ id: "h1", trigger: "negotiation" }] }));
    expect(text(html).match(/Site visit with Asha/g)).toHaveLength(1);
    expect(text(html).match(/Handed over/g)).toHaveLength(1);
    expect(text(html)).not.toContain("Site visit, Mon 12 Oct, 10:00 am · Asha");
    expect(text(html)).not.toContain("Budget: ₹80 lakh");
    // The stored score is the one shown, whatever the answer carries.
    expect(text(render(ready(card({ lead: lead({ score: 40, temperature: "warm" }) })), aiReady(LEAD_CARD_HANDED_OVER)))).not.toMatch(/82/);
  });

  it("shows a loading note while the AI part loads, and the stored lead stays", () => {
    const html = render(ready(), LOADING);
    expect(text(html)).toContain("Loading the AI summary…");
    expect(text(html)).toContain("Preferred area: Velachery");
    expect(aiRows(html)).toEqual([]);
  });

  it("shows a failure inside the card, with Try again, and the stored lead stays", () => {
    const html = render(ready(), { status: "unavailable", message: "We couldn't reach Spark Agent." });
    expect(text(html)).toContain("The AI summary isn’t available right now. We couldn't reach Spark Agent.");
    expect(html).toMatch(/<button[^>]*>Try again<\/button>/);
    expect(text(html)).toContain("Preferred area: Velachery");
    expect(aiRows(html)).toEqual([]);
  });

  it("shows nothing for a customer who isn't a lead, whatever the AI part holds", () => {
    const html = render(ready(null), aiReady(LEAD_CARD_HANDED_OVER));
    expect(aiRows(html)).toEqual([]);
    expect(text(html)).not.toContain("Velachery, ready");
  });

  it("never shows one conversation's summary beside another conversation", () => {
    const forA = aiReady(LEAD_CARD_HANDED_OVER, CONV_A);
    const forB = aiReady({ ...LEAD_CARD_HANDED_OVER, need: "Villa in OMR" }, CONV_B);
    expect(aiRows(render(ready(), forA, conversation({ id: CONV_B })))).toEqual([]);
    expect(text(render(ready(), forA, conversation({ id: CONV_B })))).not.toContain("Velachery, ready");
    expect(aiRows(render(ready(), forB, conversation({ id: CONV_B })))[0]).toEqual(["Need", "Villa in OMR"]);
    expect(text(render(ready(), forB, conversation({ id: CONV_A })))).not.toContain("Villa in OMR");
  });

  it("writes text as text, never as markup or a link", () => {
    const html = render(ready(), aiReady(LEAD_CARD_HOSTILE_TEXT));
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("javascript:alert(1)");
    expect(hrefs(html).some((h) => h.toLowerCase().startsWith("javascript:"))).toBe(false);
  });

  it("never shows the customer's full number", () => {
    const html = render(ready(), aiReady(LEAD_CARD_HANDED_OVER));
    expect(html).not.toContain("919812345621");
  });

  it("has one link, a relative one to this lead, and no button unless something failed", () => {
    const html = render(ready(), aiReady(LEAD_CARD_HANDED_OVER));
    expect(hrefs(html)).toEqual([`/dashboard/leads/${LEAD_ID}`]);
    expect(html).not.toMatch(/<button/);
  });
});
