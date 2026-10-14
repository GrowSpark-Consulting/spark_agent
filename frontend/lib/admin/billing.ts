import { AdminTenant, ExtendTrialInput, GrantCreditsInput, RefundCandidate } from "@pakka/types";
import { z } from "zod";
import { getJson, postJson } from "@/lib/api/client";

// The admin panel's billing calls (docs/contracts.md, "Admin panel, billing"; backend/src/billing/admin.ts). Platform admins only: the server
// answers `forbidden` to anyone else and that is the only check that counts. Admin routes name the business in the path, never by
// X-Pakka-Tenant, so no call here sends the header.
//   GET  /api/admin/tenants                       → AdminTenant[], newest first
//   POST /api/admin/tenants/:id/extend-trial      { days: 1..30 } → { trialEndsAt }; `conflict` for a business with a plan
//   POST /api/admin/tenants/:id/credits           { amount: 1..100000, expiresInDays?, note?, requestId? } → { granted, credits }
//   GET  /api/admin/payments/refunds              → RefundCandidate[] (refunded by hand in PayU's dashboard)
// Not here: PATCH /api/admin/plans/:key and PATCH /api/admin/features/:key. The contracts give no route to read the current plans or features
// as an admin, so an editor would be filling blind.

export class AdminDataError extends Error {
  constructor(what: string) {
    super(`The ${what} answer was not in the shape the contract promises`);
    this.name = "AdminDataError";
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new AdminDataError(what);
  return parsed.data;
}

export async function fetchAdminTenants(signal?: AbortSignal): Promise<AdminTenant[]> {
  return parse(z.array(AdminTenant), await getJson<unknown>("/api/admin/tenants", { signal }), "business list");
}

export async function fetchRefundCandidates(signal?: AbortSignal): Promise<RefundCandidate[]> {
  return parse(z.array(RefundCandidate), await getJson<unknown>("/api/admin/payments/refunds", { signal }), "refund list");
}

const idOf = (id: string) => encodeURIComponent(id.trim());

export async function extendTrial(tenantId: string, input: ExtendTrialInput): Promise<{ trialEndsAt: string }> {
  const body = parse(ExtendTrialInput, input, "extend-trial request");
  return parse(z.object({ trialEndsAt: z.string() }), await postJson<unknown>(`/api/admin/tenants/${idOf(tenantId)}/extend-trial`, body), "extend-trial");
}

export async function grantCredits(tenantId: string, input: GrantCreditsInput): Promise<{ granted: boolean; credits: number }> {
  const body = parse(GrantCreditsInput, input, "grant-credits request");
  return parse(z.object({ granted: z.boolean(), credits: z.number().int() }), await postJson<unknown>(`/api/admin/tenants/${idOf(tenantId)}/credits`, body), "grant-credits");
}

/** What the form can check before anything is sent; the server validates again. */
export function validateDays(text: string): { value?: number; error?: string } {
  const n = Number(text.trim());
  if (text.trim() === "" || !Number.isInteger(n)) return { error: "Enter a whole number of days." };
  const r = ExtendTrialInput.shape.days.safeParse(n);
  return r.success ? { value: r.data } : { error: r.error.issues[0]?.message ?? "Check the days." };
}

export function validateGrant(amountText: string, expiresText: string, noteText: string): { value?: Omit<GrantCreditsInput, "requestId">; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  const amount = Number(amountText.trim());
  if (amountText.trim() === "" || !Number.isInteger(amount)) fields.amount = "Enter a whole number of credits.";
  else {
    const r = GrantCreditsInput.shape.amount.safeParse(amount);
    if (!r.success) fields.amount = r.error.issues[0]?.message ?? "Check the amount.";
  }
  let expiresInDays: number | undefined;
  if (expiresText.trim() !== "") {
    expiresInDays = Number(expiresText.trim());
    if (!GrantCreditsInput.shape.expiresInDays.safeParse(expiresInDays).success) fields.expiresInDays = "Leave blank for never, or 1 to 365 days.";
  }
  const note = noteText.trim();
  if (note.length > 200) fields.note = "At most 200 characters.";
  if (Object.keys(fields).length) return { fields };
  return { value: { amount, ...(expiresInDays !== undefined ? { expiresInDays } : {}), ...(note ? { note } : {}) }, fields };
}
