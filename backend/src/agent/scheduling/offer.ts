import { MAX_WINDOW_DAYS } from "../../booking/slots";
import { addDays, zonedTime } from "../../booking/time";
import type { TimeWindow } from "./preferred-time";

// Offering times (step 6): what is remembered about an offer, the facts the reply may use, and where to look for free times. Pure.
//
// The offer is written to the customer by the model as ordinary sentences, from the labels below ("Sun 11 Oct, 10:00 am", made by
// booking/time.ts slotLabel in the business's own time zone). The post-check (postcheck.ts) then makes sure the reply states no date or
// time that is not in these facts.

/** The most times offered at once (the booking engine's own limit). */
export const MAX_OFFERED = 3;
const DAY_MS = 24 * 60 * 60_000;
const SOON_DAYS = 3;

/** What is kept of an offered time: enough to hold and confirm it later. ISO 8601 UTC. */
export interface OfferedSlot {
  start: string;
  end: string;
  resourceId: string;
  serviceId: string;
  label: string;
}

export function toOffered(slots: readonly OfferedSlot[]): OfferedSlot[] {
  return slots.slice(0, MAX_OFFERED).map(({ start, end, resourceId, serviceId, label }) => ({ start, end, resourceId, serviceId, label }));
}

/** The facts for an offer. `asked`: the times are inside what the customer asked for (otherwise they are the nearest there were). */
export function offerFacts(slots: readonly OfferedSlot[], { asked }: { asked: boolean }): string[] {
  if (slots.length === 0) return ["No free time was found in the coming days. A team member will follow up with the customer."];
  const list = `Free times: ${slots.map((s) => s.label).join("; ")}.`;
  return asked ? [list] : ["Nothing was free at the time the customer asked for. These are the closest free times.", list];
}

export interface SearchWindow {
  kind: "asked" | "day" | "soon" | "later";
  from: Date;
  to: Date;
}

/**
 * The windows to look in, in order: what the customer asked for; the rest of that day; the next three days; then as far as the
 * booking engine allows. The first window with a free time wins, and only `asked` means the customer got what they asked for.
 * Never into the past (a window is cut to start at `now`), and never longer than findSlots accepts.
 */
export function searchWindows(preferred: TimeWindow | null, now: Date, timeZone: string): SearchWindow[] {
  const tries: SearchWindow[] = [];
  const push = (kind: SearchWindow["kind"], rawFrom: Date, rawTo: Date) => {
    const from = rawFrom.getTime() < now.getTime() ? now : rawFrom;
    const to = new Date(Math.min(rawTo.getTime(), from.getTime() + MAX_WINDOW_DAYS * DAY_MS));
    if (to.getTime() > from.getTime()) tries.push({ kind, from, to });
  };

  if (preferred) {
    push("asked", preferred.from, preferred.to);
    const dayStart = zonedTime(preferred.date, 0, timeZone);
    const dayEnd = zonedTime(addDays(preferred.date, 1), 0, timeZone);
    const wholeDay = preferred.from.getTime() <= dayStart.getTime() && preferred.to.getTime() >= dayEnd.getTime();
    if (!wholeDay) push("day", dayStart, dayEnd);
    const after = preferred.to.getTime() > now.getTime() ? preferred.from : now;
    push("soon", after, new Date(Math.max(after.getTime(), now.getTime()) + SOON_DAYS * DAY_MS));
  } else {
    push("soon", now, new Date(now.getTime() + SOON_DAYS * DAY_MS));
  }
  push("later", now, new Date(now.getTime() + MAX_WINDOW_DAYS * DAY_MS));
  return tries;
}
