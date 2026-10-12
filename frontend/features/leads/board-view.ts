import type { LeadCounts } from "./data";

// What the Leads board says about numbers, kept apart from the component so it can be tested. The rule throughout: a number
// is either the database's count for the whole business, or loaded-so-far with a plus, or left out. It is never worked out
// from the leads on screen when they are only some of the leads.

/**
 * A stage column's count. When every matching lead is loaded, what is loaded is exact. When the list is cut short, the
 * database's count for that stage (read separately) is shown with how many are on screen; until it is known, a minimum.
 */
export function stageCountLabel({ loaded, truncated, exact }: { loaded: number; truncated: boolean; exact: number | undefined }): string {
  if (!truncated) return String(loaded);
  if (exact === undefined) return `${loaded}+`;
  return exact > loaded ? `${loaded} of ${exact}` : String(exact);
}

/** A filter chip: "Hot · 300", or just "Hot" when the counts could not be read. */
export function chipLabel(name: string, count: number | null): string {
  return count === null ? name : `${name} · ${count}`;
}

/** The line under the page title. */
export function headingText(counts: LeadCounts | null): string {
  return counts === null ? "Every WhatsApp enquiry, by stage." : `${counts.open} open · ${counts.hot} hot`;
}

/** The notice above the board while older matching leads remain unread. */
export function truncationNotice({ loaded, total, filtering }: { loaded: number; total: number | null; filtering: boolean }): string {
  const what = filtering ? "matching leads" : "leads";
  return total === null
    ? `Showing the ${loaded} most recently updated ${what}. Load more to see older ones.`
    : `Showing ${loaded} of ${total} ${what}, most recently updated first.`;
}
