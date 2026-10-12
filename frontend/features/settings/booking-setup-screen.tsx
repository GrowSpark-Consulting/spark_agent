"use client";

import type { Role } from "@pakka/types";
import { useEffect } from "react";
import { FlashStatus, useFlash } from "@/features/knowledge/flash";
import { ServicesEditor } from "@/features/knowledge/services-editor";
import { BookingServiceSection } from "./booking-service-section";
import { BusinessHoursSection } from "./business-hours-section";
import type { CalendarOutcome } from "./google-calendar";
import { ResourcesSection } from "./resources-section";

// /dashboard/settings/booking: what the slot engine works from (Day 3, "services and resources
// settings"). Business hours, staff and resources (hours, service-area pincodes) and the services table
// from the Knowledge base (the same component: length, gap, minimum notice). Owners and admins edit;
// staff see the same page read-only, as the Settings screen's role table proposes.

export function canEditBookingSetup(role: Role): boolean {
  return role === "owner" || role === "admin";
}

export function BookingSetupScreen({
  tenantId,
  role,
  calendarReturn,
}: {
  tenantId: string;
  role: Role;
  calendarReturn: { outcome: CalendarOutcome; resourceId: string | null } | null;
}) {
  const canWrite = canEditBookingSetup(role);
  const [toast, flash] = useFlash();

  // The outcome is shown once; a reload or a shared link shouldn't repeat it.
  useEffect(() => {
    if (calendarReturn) window.history.replaceState(window.history.state, "", window.location.pathname);
  }, [calendarReturn]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "36px", maxWidth: "960px", minWidth: 0, color: "var(--color-text)" }}>
      <div>
        <h1 className="app-h1">Booking setup</h1>
        <p style={{ margin: "4px 0 0", color: "var(--color-neutral-700)" }}>When you’re open, who can be booked and for how long. The AI only offers times that fit these.</p>
        {canWrite ? null : (
          <p className="app-notice" style={{ margin: "12px 0 0" }}>
            Only an owner or admin can change these.
          </p>
        )}
      </div>
      <BusinessHoursSection tenantId={tenantId} canWrite={canWrite} onSaved={flash} />
      <ResourcesSection tenantId={tenantId} canWrite={canWrite} onSaved={flash} calendarReturn={calendarReturn} />
      <ServicesEditor tenantId={tenantId} canWrite={canWrite} />
      <BookingServiceSection tenantId={tenantId} canWrite={canWrite} onSaved={flash} />
      <FlashStatus toast={toast} />
    </div>
  );
}
