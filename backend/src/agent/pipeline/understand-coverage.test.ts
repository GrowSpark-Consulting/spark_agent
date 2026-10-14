import { describe, expect, it, vi } from "vitest";
import { fakePipelineStore, type FakeLead, type FakeMessage } from "../../test-support/fake-pipeline-store";
import type { LlmClient, LlmRequest, LlmResult } from "../llm/anthropic";
import { samplePack } from "../packs/test-packs";
import type { CatalogRow } from "../scoring/references";
import type { StepRunner, TurnContext } from "./process-message";
import { understandTurn, type UnderstandDeps } from "./understand";

// Step 4 also reads where the customer wants to be against where the business has sites (scoring/coverage.ts), and keeps the reading on the
// message's meta for the reply step (`meta.agent.coverageReading`). It is a reading, not a decision: plan.ts decides what to say. The words
// (the customer's place, the business's places) stay on the message; the step's result, which Inngest keeps, holds none of them.

const A = "e0000000-0000-0000-0000-00000000000a";
const CONV = "c0000000-0000-0000-0000-00000000000c";
const CONTACT = "b0000000-0000-0000-0000-0000000000b1";
const LEAD = "10000000-0000-0000-0000-0000000000f1";
const M1 = "a0000000-0000-0000-0000-0000000000a1";
const LAKH = 100_000;

const areaPack = () =>
  samplePack({
    fields: [
      { key: "budget", label: "Budget", type: "range_inr", required: true },
      { key: "location", label: "Preferred area", type: "text", required: true },
    ],
    scoring: {
      rules: [
        { field: "budget", match: "within_project_band", points: 30 },
        { field: "location", match: "in_project_areas", points: 20 },
      ],
      thresholds: { hot: 70, warm: 40 },
      hardFails: [],
    },
  });
const noAreaPack = () =>
  samplePack({
    fields: [{ key: "budget", label: "Budget", type: "range_inr", required: true }, { key: "location", label: "Preferred area", type: "text" }],
    scoring: { rules: [{ field: "budget", match: "within_project_band", points: 30 }], thresholds: { hot: 70, warm: 40 }, hardFails: [] },
  });
const pincodePack = () =>
  samplePack({
    fields: [{ key: "pincode", label: "Pincode", type: "text" }],
    coverage: { field: "pincode", match: "in_service_area" },
    scoring: { rules: [{ field: "pincode", points: 5, equals: "600001" }], thresholds: { hot: 70, warm: 40 }, hardFails: [] },
  });

const catalog: CatalogRow[] = [
  { type: "property", priceFrom: 50 * LAKH, attributes: { price_to: 80 * LAKH, area: "Velachery" } },
  { type: "property", priceFrom: 60 * LAKH, attributes: { areas: ["Tambaram", "Anna Nagar"] } },
];

const reading = (fields: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  JSON.stringify({ language: "en", intent: "give_details", fields, question: null, preferredTime: null, sentiment: "neutral", asksIfHuman: false, confidence: 0.9, ...over });

function runner() {
  const memo = new Map<string, unknown>();
  const step: StepRunner = {
    async run(id, fn) {
      if (memo.has(id)) return memo.get(id) as never;
      const value = await fn();
      memo.set(id, value);
      return value;
    },
  };
  return { step, memo };
}

interface World {
  script: string;
  lead?: Partial<FakeLead>;
  pack?: () => unknown;
  rows?: CatalogRow[];
  qualificationOn?: boolean;
}

function world(over: World) {
  const messages: FakeMessage[] = [{ id: M1, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "text", createdAt: "2026-10-08T10:00:00.000Z", body: "hello" }];
  const fake = fakePipelineStore({
    tenants: [{ id: A, vertical: "sample-pack", verticalVersion: 1 }],
    messages,
    leads: [{ id: LEAD, tenantId: A, contactId: CONTACT, stage: "new", createdAt: 1, fields: {}, ...over.lead }],
  });
  const complete = vi.fn<(request: LlmRequest) => Promise<LlmResult>>(async () => ({ text: over.script, model: "m", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, latencyMs: 1, attempts: 1, requestId: null }));
  const llm: LlmClient = { complete };
  const deps: UnderstandDeps = {
    store: fake.store,
    llm,
    loadPackDefinition: async () => (over.pack ?? areaPack)(),
    retrieve: async () => [],
    scoring: { loadCatalog: async () => over.rows ?? catalog, isEnabled: async (_t: string, feature: string) => (feature === "custom_scoring" ? false : over.qualificationOn ?? true) },
  };
  const turn: TurnContext = { tenantId: A, conversationId: CONV, contactId: CONTACT, leadId: LEAD, leadCreated: false, messageIds: [M1], language: null, vertical: "sample-pack", verticalVersion: 1 };
  return { ...fake, deps, turn };
}

const run = async (w: ReturnType<typeof world>) => {
  const r = runner();
  const result = await understandTurn(r.step, w.turn, w.deps);
  const meta = w.messages.get(M1)?.meta?.agent as Record<string, unknown> | undefined;
  return { result, meta, memo: r.memo };
};

describe("an area the business has no sites in", () => {
  it("is kept as the reading of the message: not served, the customer's place and the places the business has, as it wrote them", async () => {
    const { meta } = await run(world({ script: reading({ budget: "60L", location: "Adyar." }) }));
    expect(meta?.coverageReading).toEqual({ served: false, area: "adyar", shown: "Adyar.", areas: ["Velachery", "Tambaram", "Anna Nagar"], known: ["velachery", "tambaram", "anna nagar"], named: true });
  });

  it("is what was SAVED: a doubtful reading that does not replace the place the lead already has is not what the customer is taken to have said", async () => {
    const w = world({ script: reading({ location: "Adyar" }, { confidence: 0.3 }), lead: { fields: { location: "Velachery" } } });
    const { meta } = await run(w);
    expect(w.leads.get(LEAD)?.fields?.location).toBe("Velachery");
    expect(meta?.coverageReading).toMatchObject({ served: true, area: "velachery", named: false });
  });

  it("is what the customer said when a doubtful reading fills a gap, and when they repeat the place the lead already has", async () => {
    expect((await run(world({ script: reading({ location: "Adyar" }, { confidence: 0.3 }) }))).meta?.coverageReading).toMatchObject({ served: false, area: "adyar", named: true });
    expect((await run(world({ script: reading({ location: "adyar" }), lead: { fields: { location: "Adyar" } } }))).meta?.coverageReading).toMatchObject({ served: false, area: "adyar", named: true });
  });

  it("is read from the lead when the customer did not name a place this time, and says so", async () => {
    const { meta } = await run(world({ script: reading({ budget: "60L" }), lead: { fields: { location: "Adyar" } } }));
    expect(meta?.coverageReading).toMatchObject({ served: false, area: "adyar", named: false });
  });

  it("judges a pincode as it is typed, for a pack that names its coverage", async () => {
    const rows: CatalogRow[] = [{ type: "service", priceFrom: 1, attributes: { areas: ["600042", "600020"] } }];
    expect((await run(world({ script: reading({ pincode: "641 001" }), pack: pincodePack, rows }))).meta?.coverageReading).toMatchObject({ served: false, area: "641001", areas: ["600042", "600020"] });
    expect((await run(world({ script: reading({ pincode: "600 042" }), pack: pincodePack, rows }))).meta?.coverageReading).toMatchObject({ served: true, area: "600042", named: true });
  });
});

describe("an area the business has", () => {
  it("is kept as served and named, so the reply step can end what was said about an unserved one", async () => {
    const { meta } = await run(world({ script: reading({ location: "velachery" }), lead: { fields: { location: "Adyar" } } }));
    expect(meta?.coverageReading).toMatchObject({ served: true, area: "velachery", named: true });
  });
});

describe("no reading", () => {
  it("when no place is known at all", async () => {
    expect((await run(world({ script: reading({ budget: "60L" }) }))).meta?.coverageReading).toBeNull();
  });

  it("when the business has listed no areas: it cannot be judged, nobody is turned away", async () => {
    expect((await run(world({ script: reading({ location: "Adyar" }), rows: [{ type: "property", priceFrom: 50 * LAKH, attributes: {} }] }))).meta?.coverageReading).toBeNull();
  });

  it("when the pack has no notion of where it works", async () => {
    const { meta } = await run(world({ script: reading({ location: "Adyar" }), pack: noAreaPack }));
    expect(meta && Object.hasOwn(meta, "coverageReading")).toBe(false);
  });

  it("when qualifying is not on for the business", async () => {
    const { meta } = await run(world({ script: reading({ location: "Adyar" }), qualificationOn: false }));
    expect(meta && Object.hasOwn(meta, "coverageReading")).toBe(false);
  });

  it("for a customer who is leaving: what they said is not kept", async () => {
    const { meta } = await run(world({ script: reading({ location: "Adyar" }, { intent: "opt_out", confidence: 0.95 }) }));
    expect(meta && Object.hasOwn(meta, "coverageReading")).toBe(false);
  });
});

describe("what the step remembers", () => {
  it("holds none of the customer's words or the business's places: Inngest keeps every step's result", async () => {
    const { memo } = await run(world({ script: reading({ budget: "60L", location: "Adyar" }) }));
    const kept = JSON.stringify([...memo.entries()]);
    expect(kept).not.toMatch(/adyar|velachery|tambaram/i);
  });

  it("is the same when the step runs again", async () => {
    const w = world({ script: reading({ location: "Adyar" }) });
    const first = (await run(w)).meta?.coverageReading;
    const second = (await run(w)).meta?.coverageReading;
    expect(second).toEqual(first);
  });
});
