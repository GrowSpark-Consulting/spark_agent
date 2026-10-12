import type { Metadata } from "next";
import { NoBusinessPage } from "@/components/dashboard/no-business";
import { TogglesScreen } from "@/features/toggles/toggles-screen";
import { requireDashboardView } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Features · Spark Agent" };

// /dashboard/features. The business and the member's role come from the session; the list and every change go
// through the API (GET /api/features, PATCH /api/features/:key), which decides what the plan includes.
export default async function FeaturesPage() {
  const view = await requireDashboardView();
  if (view.kind === "no_business") {
    return <NoBusinessPage eyebrow="Features" title="Features" detail="there are no features to show" />;
  }
  const { tenant, role } = view.context;
  return (
    <div className="app-page">
      <div>
        <p className="app-eyebrow">Features</p>
        <h1 className="app-h1">Features</h1>
        <p className="app-lede">Choose what your assistant does, and see what each feature costs in credits.</p>
      </div>
      <TogglesScreen key={tenant.id} tenantId={tenant.id} role={role} />
    </div>
  );
}
