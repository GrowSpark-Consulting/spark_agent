import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  PROVISIONAL_CARD_HANDED_OVER,
  PROVISIONAL_CARD_HOSTILE_TEXT,
  PROVISIONAL_CARD_SPARSE,
} from "@/fixtures/inbox/provisional-lead-card";
import type { Lead } from "@/features/leads/data";
import type { ConversationSummary } from "./data";
import { handoffReason } from "./data";
import type { LeadCard } from "./lead-card-data";
import { LeadCardPanel, type LeadCardState } from "./lead-card-panel";
import { AI_TEXT_MAX, fromProvisionalLeadCard, ProvisionalLeadCardJson } from "./lead-card-provisional";

// The lead card panel before Dev 1's lead-card JSON exists. The sample is in the PROPOSED shape (provisional, see
// lead-card-provisional.ts); these tests show the panel and the adapter work against it and that swapping in the real
// contract only has to replace the adapter. They do NOT show that a lead-card API, or any AI summary, exists.
// Rendered to static markup (react-dom/server): words, structure and links, not browser layout (Playwright covers that).

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

const render = (state: LeadCardState, conv: ConversationSummary = conversation()) =>
  renderToStaticMarkup(createElement(LeadCardPanel, { state, conversation: conv, onRetry: () => {} }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
const aiRows = (html: string) => [...html.matchAll(/data-testid="lead-card-ai-row"[^>]*><dt[^>]*>([^<]*)<\/dt><dd[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]);

const ready = (ai?: ReturnType<typeof fromProvisionalLeadCard>, c: LeadCard | null = card()): LeadCardState => ({ status: "ready", card: c, ai });

describe("the provisional sample", () => {
  it("is in the proposed shape", () => {
    for (const sample of [PROVISIONAL_CARD_HANDED_OVER, PROVISIONAL_CARD_SPARSE, PROVISIONAL_CARD_HOSTILE_TEXT]) {
      expect(ProvisionalLeadCardJson.safeParse(sample).success).toBe(true);
    }
  });

  it("reads the AI-written parts for one conversation and leaves the database's parts out", () => {
    const ai = fromProvisionalLeadCard(PROVISIONAL_CARD_HANDED_OVER, CONV_A);
    expect(ai).toEqual({
      conversationId: CONV_A,
      origin: "provisional",
      need: "2BHK near Velachery, ready in 3 months",
      summary: expect.stringMatching(/^Wants a 2BHK/),
      nextStep: "Call back today about the payment plan, before the site visit.",
      sentiment: "positive",
      languageNote: expect.stringMatching(/Tanglish/),
      source: "WhatsApp",
      owner: "Meera",
    });
    // Score, temperature, answers, booking and trigger of the proposal come from the database rows, not from here.
    for (const key of ["score", "temperature", "answers", "booking", "trigger"]) expect(ai).not.toHaveProperty(key);
  });

  it("turns blank text into nothing rather than an empty row", () => {
    expect(fromProvisionalLeadCard(PROVISIONAL_CARD_SPARSE, CONV_A)).toMatchObject({
      need: "Looking for a 1BHK", nextStep: "Ask for a budget and an area.", sentiment: "neutral", summary: null, languageNote: null, source: null, owner: null,
    });
  });

  it("collapses whitespace and cuts a runaway line", () => {
    const long = "x".repeat(AI_TEXT_MAX * 3);
    const ai = fromProvisionalLeadCard({ ...PROVISIONAL_CARD_HANDED_OVER, summary: `  a \n\n b  `, nextStep: long }, CONV_A);
    expect(ai?.summary).toBe("a b");
    expect(ai?.nextStep).toHaveLength(AI_TEXT_MAX);
    expect(ai?.nextStep?.endsWith("…")).toBe(true);
  });

  it.each([
    ["a missing field", Object.fromEntries(Object.entries(PROVISIONAL_CARD_HANDED_OVER).filter(([key]) => key !== "summary"))],
    ["a number where text belongs", { ...PROVISIONAL_CARD_HANDED_OVER, need: 4 }],
    ["null for the whole card", null],
    ["a string", "not json"],
    ["an empty object", {}],
  ])("shows nothing, not half a card, for %s", (_name, json) => {
    expect(fromProvisionalLeadCard(json, CONV_A)).toBeNull();
  });

  it("shows nothing when there is no AI text at all, or no conversation to attach it to", () => {
    const empty = { ...PROVISIONAL_CARD_SPARSE, need: "", nextStep: "", sentiment: " " };
    expect(fromProvisionalLeadCard(empty, CONV_A)).toBeNull();
    expect(fromProvisionalLeadCard(PROVISIONAL_CARD_HANDED_OVER, " ")).toBeNull();
  });
});

describe("the panel today (nothing supplies AI text)", () => {
  it("shows the stored lead: score, name, stage, answers, booking and the honest note", () => {
    const html = render(ready());
    const words = text(html);
    expect(words).toContain("Karthik R");
    expect(words).toMatch(/Hot 82|82 Hot/);
    expect(words).toContain("Qualified");
    expect(words).toContain("Preferred area: Velachery");
    expect(words).toContain("Budget: Not answered yet");
    expect(words).toContain("Site visit with Asha");
    expect(words).toContain("Mon 12 Oct, 10:00 am · Confirmed");
    expect(words).toContain("AI summaries of the chat aren’t available yet.");
    expect(aiRows(html)).toEqual([]);
  });

  it("says there is no lead, no booking and no answers instead of leaving gaps", () => {
    expect(text(render(ready(undefined, null)))).toContain("isn’t on the Leads board");
    const words = text(render(ready(undefined, card({ booking: null, answers: [], lead: lead({ score: null, temperature: null }) }))));
    expect(words).toContain("No booking yet");
    expect(words).toContain("No answers collected yet.");
    expect(words).toContain("Not scored yet");
  });

  it("shows the handover from the database's handoffs, with the reason in words", () => {
    const html = render(ready(), conversation({ openHandoffs: [{ id: "h1", trigger: "asked_human" }] }));
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

describe("the panel with the provisional sample", () => {
  const ai = fromProvisionalLeadCard(PROVISIONAL_CARD_HANDED_OVER, CONV_A);

  it("adds the AI rows, in a fixed order, and says they are a sample", () => {
    const html = render(ready(ai));
    expect(aiRows(html).map(([name]) => name)).toEqual(["Need", "Summary", "Suggested next step", "Sentiment", "Language", "Source", "Owner"]);
    expect(aiRows(html).find(([name]) => name === "Suggested next step")?.[1]).toBe("Call back today about the payment plan, before the site visit.");
    expect(text(html)).toContain("Sample summary in a provisional format");
    expect(text(html)).not.toContain("AI summaries of the chat aren’t available yet.");
  });

  it("keeps the booking and handover rows from the database, once each", () => {
    const html = render(ready(ai), conversation({ openHandoffs: [{ id: "h1", trigger: "asked_human" }] }));
    expect(text(html).match(/Site visit with Asha/g)).toHaveLength(1);
    expect(text(html).match(/Handed over/g)).toHaveLength(1);
    // The sample's own booking and trigger strings are not drawn: the card must not disagree with the database.
    expect(text(html)).not.toContain("Site visit Mon 12 Oct, 10:00 am · Asha");
  });

  it("shows only the rows that have text when the sample is sparse", () => {
    const sparse = fromProvisionalLeadCard(PROVISIONAL_CARD_SPARSE, CONV_A);
    const html = render(ready(sparse, card({ booking: null, answers: [] })));
    expect(aiRows(html).map(([name]) => name)).toEqual(["Need", "Suggested next step", "Sentiment"]);
    expect(html).not.toMatch(/<dd[^>]*>\s*<\/dd>/);
  });

  it("never shows one conversation's summary beside another conversation", () => {
    const forA = fromProvisionalLeadCard(PROVISIONAL_CARD_HANDED_OVER, CONV_A);
    const forB = fromProvisionalLeadCard({ ...PROVISIONAL_CARD_HANDED_OVER, need: "Villa in OMR" }, CONV_B);
    // A's summary handed to the panel for B is not shown; B's own is.
    expect(aiRows(render(ready(forA), conversation({ id: CONV_B })))).toEqual([]);
    expect(text(render(ready(forA), conversation({ id: CONV_B })))).not.toContain("Velachery, ready");
    expect(aiRows(render(ready(forB), conversation({ id: CONV_B })))[0]).toEqual(["Need", "Villa in OMR"]);
    expect(text(render(ready(forB), conversation({ id: CONV_A })))).not.toContain("Villa in OMR");
  });

  it("writes text as text, never as markup or a link", () => {
    const hostile = fromProvisionalLeadCard(PROVISIONAL_CARD_HOSTILE_TEXT, CONV_A);
    const html = render(ready(hostile));
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("javascript:alert(1)");
    expect(hrefs(html).some((h) => h.toLowerCase().startsWith("javascript:"))).toBe(false);
  });

  it("has one link, a relative one to this lead, and nothing else to click", () => {
    const html = render(ready(ai));
    expect(hrefs(html)).toEqual([`/dashboard/leads/${LEAD_ID}`]);
    expect(html).not.toMatch(/<button/);
  });
});
