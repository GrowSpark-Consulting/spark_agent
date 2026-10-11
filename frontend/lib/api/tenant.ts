import { resolveTenant, type MembershipOption } from "@pakka/backend/lib/tenant";
import type { Role } from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

// Which business a browser call is for, when the page has no tenant to hand it. The dashboard gets its
// tenant from the server (a prop from requireTenantContext); onboarding does not: the business is made
// during the wizard, and the tenant cookie is httpOnly, so the browser cannot read it.
//
// This asks the same question the dashboard gate and the API ask, with the same function (resolveTenant):
// the signed-in user's memberships, read as that user, so row-level security decides what is visible. Nothing
// is remembered between calls, so a business that changed since the last call is never sent. The result goes
// in X-Pakka-Tenant (lib/api/client.ts). It is a request, not proof: the API checks the membership again.

export type BrowserTenant =
  | { status: "ok"; tenantId: string; role: Role }
  | { status: "signed_out" }
  | { status: "no_business" }
  /** Several businesses and no way to tell which one: the caller must not send a request. */
  | { status: "choose"; businesses: { tenantId: string; name: string }[] }
  | { status: "error" };

export async function resolveBrowserTenant(client: SupabaseClient = getSupabaseBrowserClient()): Promise<BrowserTenant> {
  try {
    const { data } = await client.auth.getSession();
    const user = data.session?.user;
    if (!user) return { status: "signed_out" };
    // No preference: the cookie that records a choice is not readable here, so only a single business resolves.
    const state = await resolveTenant(client, { id: user.id, email: user.email ?? null }, null);
    if (state.status === "ok") return { status: "ok", tenantId: state.context.tenant.id, role: state.context.role };
    if (state.status === "no_membership") return { status: "no_business" };
    return { status: "choose", businesses: state.memberships.map((m: MembershipOption) => ({ tenantId: m.tenantId, name: m.name })) };
  } catch {
    return { status: "error" };
  }
}
