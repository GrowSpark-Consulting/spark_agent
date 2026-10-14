import type { Metadata } from "next";
import { NoBusinessPage } from "@/components/dashboard/no-business";
import { AdminBillingPanel } from "@/components/dashboard/admin-billing-panel";
import { requireDashboardView } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Admin billing · Spark Agent" };

// /dashboard/admin/billing: for the Spark Agent team. Not in the navigation: the browser cannot tell who is on the platform-admin list
// (platform_admins is server-only), so GET /api/admin/tenants and the other admin routes are the only gate and answer `forbidden` to everyone else.
export default async function AdminBillingPage() {
  const view = await requireDashboardView();
  if (view.kind === "no_business") {
    return <NoBusinessPage eyebrow="Admin" title="Billing" detail="there's nothing to manage here" />;
  }
  return (
    <div className="app-page">
      <div>
        <p className="app-eyebrow">Admin</p>
        <h1 className="app-h1">Billing</h1>
        <p className="app-lede">Extend a trial, grant credits and see payments to refund. Only the Spark Agent team can use this; the server refuses everyone else.</p>
      </div>
      <AdminBillingPanel />
    </div>
  );
}
