import { AdminFeature, AdminFeatureInput, AdminPlan, AdminPlanInput } from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { patchJson } from "@/lib/api/client";

// The admin panel's plan and feature editor (docs/contracts.md, "Admin panel, billing"; packages/types admin.ts; backend/src/billing/admin.ts).
//   plans, features               read under row-level security: 0001 makes both global catalogues that any signed-in user reads, and
//                                 supabase/tests/isolation.test.sql proves a member cannot change them. Same read as the Billing screen's plans.
//   PATCH /api/admin/plans/:key       AdminPlanInput    → AdminPlan      platform admins only
//   PATCH /api/admin/features/:key    AdminFeatureInput → AdminFeature   platform admins only
// The read is open to every member and the write is not, and the browser cannot tell who is on the platform-admin list (platform_admins is
// server-only). So the editor shows the catalogue to anyone who opens the page and the server alone decides who may change it: `forbidden` is
// shown as such and nothing is saved. Only the fields that changed are sent (the route leaves a field it is not sent as it is), so two people
// editing different fields of one plan do not undo each other. The server also refuses a price change while businesses are subscribed at the
// old price (conflict); this file never decides that.

export class CatalogueDataError extends Error {
  constructor(what: string) {
    super(`The ${what} answer was not in the shape the contract promises`);
    this.name = "CatalogueDataError";
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new CatalogueDataError(what);
  return parsed.data;
}

const PlanRow = z.object({
  key: z.string(),
  name: z.string(),
  price_inr: z.number().int(),
  monthly_credits: z.number().int(),
  seats: z.number().int(),
  whatsapp_numbers: z.number().int(),
  feature_keys: z.array(z.string()),
});

const FeatureRow = z.object({ key: z.string(), name: z.string(), description: z.string(), default_on: z.boolean() });

/** Every plan, cheapest first, as the editor shows it. */
export async function fetchPlanCatalogue(client: SupabaseClient): Promise<AdminPlan[]> {
  const { data, error } = await client
    .from("plans")
    .select("key, name, price_inr, monthly_credits, seats, whatsapp_numbers, feature_keys")
    .order("price_inr", { ascending: true })
    .order("key", { ascending: true });
  if (error) throw error;
  return parse(z.array(PlanRow), data ?? [], "plan list").map((p) => ({
    key: p.key,
    name: p.name,
    priceInr: p.price_inr,
    monthlyCredits: p.monthly_credits,
    seats: p.seats,
    whatsappNumbers: p.whatsapp_numbers,
    featureKeys: p.feature_keys,
  }));
}

/** Every feature, by key. */
export async function fetchFeatureCatalogue(client: SupabaseClient): Promise<AdminFeature[]> {
  const { data, error } = await client.from("features").select("key, name, description, default_on").order("key", { ascending: true });
  if (error) throw error;
  return parse(z.array(FeatureRow), data ?? [], "feature list").map((f) => ({ key: f.key, name: f.name, description: f.description, defaultOn: f.default_on }));
}

const keyOf = (key: string) => encodeURIComponent(key.trim());

/** Sends the fields that changed. The answer must be for the plan asked about. */
export async function savePlan(key: string, input: AdminPlanInput): Promise<AdminPlan> {
  const body = parse(AdminPlanInput, input, "plan change request");
  const plan = parse(AdminPlan, await patchJson<unknown>(`/api/admin/plans/${keyOf(key)}`, body), "plan change");
  if (plan.key !== key) throw new CatalogueDataError("plan change");
  return plan;
}

/** Sends the fields that changed. The answer must be for the feature asked about. */
export async function saveFeature(key: string, input: AdminFeatureInput): Promise<AdminFeature> {
  const body = parse(AdminFeatureInput, input, "feature change request");
  const feature = parse(AdminFeature, await patchJson<unknown>(`/api/admin/features/${keyOf(key)}`, body), "feature change");
  if (feature.key !== key) throw new CatalogueDataError("feature change");
  return feature;
}

// Drafts -------------------------------------------------------------------------------------------------------------

/** What the plan form holds: numbers as the text typed, the features as the set that is ticked. */
export interface PlanDraft {
  name: string;
  priceInr: string;
  monthlyCredits: string;
  seats: string;
  whatsappNumbers: string;
  featureKeys: string[];
}

export const draftOfPlan = (p: AdminPlan): PlanDraft => ({
  name: p.name,
  priceInr: String(p.priceInr),
  monthlyCredits: String(p.monthlyCredits),
  seats: String(p.seats),
  whatsappNumbers: String(p.whatsappNumbers),
  featureKeys: [...p.featureKeys],
});

export interface FeatureDraft {
  name: string;
  description: string;
  defaultOn: boolean;
}

export const draftOfFeature = (f: AdminFeature): FeatureDraft => ({ name: f.name, description: f.description, defaultOn: f.defaultOn });

/** What a check of a draft found: the fields to send, the fields that are wrong, or that nothing changed. */
export type Checked<T> = { kind: "invalid"; fields: Record<string, string> } | { kind: "unchanged" } | { kind: "changes"; value: T };

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k) => b.includes(k));

/** Reads a whole number field with the contract's own lower limit (packages/types admin.ts: a price is 0 or more, the rest 1 or more). */
function wholeNumber(text: string, min: number, label: string): { value?: number; error?: string } {
  const n = Number(text.trim());
  if (text.trim() === "" || !Number.isInteger(n)) return { error: `${label}: enter a whole number.` };
  return n >= min ? { value: n } : { error: `${label}: ${min === 0 ? "0 or more" : "at least " + min}.` };
}

export function checkPlan(original: AdminPlan, draft: PlanDraft): Checked<AdminPlanInput> {
  const fields: Record<string, string> = {};
  const value: AdminPlanInput = {};

  const name = draft.name.trim();
  if (name !== original.name) {
    if (AdminPlanInput.shape.name.safeParse(name).success) value.name = name;
    else fields.name = "Name: 1 to 60 characters.";
  }
  const numbers = [
    ["priceInr", "Price", 0, original.priceInr, draft.priceInr],
    ["monthlyCredits", "Monthly credits", 1, original.monthlyCredits, draft.monthlyCredits],
    ["seats", "Seats", 1, original.seats, draft.seats],
    ["whatsappNumbers", "WhatsApp numbers", 1, original.whatsappNumbers, draft.whatsappNumbers],
  ] as const;
  for (const [field, label, min, was, text] of numbers) {
    const read = wholeNumber(text, min, label);
    if (read.error) fields[field] = read.error;
    else if (read.value !== was) value[field] = read.value;
  }
  if (!sameSet(draft.featureKeys, original.featureKeys)) value.featureKeys = [...draft.featureKeys];

  if (Object.keys(fields).length) return { kind: "invalid", fields };
  return Object.keys(value).length ? { kind: "changes", value } : { kind: "unchanged" };
}

export function checkFeature(original: AdminFeature, draft: FeatureDraft): Checked<AdminFeatureInput> {
  const fields: Record<string, string> = {};
  const value: AdminFeatureInput = {};
  const name = draft.name.trim();
  if (name !== original.name) {
    if (AdminFeatureInput.shape.name.safeParse(name).success) value.name = name;
    else fields.name = "Name: 1 to 80 characters.";
  }
  const description = draft.description.trim();
  if (description !== original.description) {
    if (AdminFeatureInput.shape.description.safeParse(description).success) value.description = description;
    else fields.description = "Description: 1 to 300 characters.";
  }
  if (draft.defaultOn !== original.defaultOn) value.defaultOn = draft.defaultOn;

  if (Object.keys(fields).length) return { kind: "invalid", fields };
  return Object.keys(value).length ? { kind: "changes", value } : { kind: "unchanged" };
}
