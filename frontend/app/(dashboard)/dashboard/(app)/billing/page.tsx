import type { Metadata } from "next";
import { NoBusinessPage } from "@/components/dashboard/no-business";
import { BillingScreen } from "@/features/billing/billing-screen";
import { requireDashboardView } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Billing · Spark Agent" };

// /dashboard/billing. The business and the member's role come from the session; the plan comes from GET /api/billing/balance and the
// credit history and plans are read under row-level security. Owners and admins see it (billing-screen.tsx).
export default async function BillingPage() {
  const view = await requireDashboardView();
  if (view.kind === "no_business") {
    return <NoBusinessPage eyebrow="Billing" title="Billing" detail="there's no plan or credit history to show" />;
  }
  const { tenant, role } = view.context;
  return (
    <div className="app-page">
      <div>
        <p className="app-eyebrow">Billing</p>
        <h1 className="app-h1">Billing and credits</h1>
        <p className="app-lede">Your plan, your credits and where they went.</p>
      </div>
      <BillingScreen key={tenant.id} tenantId={tenant.id} role={role} timeZone={tenant.timezone} />
    </div>
  );
}
