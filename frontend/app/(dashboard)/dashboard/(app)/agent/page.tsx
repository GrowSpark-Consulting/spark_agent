import type { Metadata } from "next";
import { NoBusinessPage } from "@/components/dashboard/no-business";
import { AgentSettingsScreen } from "@/features/agent/agent-settings-screen";
import { requireDashboardView } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Agent settings · Spark Agent" };

// /dashboard/agent. The business and the member's role come from the session; the settings and every change go through the API
// (GET and PATCH /api/agent/settings), which checks the role and the values again.
export default async function AgentSettingsPage() {
  const view = await requireDashboardView();
  if (view.kind === "no_business") {
    return <NoBusinessPage eyebrow="Agent settings" title="Agent settings" detail="there are no settings to show" />;
  }
  const { tenant, role } = view.context;
  return (
    <div className="app-page">
      <div>
        <p className="app-eyebrow">Agent settings</p>
        <h1 className="app-h1">Agent settings</h1>
        <p className="app-lede">Choose your assistant&apos;s name and tone, and when it hands a chat to your team.</p>
      </div>
      <AgentSettingsScreen key={tenant.id} tenantId={tenant.id} role={role} />
    </div>
  );
}
