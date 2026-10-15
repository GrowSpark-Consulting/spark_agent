import type { Metadata } from "next";
import { NoBusinessPage } from "@/components/dashboard/no-business";
import { AdminConnectionsPanel } from "@/components/dashboard/admin-connections-panel";
import { requireDashboardView } from "@/lib/auth/session";

export const metadata: Metadata = { title: "WhatsApp connections · Spark Agent" };

// /dashboard/admin/connections: for the Spark Agent team. Not in the navigation: the browser cannot tell who is on the platform-admin list
// (platform_admins is server-only), so GET /api/admin/whatsapp/connections is the only gate and answers `forbidden` to everyone else.
export default async function AdminConnectionsPage() {
  const view = await requireDashboardView();
  if (view.kind === "no_business") {
    return <NoBusinessPage eyebrow="Admin" title="WhatsApp connections" detail="there's nothing to see here" />;
  }
  return (
    <div className="app-page">
      <div>
        <p className="app-eyebrow">Admin</p>
        <h1 className="app-h1">WhatsApp connections</h1>
        <p className="app-lede">Every business&apos;s connection, its status and its last check. Read only. Only the Spark Agent team can see this; the server refuses everyone else.</p>
      </div>
      <AdminConnectionsPanel />
    </div>
  );
}
