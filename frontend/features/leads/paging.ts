import type { FormattedError } from "@/lib/errors";
import type { Lead, LeadCursor, LeadsPage, PackFieldInfo } from "./data";

// The Leads board's loading state, as a pure reducer so it can be tested without a browser. The board reads
// one page, then more on request (data.ts, fetchLeadsPage). Two guards keep the list right whatever order answers
// arrive in:
//   - `generation` goes up on every reset (another business, or "Try again" on the first page; the caller numbers
//     them). An answer for an older generation is dropped, so a slow answer for the previous business can never land on the new one.
//   - a "load more" answer says which cursor it was asked for, and counts only if that is still the next page. A page
//     that arrives twice, or after the list moved on, is ignored; and a lead already shown is never added again.
// Filters are applied by the screen to whatever is loaded (matchesFilters), the same way to every page, so changing a
// filter does not start a request and nothing here depends on it.

export interface LeadsPaging {
  generation: number;
  /** The first page: loading, failed, or ready. */
  phase: "loading" | "error" | "ready";
  error: FormattedError | null;
  leads: Lead[];
  packFields: PackFieldInfo[];
  /** Where the next page starts; null when every lead has been read. */
  next: LeadCursor | null;
  /** The page after the first: nothing running, one running, or the last one failed. */
  more: "idle" | "loading" | "error";
  moreError: FormattedError | null;
  /** A read of the newest leads again, kept apart from loading: the list stays on screen while it runs. */
  refresh: "idle" | "loading" | "error";
  refreshError: FormattedError | null;
}

export type LeadsPagingAction =
  | { type: "reset"; generation: number }
  | { type: "first_loaded"; generation: number; page: LeadsPage; packFields: PackFieldInfo[] }
  | { type: "first_failed"; generation: number; error: FormattedError }
  | { type: "more_started"; generation: number }
  | { type: "more_loaded"; generation: number; from: LeadCursor; page: LeadsPage }
  | { type: "more_failed"; generation: number; from: LeadCursor; error: FormattedError }
  | { type: "refresh_started"; generation: number }
  | { type: "refreshed"; generation: number; page: LeadsPage }
  | { type: "refresh_failed"; generation: number; error: FormattedError };

export function initialLeadsPaging(generation = 0): LeadsPaging {
  return { generation, phase: "loading", error: null, leads: [], packFields: [], next: null, more: "idle", moreError: null, refresh: "idle", refreshError: null };
}

const sameCursor = (a: LeadCursor | null, b: LeadCursor) => a !== null && a.id === b.id && a.updatedAt === b.updatedAt;

/** The leads not already in the list, in arrival order. */
function appendNew(existing: Lead[], incoming: Lead[]): Lead[] {
  const seen = new Set(existing.map((l) => l.id));
  const fresh: Lead[] = [];
  for (const lead of incoming) {
    if (seen.has(lead.id)) continue;
    seen.add(lead.id);
    fresh.push(lead);
  }
  return fresh.length === 0 ? existing : [...existing, ...fresh];
}

const newestFirst = (a: Lead, b: Lead) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id);

/** What is known now: the lead as just read replaces the one held, new leads are added, and the order stays newest first. */
function mergeFresh(existing: Lead[], fresh: Lead[]): Lead[] {
  const byId = new Map(existing.map((l) => [l.id, l]));
  for (const lead of fresh) byId.set(lead.id, lead);
  return [...byId.values()].sort(newestFirst);
}

/**
 * True when a re-read of the newest page cannot be merged into what is held without maybe missing leads: the whole page
 * is newer than everything held and there are more behind it, so leads between the two may exist that neither has. (A
 * burst bigger than a page.) The caller then starts over from the first page instead.
 */
export function refreshLeavesGap(held: readonly Lead[], page: LeadsPage): boolean {
  if (page.next === null || held.length === 0 || page.leads.length === 0) return false;
  const newestHeld = held.reduce((max, l) => (l.updatedAt > max ? l.updatedAt : max), "");
  const oldestInPage = page.leads.reduce((min, l) => (l.updatedAt < min ? l.updatedAt : min), page.leads[0].updatedAt);
  return oldestInPage > newestHeld;
}

export function leadsPagingReducer(state: LeadsPaging, action: LeadsPagingAction): LeadsPaging {
  switch (action.type) {
    case "reset":
      return initialLeadsPaging(action.generation);
    case "first_loaded":
      if (action.generation !== state.generation) return state;
      return { ...state, phase: "ready", error: null, leads: appendNew([], action.page.leads), packFields: action.packFields, next: action.page.next, more: "idle", moreError: null };
    case "first_failed":
      if (action.generation !== state.generation) return state;
      return { ...state, phase: "error", error: action.error };
    case "more_started":
      // One page at a time: a second request while one runs, or with nothing left to read, changes nothing.
      if (action.generation !== state.generation || state.phase !== "ready" || state.next === null || state.more === "loading") return state;
      return { ...state, more: "loading", moreError: null };
    case "more_loaded":
      if (action.generation !== state.generation || !sameCursor(state.next, action.from)) return state;
      return { ...state, leads: appendNew(state.leads, action.page.leads), next: action.page.next, more: "idle", moreError: null };
    case "more_failed":
      if (action.generation !== state.generation || !sameCursor(state.next, action.from)) return state;
      // The leads already read stay on screen; only the next page is marked as failed, and can be tried again.
      return { ...state, more: "error", moreError: action.error };
    case "refresh_started":
      // Only a list that is already shown, and one read at a time.
      if (action.generation !== state.generation || state.phase !== "ready" || state.refresh === "loading") return state;
      return { ...state, refresh: "loading", refreshError: null };
    case "refreshed":
      // Merged into what is held (so pages already read stay), never replacing it with a shorter list. The cursor for the
      // next page is untouched: it is a value, so it still marks where the older leads begin.
      if (action.generation !== state.generation || state.phase !== "ready") return state;
      return { ...state, leads: mergeFresh(state.leads, action.page.leads), refresh: "idle", refreshError: null };
    case "refresh_failed":
      // What is on screen stays; only the note changes.
      if (action.generation !== state.generation || state.phase !== "ready") return state;
      return { ...state, refresh: "error", refreshError: action.error };
  }
}
