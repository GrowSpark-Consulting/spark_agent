import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { serverEnv } from "../lib/env";
import { messageMediaNames, removeMessageMedia } from "../lib/storage";
import { supabaseAdmin } from "../lib/supabase-admin";
import { sendAccountNotice, type NoticeCounts, type NoticeMessage } from "../notify/account-notices";

// A business's data is deleted 30 days after its trial ended unpaid (9-day plan, Day 7; migration 0048). The job is
// inngest/unpaid-trial-cleanup.ts, once a day:
//   1. list: the businesses still on the trial plan and never paid whose trial ended 23 days ago or more (unpaid_trials_for_cleanup);
//   2. warn: those not yet due get one account_notice to their owners, 7 days before ("deleted on <date> unless you choose a plan"),
//      keyed by the business and the date, so the daily runs send it once (and again only if the date moves: a trial extended);
//   3. delete: those due are deleted by delete_unpaid_trial, which checks everything again with the business locked (a plan bought
//      meanwhile wins) and writes the audit row first;
//   4. media: then the business's files in message-media are removed through the Storage API (deleting rows does not touch storage).
// Placeholder wording until Raja's.

export interface UnpaidTrialDeps {
  db: SupabaseClient;
  appUrl: string;
  now: () => Date;
  notify: (tenantId: string, message: NoticeMessage, key: string) => Promise<NoticeCounts>;
}

export function unpaidTrialDeps(): UnpaidTrialDeps {
  return {
    db: supabaseAdmin(),
    appUrl: serverEnv().NEXT_PUBLIC_APP_URL,
    now: () => new Date(),
    notify: (tenantId, message, key) => sendAccountNotice(tenantId, message, key),
  };
}

/** One business to clean up. Plain JSON: it is a step's result. */
export interface UnpaidTrial {
  tenantId: string;
  trialEndedAt: string;
  deletesOn: string;
  /** 30 days or more since the trial ended: delete it now. Otherwise warn. */
  due: boolean;
}

const Row = z.object({ tenant_id: z.string(), trial_ended_at: z.string(), deletes_on: z.string(), due: z.boolean() });

/** At most this many businesses a run; the next day's run takes the rest. */
export const MAX_PER_RUN = 100;

export async function listUnpaidTrials(deps: UnpaidTrialDeps): Promise<UnpaidTrial[]> {
  const { data, error } = await deps.db.rpc("unpaid_trials_for_cleanup", { p_now: deps.now().toISOString() });
  if (error) throw new Error("unpaid trials: listing failed");
  return z
    .array(Row)
    .parse(data ?? [])
    .slice(0, MAX_PER_RUN)
    .map((r) => ({ tenantId: r.tenant_id, trialEndedAt: new Date(r.trial_ended_at).toISOString(), deletesOn: new Date(r.deletes_on).toISOString(), due: r.due }));
}

const dayInIndia = (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
const keyDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

/** The warning, 7 days before. */
export function deletionWarning(trial: Pick<UnpaidTrial, "trialEndedAt" | "deletesOn">, appUrl: string): NoticeMessage {
  const headline = `Your Spark Agent trial ended on ${dayInIndia(trial.trialEndedAt)}. Your chats, leads and settings will be deleted on ${dayInIndia(trial.deletesOn)}.`;
  const link = `${appUrl.replace(/\/$/, "")}/dashboard/billing`;
  return { text: `${headline}\nChoose a plan in Billing to keep them.\n${link}`, templateParams: [headline, link] };
}

/** Warns the owners once per business and deletion date. */
export async function warnUnpaidTrial(trial: UnpaidTrial, deps: UnpaidTrialDeps): Promise<NoticeCounts> {
  return deps.notify(trial.tenantId, deletionWarning(trial, deps.appUrl), `unpaid_trial_warning:${trial.tenantId}:${keyDay(trial.deletesOn)}`);
}

const Deleted = z.array(z.object({ outcome: z.enum(["deleted", "gone", "not_eligible"]), counts: z.record(z.string(), z.number()) })).length(1);

/** deleted: it went now; gone: it had already gone (a retried step); not_eligible: it paid, or its trial was extended, since it was listed. */
export async function deleteUnpaidTrial(tenantId: string, deps: UnpaidTrialDeps): Promise<{ outcome: "deleted" | "gone" | "not_eligible"; counts: Record<string, number> }> {
  const { data, error } = await deps.db.rpc("delete_unpaid_trial", { p_tenant_id: tenantId, p_now: deps.now().toISOString() });
  if (error) throw new Error("unpaid trials: deleting failed");
  return Deleted.parse(data)[0];
}

/** A deleted business's files. Throws when any is left, so the job's step is retried; listing again finds only what is left. */
export async function removeTenantMedia(tenantId: string, deps: UnpaidTrialDeps): Promise<{ removed: number }> {
  const result = await removeMessageMedia(deps.db, await messageMediaNames(deps.db, tenantId));
  if (result.left > 0) throw new Error(`unpaid trials: ${result.left} media file(s) were not removed; retrying`);
  return { removed: result.removed };
}
