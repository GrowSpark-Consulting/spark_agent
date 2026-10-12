import type { Metadata } from "next";
import { NoBusinessPage } from "@/components/dashboard/no-business";
import { AdminManualConnectForm } from "@/components/dashboard/admin-manual-connect-form";
import { requireDashboardView } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Connect a number · Spark Agent" };

// /dashboard/admin/whatsapp: for the Spark Agent team. Not in the navigation: the browser cannot tell who is on the platform-admin list
// (platform_admins is server-only), so POST /api/admin/whatsapp/manual is the only gate and answers `forbidden` to everyone else.
export default async function AdminWhatsAppPage() {
  const view = await requireDashboardView();
  if (view.kind === "no_business") {
    return <NoBusinessPage eyebrow="Admin" title="Connect a number" detail="there's nothing to connect here" />;
  }
  return (
    <div className="app-page">
      <div>
        <p className="app-eyebrow">Admin</p>
        <h1 className="app-h1">Connect a number</h1>
        <p className="app-lede">Connect a client&apos;s own Meta number by hand. Only the Spark Agent team can do this; the server refuses everyone else.</p>
      </div>
      <AdminManualConnectForm />
    </div>
  );
}
