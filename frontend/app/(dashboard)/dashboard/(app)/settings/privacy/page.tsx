import type { Metadata } from "next";
import { NoBusinessPage } from "@/components/dashboard/no-business";
import { DataPrivacyScreen } from "@/features/settings/privacy/data-privacy-screen";
import { requireDashboardView } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Data & privacy · Spark Agent" };

// /dashboard/settings/privacy. The business and role come from the session. Deleting a customer's data goes through the API (owner or admin, checked
// by the server on every call); the customer list is read as the signed-in member under row-level security.
export default async function DataPrivacyPage() {
  const view = await requireDashboardView();
  if (view.kind === "no_business") {
    return <NoBusinessPage eyebrow="Data & privacy" title="Data & privacy" detail="there are no customers to show" />;
  }
  const { tenant, role } = view.context;
  return <DataPrivacyScreen key={tenant.id} tenantId={tenant.id} role={role} />;
}
