import { describe, expect, it, vi } from "vitest";
import { fakePipelineStore, HIDDEN, type FakeLead, type FakeMessage } from "../../test-support/fake-pipeline-store";
import type { LlmClient, LlmRequest, LlmResult } from "../llm/anthropic";
import { samplePack } from "../packs/test-packs";
import type { CatalogRow } from "../scoring/references";
import type { StepRunner, TurnContext } from "./process-message";
import { understandTurn, type UnderstandDeps } from "./understand";

// Step 4 also qualifies the lead (step 5's first half, docs/handover.md): after the customer's details are saved, the lead is
// scored by code against the business's own catalog, the next missing details are worked out (at most two), and the score and
// temperature are kept on the lead. It is switched on by `deps.scoring`; without it the step does nothing new.

const A = "e0000000-0000-0000-0000-00000000000a";
const CONV = "c0000000-0000-0000-0000-00000000000c";
const CONTACT = "b0000000-0000-0000-0000-0000000000b1";
const LEAD = "10000000-0000-0000-0000-0000000000f1";
const M1 = "a0000000-0000-0000-0000-0000000000a1";
const LAKH = 100_000;
const SECRET = "SECRET-CUSTOMER-WORDS";

const pack = () =>
  samplePack({
    fields: [
      { key: "budget", label: "Budget", type: "range_inr", required: true },
      { key: "location", label: "Preferred area", type: "text", required: true },
      { key: "timeline", label: "Timeline", type: "enum", options: ["0-3m", "3-6m", "6m+"], required: true },
      { key: "funding", label: "Funding", type: "enum", options: ["loan_approved", "own_funds"] },
    ],
    scoring: {
      rules: [
        { field: "budget", match: "within_project_band", points: 30 },
        { field: "timeline", equals: "0-3m", points: 25 },
        { field: "location", match: "in_project_areas", points: 20 },
        { field: "funding", in: ["own_funds"], points: 15 },
      ],
      thresholds: { hot: 70, warm: 40 },
      hardFails: [{ field: "budget", below: "min_project_price" }],
    },
  });

const catalog: CatalogRow[] = [{ type: "property", priceFrom: 50 * LAKH, attributes: { price_to: 80 * LAKH, area: "Velachery" } }];

const reading = (fields: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  JSON.stringify({ language: "en", intent: "give_details", fields, question: null, preferredTime: null, sentiment: "neutral", asksIfHuman: false, confidence: 0.9, ...over });

function runner() {
  const memo = new Map<string, unknown>();
  const ran: string[] = [];
  const step: StepRunner = {
    async run(id, fn) {
      if (memo.has(id)) return memo.get(id) as never;
      ran.push(id);
      const value = await fn();
      memo.set(id, value);
      return value;
    },
  };
  return { step, ran, memo };
}

function world(over: { script: string; pack?: unknown; lead?: Partial<FakeLead>; packOverrides?: unknown; loadCatalog?: (tenantId: string) => Promise<CatalogRow[]>; overridesAllowed?: boolean; qualificationOn?: boolean; scoring?: boolean } = { script: reading({}) }) {
  const messages: FakeMessage[] = [{ id: M1, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "text", createdAt: "2026-10-08T10:00:00.000Z", body: SECRET }];
  const fake = fakePipelineStore({
    tenants: [{ id: A, vertical: "sample-pack", verticalVersion: 1 }],
    messages,
    leads: [{ id: LEAD, tenantId: A, contactId: CONTACT, stage: "new", createdAt: 1, fields: {}, ...over.lead }],
    packOverrides: over.packOverrides === undefined ? undefined : { [A]: over.packOverrides },
  });
  const complete = vi.fn<(request: LlmRequest) => Promise<LlmResult>>(async () => ({ text: over.script, model: "m", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, latencyMs: 1, attempts: 1, requestId: null }));
  const llm: LlmClient = { complete };
  const loadCatalog = vi.fn(over.loadCatalog ?? (async () => catalog));
  const isEnabled = vi.fn(async (_tenantId: string, feature: "lead_qualification" | "custom_scoring") => (feature === "custom_scoring" ? over.overridesAllowed ?? false : over.qualificationOn ?? true));
  const deps: UnderstandDeps = {
    store: fake.store,
    llm,
    loadPackDefinition: async () => over.pack ?? pack(),
    retrieve: async () => [],
    ...(over.scoring === false ? {} : { scoring: { loadCatalog, isEnabled } }),
  };
  const turn: TurnContext = { tenantId: A, conversationId: CONV, contactId: CONTACT, leadId: LEAD, leadCreated: false, messageIds: [M1], language: null, vertical: "sample-pack", verticalVersion: 1 };
  return { ...fake, deps, turn, loadCatalog, isEnabled };
}

const qualificationOf = async (w: ReturnType<typeof world>) => {
  const result = await understandTurn(runner().step, w.turn, w.deps);
  if (result.status !== "understood") throw new Error(`not understood: ${result.status}`);
  return result.qualification;
};

describe("the next details to ask for", () => {
  it("a customer who gave one detail is asked for the next missing required ones, two at most, in the pack's order", async () => {
    const q = await qualificationOf(world({ script: reading({ budget: "60L" }) }));
    expect(q?.ask).toEqual([
      { key: "location", label: "Preferred area" },
      { key: "timeline", label: "Timeline", options: ["0-3m", "3-6m", "6m+"] },
    ]);
    expect(q?.missingRequired).toEqual(["location", "timeline"]);
    expect(q?.readyForSlots).toBe(false);
  });

  it("counts what the lead already had from earlier messages", async () => {
    const q = await qualificationOf(world({ lead: { fields: { budget: "60L", location: "Velachery" } }, script: reading({}) }));
    expect(q?.ask.map((a) => a.key)).toEqual(["timeline"]);
  });

  it("asks nothing once every required detail is in, and says the lead is ready for a time", async () => {
    const q = await qualificationOf(world({ script: reading({ budget: "60L", location: "Velachery", timeline: "0-3m" }) }));
    expect(q).toMatchObject({ ask: [], missingRequired: [], temperature: "hot", score: 75, readyForSlots: true, hardFail: null });
  });
});

describe("the score", () => {
  it("is worked out against the business's own catalog and kept on the lead", async () => {
    const w = world({ script: reading({ budget: "60L", location: "Velachery", timeline: "0-3m", funding: "own_funds" }) });
    await qualificationOf(w);
    expect(w.leads.get(LEAD)).toMatchObject({ score: 90, temperature: "hot" });
    expect(w.loadCatalog).toHaveBeenCalledWith(A);
  });

  it("a budget certainly below the cheapest price disqualifies the lead, and nothing more is asked", async () => {
    const w = world({ script: reading({ budget: "20L" }) });
    const q = await qualificationOf(w);
    expect(q).toMatchObject({ temperature: "disqualified", ask: [], readyForSlots: false, hardFail: { field: "budget", rule: "below min_project_price" } });
    expect(w.leads.get(LEAD)).toMatchObject({ score: 0, temperature: "disqualified" });
  });

  it("a catalog that cannot be read does not fail the message: the rules that need it earn nothing", async () => {
    const w = world({ script: reading({ budget: "20L", timeline: "0-3m" }), loadCatalog: async () => { throw new Error("db down"); } });
    const q = await qualificationOf(w);
    expect(q).toMatchObject({ temperature: "cold", score: 25 });
    expect(w.leads.get(LEAD)).toMatchObject({ score: 25, temperature: "cold" });
  });

  it("a lead that is not open any more keeps its score", async () => {
    const w = world({ lead: { stage: "booked", score: 80, temperature: "hot" }, script: reading({ budget: "20L" }) });
    await qualificationOf(w);
    expect(w.leads.get(LEAD)).toMatchObject({ score: 80, temperature: "hot" });
  });
});

describe("the business's own scoring overrides", () => {
  const overrides = { scoring: { thresholds: { hot: 50, warm: 10 } } };
  const lead = { budget: "60L", location: "Velachery" };

  it("apply when the plan has custom scoring", async () => {
    const q = await qualificationOf(world({ script: reading(lead), packOverrides: overrides, overridesAllowed: true }));
    expect(q).toMatchObject({ score: 50, temperature: "hot" });
  });

  it("are ignored when it does not", async () => {
    const q = await qualificationOf(world({ script: reading(lead), packOverrides: overrides, overridesAllowed: false }));
    expect(q).toMatchObject({ score: 50, temperature: "warm" });
  });
});

describe("what runs, and what is remembered", () => {
  it("is not done when the business does not have lead qualification (isEnabled lead_qualification): the step runs and finds nothing to do", async () => {
    const w = world({ script: reading({ budget: "60L" }), qualificationOn: false });
    const result = await understandTurn(runner().step, w.turn, w.deps);
    expect((result as { qualification?: unknown }).qualification).toBeUndefined();
    expect(w.loadCatalog).not.toHaveBeenCalled();
    expect(w.leads.get(LEAD)?.score).toBeUndefined();
    expect(w.isEnabled).toHaveBeenCalledWith(A, "lead_qualification");
  });

  it("adds one step, after the details are saved, and keeps only small facts: no customer words", async () => {
    const w = world({ script: reading({ budget: "60L" }) });
    const r = runner();
    await understandTurn(r.step, w.turn, w.deps);
    expect(r.ran).toEqual(["extract", "save-fields", "qualify", "retrieve"]);
    expect(JSON.stringify([...r.memo.values()])).not.toContain(SECRET);
    expect(JSON.stringify([...r.memo.values()])).not.toContain(HIDDEN.phone);
  });

  it("is not done for a customer who is leaving", async () => {
    const w = world({ script: reading({}, { intent: "opt_out", confidence: 0.95 }) });
    const r = runner();
    const result = await understandTurn(r.step, w.turn, w.deps);
    expect(r.ran).not.toContain("qualify");
    expect(result).toMatchObject({ status: "understood" });
    expect((result as { qualification?: unknown }).qualification).toBeUndefined();
    expect(w.loadCatalog).not.toHaveBeenCalled();
  });

  it("without the scoring deps nothing new happens", async () => {
    const w = world({ script: reading({ budget: "60L" }), scoring: false });
    const r = runner();
    const result = await understandTurn(r.step, w.turn, w.deps);
    expect(r.ran).toEqual(["extract", "save-fields", "retrieve"]);
    expect((result as { qualification?: unknown }).qualification).toBeUndefined();
    expect(w.leads.get(LEAD)?.score).toBeUndefined();
  });

  it("a database failure when keeping the score is retried by the step, not hidden", async () => {
    const w = world({ script: reading({ budget: "60L" }) });
    w.state.failNext.add("saveLeadScore");
    await expect(understandTurn(runner().step, w.turn, w.deps)).rejects.toThrow();
  });
});

describe("the kind of booking the pack's business takes (read from the pack's bookingModes, never from an industry name)", () => {
  const withModes = (bookingModes: string[], extra: Record<string, unknown> = {}) =>
    samplePack({
      bookingModes,
      fields: [
        { key: "budget", label: "Budget", type: "range_inr", required: true },
        { key: "zip", label: "Pincode", type: "text" },
      ],
      scoring: { rules: [{ field: "budget", match: "within_project_band", points: 60 }, { field: "zip", match: "in_service_area", points: 40 }], thresholds: { hot: 70, warm: 40 }, hardFails: [] },
      ...extra,
    });
  const kindOf = async (modes: string[], extra: Record<string, unknown> = {}) => qualificationOf(world({ pack: withModes(modes, extra), script: reading({ budget: "60L", zip: "600042" }) }));

  it("a slot pack and a site visit pack book as before", async () => {
    expect((await kindOf(["slot"]))?.bookingKind).toBe("slot");
    expect((await kindOf(["site_visit"]))?.bookingKind).toBe("site_visit");
  });

  it("a field visit pack books field visits (it was never recognised: the pack's customers were offered no time)", async () => {
    expect((await kindOf(["field_visit"]))?.bookingKind).toBe("field_visit");
  });

  it("a pack that books by none of the three (a callback, a date range) offers no times", async () => {
    expect((await kindOf(["callback"]))?.bookingKind).toBeNull();
    expect((await kindOf(["date_range"]))?.bookingKind).toBeNull();
  });

  it("the first of the pack's modes the agent can book is the one used", async () => {
    expect((await kindOf(["callback", "field_visit"]))?.bookingKind).toBe("field_visit");
  });

  it("a field visit says which detail holds where the customer is (the pack's own area rule), as the detail's name only, never the customer's answer", async () => {
    const q = await kindOf(["field_visit"]);
    expect(q?.visitAreaField).toBe("zip");
    expect(JSON.stringify(q)).not.toContain("600042");
  });

  it("no such detail for a pack with no area rule, and none for a booking kind that does not go to the customer's address", async () => {
    const noArea = { scoring: { rules: [{ field: "budget", match: "within_project_band", points: 60 }], thresholds: { hot: 70, warm: 40 }, hardFails: [] } };
    expect((await kindOf(["field_visit"], noArea))?.visitAreaField ?? null).toBeNull();
    expect((await kindOf(["site_visit"]))?.visitAreaField ?? null).toBeNull();
    expect((await kindOf(["slot"]))?.visitAreaField ?? null).toBeNull();
  });
});
