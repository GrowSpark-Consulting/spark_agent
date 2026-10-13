import { matchStop } from "../../../consent/stop-words";
import { findRouteCode, GREETING } from "./code";
import { detectLanguage, menuChoice, PICK_MAX_CHARS, type Lang, type MenuEntry, type ReplyKind } from "./text";

// Which business a message to the shared demo number belongs to (docs/handover.md, module 8), and what a visitor who cannot be routed is told. Code
// decides: no model, no Meta call. The database is injected (demo/db.ts), so the rules are tested without one.
//
//   1. A route code in the text is looked up (one read) and must name a business that is live. With no code, a short answer that is a number or an entry's
//      own words picks that entry's business, but only for a visitor with no route (with one, "2" is an answer to the assistant).
//   2. A TRIAL code first asks Dev 2's claim_trial_phone whether the sender may have it (one free trial per phone). A sender who already used a trial is
//      refused: the message is counted and answered, and starts no route.
//   3. The message is counted against the phone's day (30) in demo_admit, which also starts the 24-hour route of a valid code or pick in the same locked step.
//   4. A code or pick picks the business. Without one, a route under 24 hours old keeps the visitor with the same business.
//   5. Otherwise nothing is routed, and the visitor is answered (`reply`): the menu, "invalid or expired", the limit notice (once a day, the message that
//      crosses it) or the used-trial refusal. The caller stores such a message with the front desk and starts the reply (inbound.ts). A visitor with no route
//      who sends STOP (consent/stop-words.ts) is not answered at all.
//   6. A redelivered message (Meta repeats a webhook that was answered 500) is decided by where its first delivery put it: a message already stored with a
//      business is stored for that business again; one already stored with the front desk is answered again (the reply's event id makes that harmless); one
//      not stored at all is decided as if new.

export const DEMO_DAILY_LIMIT = 30;

export type DemoMessage = {
  /** E.164, from Meta's payload after its signature was verified. */
  from: string;
  /** The wamid: the dedupe key. */
  providerMsgId: string;
  /** The demo number's own channel, where every chat of the number is. */
  channelId: string;
  /** The front desk: the business that owns the number's connection, which holds the messages nobody is routed for. */
  deskTenantId: string;
  /** Customer text, already cleaned. Only text is searched for a code. */
  text?: string;
};

export type DemoReply = { kind: ReplyKind; lang: Lang };

export type DemoDecision =
  | {
      action: "store";
      tenantId: string;
      /** Replaces the stored text when the message carried a code or pick (it is taken out). */
      body?: string;
      routeCode?: string;
    }
  | { action: "drop"; reason: "limit" | "no_route" | "bad_code" | "trial_taken"; reply?: DemoReply };

export type TrialPhoneAnswer = "claimed" | "other_sender" | "taken";

export interface DemoDeps {
  /** The business a code names and what kind of code it is, or null when the code is unknown, expired or has no business. */
  findRoute(code: string): Promise<{ tenantId: string; kind: "demo" | "trial" } | null>;
  /** Whether a business can take the message: its status is trial or active. */
  isLive(tenantId: string): Promise<boolean>;
  /** Dev 2's claim_trial_phone (billing/trial-phone.ts), with the sender in E.164. */
  claimTrialPhone(tenantId: string, phone: string): Promise<TrialPhoneAnswer>;
  /** Whether the visitor has a route under 24 hours old. */
  hasRoute(phone: string): Promise<boolean>;
  /** The demo businesses, in order, for a pick and for the menu. */
  menu(): Promise<MenuEntry[]>;
  /** The business whose chat on this channel already holds a message with this id (the front desk's included), or null when none does. */
  messageTenant(args: { providerMsgId: string; channelId: string }): Promise<string | null>;
  /**
   * demo_admit: counts the message, starts the route of `routeTenantId` when it is admitted, and says which business the message belongs to (null: none).
   * `replay`: a message already admitted, answered with the business it was admitted for. `notifyLimit`: this is the one message of the day that gets the notice.
   */
  admit(args: { phone: string; wamid: string; limit: number; routeTenantId: string | null }): Promise<{ allowed: boolean; replay: boolean; notifyLimit: boolean; tenantId: string | null }>;
}

type Source = { code: string; rest: string };

export async function routeDemoMessage(message: DemoMessage, deps: DemoDeps): Promise<DemoDecision> {
  const lang = detectLanguage(message.text);
  const found = message.text === undefined ? null : findRouteCode(message.text);
  let source: Source | null = found;
  let route = found ? await deps.findRoute(found.code) : null;
  if (route && !(await deps.isLive(route.tenantId))) route = null;

  // A short answer from a visitor with no route: a number or an entry's own words picks it, like sending its code.
  if (!found && message.text !== undefined && message.text.trim().length > 0 && message.text.trim().length <= PICK_MAX_CHARS && !(await deps.hasRoute(message.from))) {
    const entry = menuChoice(message.text, await deps.menu());
    const picked = entry ? await deps.findRoute(entry.code) : null;
    if (entry && picked && (await deps.isLive(picked.tenantId))) {
      route = picked;
      source = { code: entry.code, rest: GREETING };
    }
  }

  // One free trial per phone: the sender of a TRIAL code is the trial's phone, or must not have used another.
  let refused = false;
  if (found && route?.kind === "trial" && (await deps.claimTrialPhone(route.tenantId, message.from)) === "taken") {
    refused = true;
    route = null;
  }

  const admitted = await deps.admit({ phone: message.from, wamid: message.providerMsgId, limit: DEMO_DAILY_LIMIT, routeTenantId: route?.tenantId ?? null });
  if (!admitted.allowed) return { action: "drop", reason: "limit", ...(admitted.notifyLimit ? { reply: { kind: "limit" as const, lang } } : {}) };

  // Nothing is routed and the visitor is told what to do, unless they asked not to be written to.
  const answer = (reason: "bad_code" | "trial_taken" | "no_route"): DemoDecision => {
    if (reason === "no_route" && message.text !== undefined && matchStop(message.text) !== null) return { action: "drop", reason };
    return { action: "drop", reason, reply: { kind: reason === "bad_code" ? "bad_code" : reason === "trial_taken" ? "trial_taken" : "menu", lang } };
  };
  const refusal = refused ? "trial_taken" : found && !route ? "bad_code" : null;

  if (admitted.replay) {
    // A redelivery is decided by where its first delivery put the message, not by what the visitor's route is now.
    const holder = await deps.messageTenant({ providerMsgId: message.providerMsgId, channelId: message.channelId });
    if (holder === message.deskTenantId) return answer(refusal ?? "no_route");
    if (holder !== null) return { action: "store", tenantId: holder, ...(source ? { body: source.rest, routeCode: source.code } : {}) };
  }

  if (refusal) return answer(refusal);
  if (!admitted.tenantId) return answer("no_route");
  if (admitted.tenantId !== route?.tenantId && !(await deps.isLive(admitted.tenantId))) return answer("no_route");

  return { action: "store", tenantId: admitted.tenantId, ...(source ? { body: source.rest, routeCode: source.code } : {}) };
}
