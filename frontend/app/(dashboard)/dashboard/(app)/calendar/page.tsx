import type { Metadata } from "next";
import { z } from "zod";
import { NoBusinessPage } from "@/components/dashboard/no-business";
import { CalendarScreen } from "@/features/calendar/calendar-screen";
import { NO_RESOURCE } from "@/features/calendar/data";
import { isDateString, isValidTimeZone } from "@/features/calendar/time";
import { ErrorState } from "@/components/shared/states";
import { requireDashboardView } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Calendar · Spark Agent" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

// /dashboard/calendar[?view=week&date=YYYY-MM-DD&resource=<id>|none]. The tenant and its time zone come
// from the session; the query only picks the view. Bookings are read here and changed through the API (Day 5).
export default async function CalendarPage({ searchParams }: PageProps<"/dashboard/calendar">) {
  const view = await requireDashboardView();
  if (view.kind === "no_business") {
    return <NoBusinessPage eyebrow="Calendar" title="Calendar" detail="there are no bookings to show" />;
  }
  const query = await searchParams;
  const date = first(query.date);
  const resource = first(query.resource);
  const { tenant, role, user } = view.context;
  if (!isValidTimeZone(tenant.timezone)) {
    return <ErrorState title="Your business's time zone isn't recognised" description={`Bookings can't be placed on the calendar until it's fixed (it is set to “${tenant.timezone}”).`} />;
  }
  return (
    <CalendarScreen
      key={tenant.id}
      tenantId={tenant.id}
      role={role}
      userId={user.id}
      timeZone={tenant.timezone}
      initialView={first(query.view) === "week" ? "week" : "day"}
      initialDate={date && isDateString(date) ? date : null}
      initialResource={resource === NO_RESOURCE || z.guid().safeParse(resource).success ? (resource as string) : "all"}
    />
  );
}
