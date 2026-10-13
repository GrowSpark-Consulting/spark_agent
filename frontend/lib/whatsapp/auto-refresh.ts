import type { ConnectionStatus } from "@pakka/types";

// How often the WhatsApp screen reads its connections again without being asked. whatsapp_connections is not in the Realtime
// publication (docs/whatsapp-connection-contract.md, open decision 5: "poll the view while status = 'validating'"), and Dev 1's daily health
// check can turn an active number to `failed` with no request from anyone, so the screen polls instead of assuming a subscription.

export const FAST_REFRESH_MS = 10_000;
export const SLOW_REFRESH_MS = 60_000;
/** Coming back to the tab reads at once, but never twice within this gap. */
export const MIN_REFRESH_GAP_MS = 5_000;

/**
 * The wait before the next read: quick while a number is still being set up or checked (`pending`, `validating`), slow while anything else
 * is live, and none when nothing can change on its own (no numbers, or every one disconnected).
 */
export function refreshIntervalMs(statuses: readonly ConnectionStatus[]): number | null {
  if (statuses.some((s) => s === "pending" || s === "validating")) return FAST_REFRESH_MS;
  if (statuses.some((s) => s !== "disconnected")) return SLOW_REFRESH_MS;
  return null;
}
