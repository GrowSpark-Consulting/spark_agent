import type { Metadata } from "next";
import { NoBusinessPage } from "@/components/dashboard/no-business";
import { AdminMetricsPanel } from "@/components/dashboard/admin-metrics-panel";
import { requireDashboardView } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Admin metrics · Spark Agent" };

// /dashboard/admin/metrics: for the Spark Agent team. Not in the navigation, like the other admin pages: the browser cannot tell who is on the
// platform-admin list (platform_admins is server-only), so GET /api/admin/metrics is the only gate and answers `forbidden` to everyone else.
export default async function AdminMetricsPage() {
  const view = await requireDashboardView();
  if (view.kind === "no_business") {
    return <NoBusinessPage eyebrow="Admin" title="Metrics" detail="there's nothing to show here" />;
  }
  return (
    <div className="app-page">
      <div>
        <p className="app-eyebrow">Admin</p>
        <h1 className="app-h1">Metrics</h1>
        <p className="app-lede">What a credit costs us against the target, and how many trials turn into paid plans. Only the Spark Agent team can see this; the server refuses everyone else.</p>
      </div>
      <AdminMetricsPanel />
    </div>
  );
}
