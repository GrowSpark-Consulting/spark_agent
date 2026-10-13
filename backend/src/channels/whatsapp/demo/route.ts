import { findRouteCode } from "./code";

// Which business a message to the shared demo number belongs to (docs/handover.md, module 8). Code decides: no
// model, no Meta call. The database is injected (demo/db.ts), so the rules are tested without one.
//
//   1. A route code in the text is looked up (one read) and must name a business that is live.
//   2. The message is counted against the phone's day (30) in demo_admit, which also starts the 24-hour route of a
//      valid code in the same locked step. Over the limit the message is dropped.
//   3. A code picks the business. Without one, a route under 24 hours old keeps the visitor with the same business.
//      A redelivered message goes to the business it was first admitted for.
//   4. Otherwise (no code and no route, a code that is unknown, expired or of a business that is no longer live)
//      nothing is stored or answered. The industry menu and the replies that explain this are the next PR.

export const DEMO_DAILY_LIMIT = 30;

export type DemoMessage = {
  /** E.164, from Meta's payload after its signature was verified. */
  from: string;
  /** The wamid: the dedupe key. */
  providerMsgId: string;
  /** Customer text, already cleaned. Only text is searched for a code. */
  text?: string;
};

export type DemoDecision =
  | {
      action: "store";
      tenantId: string;
      /** Replaces the stored text when the message carried a code (the code is taken out). */
      body?: string;
      routeCode?: string;
    }
  | { action: "drop"; reason: "limit" | "no_route" | "bad_code" };

export interface DemoDeps {
  /** The business a code names, or null when the code is unknown, expired or has no business. */
  findRoute(code: string): Promise<{ tenantId: string } | null>;
  /** Whether a business can take the message: its status is trial or active. */
  isLive(tenantId: string): Promise<boolean>;
  /**
   * demo_admit: counts the message, starts the route of `routeTenantId` when it is admitted, and says which business
   * the message belongs to (null: none). `replay`: a message already admitted, answered with the business it was admitted for.
   */
  admit(args: { phone: string; wamid: string; limit: number; routeTenantId: string | null }): Promise<{ allowed: boolean; replay: boolean; tenantId: string | null }>;
}

export async function routeDemoMessage(message: DemoMessage, deps: DemoDeps): Promise<DemoDecision> {
  const found = message.text === undefined ? null : findRouteCode(message.text);
  let route = found ? await deps.findRoute(found.code) : null;
  if (route && !(await deps.isLive(route.tenantId))) route = null;

  const admitted = await deps.admit({ phone: message.from, wamid: message.providerMsgId, limit: DEMO_DAILY_LIMIT, routeTenantId: route?.tenantId ?? null });
  if (!admitted.allowed) return { action: "drop", reason: "limit" };
  // A code that leads nowhere is an error even for a visitor who has a route; a redelivery of a message that was admitted keeps its business.
  if (found && !route && !admitted.replay) return { action: "drop", reason: "bad_code" };
  if (!admitted.tenantId) return { action: "drop", reason: "no_route" };
  // claimTrialPhone (ports.ts) goes here for a TRIAL code once Dev 2's claim_trial_phone exists.
  if (admitted.tenantId !== route?.tenantId && !(await deps.isLive(admitted.tenantId))) return { action: "drop", reason: "no_route" };

  return { action: "store", tenantId: admitted.tenantId, ...(found ? { body: found.rest, routeCode: found.code } : {}) };
}
