import type { Metadata } from "next";
import { NoBusinessPage } from "@/components/dashboard/no-business";
import { AdminCataloguePanel } from "@/components/dashboard/admin-catalogue-panel";
import { requireDashboardView } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Admin plans · Spark Agent" };

// /dashboard/admin/plans: for the Spark Agent team. Not in the navigation, like the other admin pages. The plans and features are catalogues any signed-in
// member reads; PATCH /api/admin/plans/:key and /api/admin/features/:key are the only gate on changing them (the browser cannot tell who is on the
// platform-admin list, because platform_admins is server-only) and answer `forbidden` to everyone else.
export default async function AdminPlansPage() {
  const view = await requireDashboardView();
  if (view.kind === "no_business") {
    return <NoBusinessPage eyebrow="Admin" title="Plans and features" detail="there's nothing to manage here" />;
  }
  return (
    <div className="app-page">
      <div>
        <p className="app-eyebrow">Admin</p>
        <h1 className="app-h1">Plans and features</h1>
        <p className="app-lede">Change a plan&apos;s name, price, credits, seats, numbers and features, and the feature catalogue. Only the Spark Agent team can save changes; the server refuses everyone else.</p>
      </div>
      <AdminCataloguePanel />
    </div>
  );
}
