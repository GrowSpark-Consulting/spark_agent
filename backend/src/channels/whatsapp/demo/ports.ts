// Ports to things another developer builds. Nothing here is called yet.

/**
 * One trial per owner phone (Day 6, abuse controls). Dev 2's claim_trial_phone does the claiming in the
 * database; it does not exist yet. Until it does, this is the place the routing will call it from, and the
 * default says "claimed" without asking anyone. NOT called by route.ts today: wiring it is a follow-up for
 * when his function and its exact arguments exist (see docs/task-notes/2026-10-13-day6-dev1-demo-routing.md).
 */
export type ClaimTrialPhone = (args: { tenantId: string; phone: string }) => Promise<"claimed" | "refused">;

export const claimTrialPhoneNotBuilt: ClaimTrialPhone = async () => "claimed";
