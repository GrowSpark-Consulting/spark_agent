import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";
import { LEAD_CARD_HANDED_OVER, LEAD_CARD_HOSTILE_TEXT, LEAD_CARD_UNSCORED } from "@/fixtures/inbox/lead-card-response";

const getJson = vi.fn();
vi.mock("@/lib/api/client", () => ({ getJson: (...args: unknown[]) => getJson(...args) }));

const { AI_TEXT_MAX, fetchLeadCardAi, LeadCardDataError, LeadCardResponse, toLeadCardAi, unavailableAi } = await import("./lead-card-api");

const CONV = "40000000-0000-0000-0000-000000000001";
const TENANT = "10000000-0000-0000-0000-000000000004";

// A block body: a beforeEach that returns the mock would have vitest call it again as a cleanup.
beforeEach(() => {
  getJson.mockReset();
});

describe("the lead-card contract (backend/src/agent/leadcard/card.ts)", () => {
  it("accepts a scored card and an unscored one", () => {
    expect(LeadCardResponse.safeParse(LEAD_CARD_HANDED_OVER).success).toBe(true);
    expect(LeadCardResponse.safeParse(LEAD_CARD_UNSCORED).success).toBe(true);
  });

  it("keeps the contract's field names, and drops the customer's full number", () => {
    const parsed = LeadCardResponse.parse(LEAD_CARD_HANDED_OVER);
    expect(Object.keys(parsed).sort()).toEqual(
      ["answers", "aiWritten", "booking", "contact", "discount", "isHot", "languageNote", "need", "nextStep", "owner", "priority", "score", "sentiment", "source", "suggestedReply", "summary", "temperature", "trigger"].sort(),
    );
    expect(parsed.contact).toEqual({ name: "Karthik R", phoneMasked: "+91 98xxx xxx21", language: "ta-en" });
    expect(JSON.stringify(parsed)).not.toContain("919812345621");
  });

  it("takes null for score, temperature, priority, booking, trigger, owner, discount and the suggested reply", () => {
    const parsed = LeadCardResponse.parse(LEAD_CARD_UNSCORED);
    expect(parsed).toMatchObject({ score: null, temperature: null, priority: null, booking: null, trigger: null, owner: null, discount: null, suggestedReply: null });
  });

  it.each([
    ["a string score", { score: "82" }],
    ["a temperature outside the four", { temperature: "lukewarm" }],
    ["a sentiment outside the four", { sentiment: "ecstatic" }],
    ["a priority outside high and normal", { priority: "urgent" }],
    ["a missing summary", { summary: undefined }],
    ["isHot as text", { isHot: "yes" }],
    ["aiWritten missing", { aiWritten: undefined }],
    ["answers that are not text", { answers: [1, 2] }],
  ])("rejects %s", (_name, change) => {
    expect(LeadCardResponse.safeParse({ ...LEAD_CARD_HANDED_OVER, ...change }).success).toBe(false);
  });
});

describe("toLeadCardAi", () => {
  it("reads the AI-written parts and the flags for one conversation, and leaves the database's parts out", () => {
    const ai = toLeadCardAi(LEAD_CARD_HANDED_OVER, CONV);
    expect(ai).toEqual({
      conversationId: CONV,
      need: "2BHK near Velachery, ready in 3 months",
      summary: "Wants a 2BHK in Velachery within three months and has a loan approved.\nAsked for ₹70 lakh instead of ₹78 lakh.",
      nextStep: "Decide whether any discount is possible, then reply with a clear answer.",
      sentiment: "Positive",
      languageNote: "Writes in Tanglish (Tamil in English letters)",
      source: "WhatsApp",
      owner: null,
      priority: "high",
      isHot: true,
      discount: "Asked for ₹70 lakh instead of ₹78 lakh",
      suggestedReply: "Thanks for waiting! Let me check what is possible on the price and come back to you today.",
      aiWritten: true,
    });
    // Score, temperature, answers, booking and trigger come from the database rows, and the full number never gets this far.
    for (const key of ["score", "temperature", "answers", "booking", "trigger", "contact", "phone"]) expect(ai).not.toHaveProperty(key);
  });

  it("handles score: null without failing or inventing a number", () => {
    const ai = toLeadCardAi(LEAD_CARD_UNSCORED, CONV);
    expect(ai).not.toBeNull();
    expect(ai).toMatchObject({ isHot: false, priority: null, discount: null, suggestedReply: null, aiWritten: false });
    expect(JSON.stringify(ai)).not.toMatch(/"score"/);
  });

  it("turns blank text into nothing rather than an empty row", () => {
    const ai = toLeadCardAi({ ...LEAD_CARD_HANDED_OVER, need: "  ", languageNote: "", source: "\n", discount: " ", suggestedReply: "" }, CONV);
    expect(ai).toMatchObject({ need: null, languageNote: null, source: null, discount: null, suggestedReply: null });
  });

  it("keeps line breaks, drops blank lines and extra spaces, and cuts a runaway line", () => {
    const ai = toLeadCardAi({ ...LEAD_CARD_HANDED_OVER, summary: "  a   b \r\n\r\n c  ", nextStep: "x".repeat(AI_TEXT_MAX * 3) }, CONV);
    expect(ai?.summary).toBe("a b\nc");
    expect(ai?.nextStep).toHaveLength(AI_TEXT_MAX);
    expect(ai?.nextStep?.endsWith("…")).toBe(true);
  });

  it("labels the sentiment in words", () => {
    for (const [value, label] of [["positive", "Positive"], ["neutral", "Neutral"], ["negative", "Negative"], ["angry", "Angry"]] as const) {
      expect(toLeadCardAi({ ...LEAD_CARD_HANDED_OVER, sentiment: value }, CONV)?.sentiment).toBe(label);
    }
  });

  it.each([
    ["a missing field", Object.fromEntries(Object.entries(LEAD_CARD_HANDED_OVER).filter(([key]) => key !== "summary"))],
    ["a number where text belongs", { ...LEAD_CARD_HANDED_OVER, need: 4 }],
    ["null for the whole card", null],
    ["a string", "not json"],
    ["an array", []],
    ["an empty object", {}],
  ])("shows nothing, not half a card, for %s", (_name, json) => {
    expect(toLeadCardAi(json, CONV)).toBeNull();
  });

  it("shows nothing when there is no conversation to attach it to", () => {
    expect(toLeadCardAi(LEAD_CARD_HANDED_OVER, " ")).toBeNull();
  });

  it("keeps hostile text as plain text for the page to escape", () => {
    expect(toLeadCardAi(LEAD_CARD_HOSTILE_TEXT, CONV)?.need).toBe(`<script>alert("x")</script> 2BHK`);
  });
});

describe("fetchLeadCardAi", () => {
  it("GETs this conversation's card for this business, and reads it", async () => {
    getJson.mockResolvedValue(LEAD_CARD_HANDED_OVER);
    const ai = await fetchLeadCardAi(TENANT, CONV);
    expect(getJson).toHaveBeenCalledWith(`/api/conversations/${CONV}/lead-card`, { tenantId: TENANT, signal: undefined });
    expect(ai.conversationId).toBe(CONV);
    expect(ai.isHot).toBe(true);
  });

  it("encodes the id, so a hostile one can't change the path", async () => {
    getJson.mockResolvedValue(LEAD_CARD_HANDED_OVER);
    await fetchLeadCardAi(TENANT, "../x?y=1");
    expect(getJson.mock.calls[0][0]).toBe("/api/conversations/..%2Fx%3Fy%3D1/lead-card");
  });

  it("throws LeadCardDataError for an answer that doesn't fit the contract", async () => {
    getJson.mockResolvedValue({ ...LEAD_CARD_HANDED_OVER, score: "high" });
    await expect(fetchLeadCardAi(TENANT, CONV)).rejects.toBeInstanceOf(LeadCardDataError);
  });

  it("passes the API's error on", async () => {
    const err = new ApiError(404, { error: { code: "not_found", message: "That conversation was not found." } });
    getJson.mockImplementation(() => Promise.reject(err));
    const thrown = await fetchLeadCardAi(TENANT, CONV).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBe(err);
  });
});

describe("unavailableAi", () => {
  it("says the answer couldn't be read, without showing it", () => {
    expect(unavailableAi(new LeadCardDataError())).toEqual({ status: "unavailable", message: "The AI summary came back in a form we couldn't read." });
  });

  it("shows the API's own message for an API error", () => {
    const err = new ApiError(404, { error: { code: "not_found", message: "That conversation was not found." } });
    expect(unavailableAi(err)).toEqual({ status: "unavailable", message: "That conversation was not found." });
  });

  it("never shows raw text from an unknown error", () => {
    const state = unavailableAi(new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"));
    expect(state.status).toBe("unavailable");
    expect(JSON.stringify(state)).not.toMatch(/ECONNREFUSED|hunter2/);
  });
});
