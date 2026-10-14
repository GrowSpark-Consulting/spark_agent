import type { Metadata } from "next";
import { NoBusinessPage } from "@/components/dashboard/no-business";
import { AdminConnectLinkForm } from "@/components/dashboard/admin-connect-link-form";
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
      <section aria-labelledby="link-h" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <h2 id="link-h" className="app-h2">Make a connect link</h2>
          <p className="app-lede">For a business that can&apos;t connect itself: make a one-time link (valid 24 hours) and send it to the owner. The server refuses anyone who is not on the platform-admin list.</p>
        </div>
        <AdminConnectLinkForm />
      </section>
      <section aria-labelledby="manual-h" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <h2 id="manual-h" className="app-h2">Connect a number by hand</h2>
        <AdminManualConnectForm />
      </section>
    </div>
  );
}
