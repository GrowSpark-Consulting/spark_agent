import type { Metadata } from "next";
import { NoBusinessPage } from "@/components/dashboard/no-business";
import { WebhookScreen } from "@/features/settings/integrations/webhook-screen";
import { requireDashboardView } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Integrations · Spark Agent" };

// /dashboard/settings/integrations. The business and role come from the session. The webhook is read and changed through the API
// (/api/integrations/webhook, owner or admin, checked by the server on every call); the plan gate is the server's too.
export default async function IntegrationsPage() {
  const view = await requireDashboardView();
  if (view.kind === "no_business") {
    return <NoBusinessPage eyebrow="Integrations" title="Integrations" detail="there's no webhook to show" />;
  }
  const { tenant, role } = view.context;
  return (
    <div className="app-page">
      <div>
        <p className="app-eyebrow">Settings</p>
        <h1 className="app-h1">Integrations</h1>
        <p className="app-lede">Send new leads, bookings and handovers to your CRM or spreadsheet as they happen.</p>
      </div>
      <WebhookScreen key={tenant.id} tenantId={tenant.id} role={role} />
    </div>
  );
}
