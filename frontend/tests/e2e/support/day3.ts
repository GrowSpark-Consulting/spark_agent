import type { APIRequestContext, Page } from "@playwright/test";
import { expect, MOCK_SUPABASE_URL, signIn } from "./app";

// Day 3 screens (leads, calendar, booking setup) against mock-supabase.mjs. Every test gets its own
// business from POST /__mock/day3-account, so the desktop, tablet and phone projects never share rows.
// The seeded business (seed: true) is the week of Monday 12 Oct 2026 in Asia/Kolkata:
//   Asha (staff, own hours Mon–Sat 10–18), Ravi (staff, business hours, pincodes 600041 and 600096),
//   Room 2 (room, switched off); services Consultation (60 min, 15 min gap, 120 min notice) and
//   Follow-up (30 min).
//   Leads: Karthik R (qualified, 82 hot), Priya S (new, 55 warm), Lakshmi V (booked, 30 cold),
//   an unnamed contact (engaged, not scored), Deepa N (won, 90 hot).
//   Bookings on Mon 12 Oct: Karthik 10:00–11:00 with Asha (confirmed); Priya 11:30–12:00 with Ravi
//   (held, live); Lakshmi 14:00–15:00 with Asha (held, hold lapsed); the unnamed contact 16:00–16:15
//   callback with no one assigned; Deepa 12:00–13:00 with Ravi (cancelled). Tue 13 Oct: Lakshmi
//   10:00–11:00 with Asha (completed). Wed 14 Oct: Karthik 15:00–16:00 with Ravi (confirmed).

export const DAY = "2026-10-12";

export type Day3Role = "owner" | "admin" | "staff";
export interface Day3Account {
  email: string;
  tenantId: string;
  ids: Record<string, string>;
}

export async function newDay3Account(
  request: APIRequestContext,
  options: { seed?: boolean; role?: Day3Role; error?: "leads" | "bookings" | "resources" | "tenants"; inbox?: boolean; /** That many plain leads, for the board's paging. */ manyLeads?: number } = {},
): Promise<Day3Account> {
  return (await request.post(`${MOCK_SUPABASE_URL}/__mock/day3-account`, { data: options })).json();
}

export interface StoredDay3 {
  tenant: { business_hours: Record<string, { start: string; end: string }[]> } | null;
  resources: { id: string; name: string; type: string; working_hours: Record<string, unknown>; service_area: { pincodes: string[] } | null; active: boolean }[];
  services: { id: string; name: string; buffer_min: number; min_notice_min: number; duration_min: number }[];
  bookings: { id: string; status: string }[];
  leads: { id: string; stage: string; score: number | null; temperature: string | null }[];
}

export async function storedDay3(request: APIRequestContext, tenantId: string): Promise<StoredDay3> {
  return (await request.get(`${MOCK_SUPABASE_URL}/__mock/day3?tenant=${tenantId}`)).json();
}

/** The PostgREST requests this account made that weren't reads. */
export async function writesBy(request: APIRequestContext, email: string): Promise<{ method: string; table: string }[]> {
  const log = (await (await request.get(`${MOCK_SUPABASE_URL}/__mock/rest-log?email=${email}`)).json()) as { method: string; table: string }[];
  return log.filter((r) => r.method !== "GET" && r.method !== "HEAD");
}

export async function open(page: Page, account: Day3Account, path: string, heading: string | RegExp) {
  await signIn(page, account.email, path);
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
}

export async function expectDialogFits(page: Page) {
  const box = await page.getByRole("dialog").boundingBox();
  const vw = page.viewportSize()!.width;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vw);
}
