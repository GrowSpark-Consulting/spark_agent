import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { NoBusinessNotice } from "@/components/dashboard/no-business";
import { WhatsAppConnectionPanel } from "@/components/dashboard/whatsapp-connection-panel";
import { LoadingState } from "@/components/shared/states";
import { HomeOverview } from "@/features/home/home-overview";
import { calendarReturn } from "@/features/settings/google-calendar";
import { requireDashboardView } from "@/lib/auth/session";
import { packLabel } from "@/lib/format";

export const metadata: Metadata = { title: "Home · Spark Agent" };

const STATUS_LABEL = { trial: "Free trial", active: "Active", paused: "Paused", cancelled: "Cancelled" } as const;
const ROLE_LABEL = { owner: "Owner", admin: "Admin", staff: "Staff" } as const;

function formatDate(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone }).format(new Date(iso));
}

export default async function HomePage({ searchParams }: PageProps<"/dashboard">) {
  // Google Calendar's callback (Dev 2) returns the browser to /dashboard?google_calendar=…&resource=…;
  // the outcome belongs on Booking setup, where calendars are connected. Only known values are passed on.
  const returned = calendarReturn(await searchParams);
  if (returned) {
    const query = new URLSearchParams({ google_calendar: returned.outcome, ...(returned.resourceId ? { resource: returned.resourceId } : {}) });
    redirect(`/dashboard/settings/booking?${query}`);
  }
  const view = await requireDashboardView();
  if (view.kind === "no_business") return <NoBusinessHome email={view.user.email} />;
  const { user, role, tenant } = view.context;

  return (
    <div className="app-page">
      <div>
        <p className="app-eyebrow">{packLabel(tenant.vertical)}</p>
        <h1 className="app-h1">{tenant.name}</h1>
        <p className="app-lede">Signed in as {user.email ?? "a team member"}.</p>
      </div>

      <HomeOverview key={tenant.id} tenantId={tenant.id} />

      <section aria-labelledby="biz-heading" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <h2 id="biz-heading" className="app-section-title">Your business</h2>
        <dl className="app-facts">
          <div>
            <dt>Account</dt>
            <dd>{STATUS_LABEL[tenant.status]}</dd>
          </div>
          {tenant.status === "trial" && tenant.trialEndsAt ? (
            <div>
              <dt>Trial ends</dt>
              <dd>{formatDate(tenant.trialEndsAt, tenant.timezone)}</dd>
            </div>
          ) : null}
          <div>
            <dt>Plan</dt>
            <dd>{packLabel(tenant.planKey)}</dd>
          </div>
          <div>
            <dt>Your role</dt>
            <dd>{ROLE_LABEL[role]}</dd>
          </div>
          <div>
            <dt>Time zone</dt>
            <dd>{tenant.timezone}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="wa-heading" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <h2 id="wa-heading" className="app-section-title">WhatsApp</h2>
        <Suspense fallback={<LoadingState compact title="Checking your WhatsApp connection" />}>
          <WhatsAppConnectionPanel tenantId={tenant.id} compact />
        </Suspense>
      </section>

      <MessagingTools />
    </div>
  );
}

/** Development only: Home for a signed-in account with no business. Every section says it's empty. */
function NoBusinessHome({ email }: { email: string | null }) {
  return (
    <div className="app-page">
      <div>
        <p className="app-eyebrow">No business yet</p>
        <h1 className="app-h1">Home</h1>
        <p className="app-lede">Signed in as {email ?? "a team member"}.</p>
      </div>

      <section aria-labelledby="biz-heading" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <h2 id="biz-heading" className="app-section-title">Your business</h2>
        <NoBusinessNotice title="No business linked" detail="there's no business, plan or trial to show" />
      </section>

      <section aria-labelledby="wa-heading" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <h2 id="wa-heading" className="app-section-title">WhatsApp</h2>
        <NoBusinessNotice title="No WhatsApp number" detail="there's no WhatsApp connection to show" />
      </section>

      <MessagingTools />
    </div>
  );
}

function MessagingTools() {
  return (
    <section aria-labelledby="tools-heading" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <h2 id="tools-heading" className="app-section-title">Messaging tools</h2>
      <div className="app-grid">
        <Link className="app-card" href="/dashboard/messages/test">
          <span className="app-card-title">Send a test message</span>
          <span className="app-card-text">Send a WhatsApp message from your business number to a phone that messaged it in the last 24 hours.</span>
        </Link>
        <Link className="app-card" href="/dashboard/templates/new">
          <span className="app-card-title">Create a template</span>
          <span className="app-card-text">Write a message template and submit it to Meta for approval.</span>
        </Link>
        <Link className="app-card" href="/dashboard/whatsapp">
          <span className="app-card-title">WhatsApp connection</span>
          <span className="app-card-text">See your number&apos;s status, quality rating and messaging limit.</span>
        </Link>
      </div>
    </section>
  );
}
