import { AdminPlanInput } from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const patchJson = vi.fn();
vi.mock("@/lib/api/client", () => ({ patchJson: (...a: unknown[]) => patchJson(...a) }));

const { CatalogueDataError, checkFeature, checkPlan, draftOfFeature, draftOfPlan, fetchFeatureCatalogue, fetchPlanCatalogue, saveFeature, savePlan } = await import("./catalogue");

/** A query builder that answers the awaited call from `result` and records the calls. */
function fakeClient(result: { data: unknown; error: unknown }) {
  const calls: [string, unknown[]][] = [];
  const builder: Record<string, unknown> = {};
  for (const name of ["select", "order"]) {
    builder[name] = (...args: unknown[]) => {
      calls.push([name, args]);
      return builder;
    };
  }
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  const client = {
    from: (table: string) => {
      calls.push(["from", [table]]);
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const plan = { key: "growth", name: "Growth", priceInr: 2499, monthlyCredits: 1500, seats: 5, whatsappNumbers: 2, featureKeys: ["ai_auto_reply", "booking"] };
const feature = { key: "booking", name: "Booking in chat", description: "Offers slots and books them.", defaultOn: true };

beforeEach(() => patchJson.mockReset());

describe("the catalogue reads", () => {
  it("reads plans from the plans table, cheapest first, in the editor's shape", async () => {
    const c = fakeClient({
      data: [{ key: "growth", name: "Growth", price_inr: 2499, monthly_credits: 1500, seats: 5, whatsapp_numbers: 2, feature_keys: ["ai_auto_reply", "booking"] }],
      error: null,
    });
    expect(await fetchPlanCatalogue(c.client)).toEqual([plan]);
    expect(c.calls).toContainEqual(["from", ["plans"]]);
    expect(c.calls).toContainEqual(["order", ["price_inr", { ascending: true }]]);
  });

  it("reads features from the features table", async () => {
    const c = fakeClient({ data: [{ key: "booking", name: "Booking in chat", description: "Offers slots and books them.", default_on: true }], error: null });
    expect(await fetchFeatureCatalogue(c.client)).toEqual([feature]);
    expect(c.calls).toContainEqual(["from", ["features"]]);
  });

  it("passes a read error on and refuses rows that are not the contract's shape", async () => {
    const boom = new Error("boom");
    await expect(fetchPlanCatalogue(fakeClient({ data: null, error: boom }).client)).rejects.toBe(boom);
    await expect(fetchPlanCatalogue(fakeClient({ data: [{ key: "x" }], error: null }).client)).rejects.toBeInstanceOf(CatalogueDataError);
    await expect(fetchFeatureCatalogue(fakeClient({ data: [{ key: "x", default_on: "yes" }], error: null }).client)).rejects.toBeInstanceOf(CatalogueDataError);
  });

  it("treats no rows as an empty list, not an error", async () => {
    expect(await fetchPlanCatalogue(fakeClient({ data: null, error: null }).client)).toEqual([]);
  });
});

describe("savePlan and saveFeature", () => {
  it("PATCHes the plan's own path with the changed fields, and returns the server's plan", async () => {
    patchJson.mockResolvedValue({ ...plan, seats: 8 });
    expect(await savePlan("growth", { seats: 8 })).toEqual({ ...plan, seats: 8 });
    expect(patchJson).toHaveBeenCalledWith("/api/admin/plans/growth", { seats: 8 });
  });

  it("PATCHes the feature's own path", async () => {
    patchJson.mockResolvedValue({ ...feature, defaultOn: false });
    expect((await saveFeature("booking", { defaultOn: false })).defaultOn).toBe(false);
    expect(patchJson).toHaveBeenCalledWith("/api/admin/features/booking", { defaultOn: false });
  });

  it("sends nothing for an empty or out-of-contract change", async () => {
    await expect(savePlan("growth", {})).rejects.toBeInstanceOf(CatalogueDataError);
    await expect(savePlan("growth", { seats: 0 })).rejects.toBeInstanceOf(CatalogueDataError);
    await expect(saveFeature("booking", { name: "  " })).rejects.toBeInstanceOf(CatalogueDataError);
    expect(patchJson).not.toHaveBeenCalled();
  });

  it("refuses an answer for another plan or feature, or in another shape, and passes a refusal on", async () => {
    patchJson.mockResolvedValueOnce({ ...plan, key: "pro" });
    await expect(savePlan("growth", { seats: 8 })).rejects.toBeInstanceOf(CatalogueDataError);
    patchJson.mockResolvedValueOnce({ ...feature, key: "other" });
    await expect(saveFeature("booking", { defaultOn: false })).rejects.toBeInstanceOf(CatalogueDataError);
    patchJson.mockResolvedValueOnce({ key: "growth" });
    await expect(savePlan("growth", { seats: 8 })).rejects.toBeInstanceOf(CatalogueDataError);
    patchJson.mockRejectedValueOnce(new Error("forbidden"));
    await expect(savePlan("growth", { seats: 8 })).rejects.toThrow("forbidden");
  });

  it("encodes the key into the path", async () => {
    patchJson.mockResolvedValue({ ...plan, key: "a/b" });
    await savePlan("a/b", { seats: 2 });
    expect(patchJson.mock.calls[0][0]).toBe("/api/admin/plans/a%2Fb");
  });
});

describe("checkPlan", () => {
  const draft = () => draftOfPlan(plan);

  it("says nothing changed for an untouched draft, and for a name or number typed back as it was", () => {
    expect(checkPlan(plan, draft())).toEqual({ kind: "unchanged" });
    expect(checkPlan(plan, { ...draft(), name: "  Growth  ", seats: " 5 " })).toEqual({ kind: "unchanged" });
  });

  it("sends only the fields that changed", () => {
    expect(checkPlan(plan, { ...draft(), priceInr: "2999" })).toEqual({ kind: "changes", value: { priceInr: 2999 } });
    expect(checkPlan(plan, { ...draft(), name: "Growth Plus", seats: "6" })).toEqual({ kind: "changes", value: { name: "Growth Plus", seats: 6 } });
  });

  it("treats the ticked features as a set: a different order is no change, a different member is", () => {
    expect(checkPlan(plan, { ...draft(), featureKeys: ["booking", "ai_auto_reply"] })).toEqual({ kind: "unchanged" });
    expect(checkPlan(plan, { ...draft(), featureKeys: ["booking"] })).toEqual({ kind: "changes", value: { featureKeys: ["booking"] } });
    expect(checkPlan(plan, { ...draft(), featureKeys: [] })).toEqual({ kind: "changes", value: { featureKeys: [] } });
  });

  it("names every wrong field and sends nothing", () => {
    const r = checkPlan(plan, { ...draft(), name: "   ", priceInr: "free", monthlyCredits: "0", seats: "2.5", whatsappNumbers: "" });
    expect(r.kind).toBe("invalid");
    if (r.kind !== "invalid") return;
    expect(Object.keys(r.fields).sort()).toEqual(["monthlyCredits", "name", "priceInr", "seats", "whatsappNumbers"]);
    expect(r.fields.priceInr).toContain("whole number");
    expect(r.fields.monthlyCredits).toContain("at least 1");
  });

  it("allows a price of 0 and refuses a negative one, as the contract does", () => {
    expect(checkPlan(plan, { ...draft(), priceInr: "0" })).toEqual({ kind: "changes", value: { priceInr: 0 } });
    expect(checkPlan(plan, { ...draft(), priceInr: "-1" }).kind).toBe("invalid");
  });

  it("agrees with the shared schema: whatever it sends, the schema accepts, and what it refuses the schema refuses too", () => {
    const sent = checkPlan(plan, { ...draft(), name: "X".repeat(60), priceInr: "0", monthlyCredits: "1", seats: "1", whatsappNumbers: "1" });
    expect(sent.kind).toBe("changes");
    if (sent.kind === "changes") expect(AdminPlanInput.safeParse(sent.value).success).toBe(true);
    expect(checkPlan(plan, { ...draft(), name: "X".repeat(61) }).kind).toBe("invalid");
    expect(AdminPlanInput.safeParse({ name: "X".repeat(61) }).success).toBe(false);
    for (const [field, text] of [["priceInr", "-1"], ["monthlyCredits", "0"], ["seats", "0"], ["whatsappNumbers", "0"]] as const) {
      expect(checkPlan(plan, { ...draft(), [field]: text }).kind).toBe("invalid");
      expect(AdminPlanInput.safeParse({ [field]: Number(text) }).success).toBe(false);
    }
  });
});

describe("checkFeature", () => {
  const draft = () => draftOfFeature(feature);

  it("says nothing changed for an untouched draft", () => {
    expect(checkFeature(feature, draft())).toEqual({ kind: "unchanged" });
  });

  it("sends only what changed", () => {
    expect(checkFeature(feature, { ...draft(), defaultOn: false })).toEqual({ kind: "changes", value: { defaultOn: false } });
    expect(checkFeature(feature, { ...draft(), name: "Booking", description: "New words." })).toEqual({ kind: "changes", value: { name: "Booking", description: "New words." } });
  });

  it("refuses an empty name or description, and one that is too long", () => {
    const r = checkFeature(feature, { ...draft(), name: " ", description: "x".repeat(301) });
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") expect(Object.keys(r.fields).sort()).toEqual(["description", "name"]);
    expect(checkFeature(feature, { ...draft(), name: "x".repeat(81) }).kind).toBe("invalid");
  });
});
