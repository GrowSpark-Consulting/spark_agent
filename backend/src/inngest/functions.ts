import { billingRenewals } from "./billing-renewals";
import { bookingReminders } from "./booking-reminders";
import { connectionHealth, connectionHealthCheck } from "./connection-health";
import { creditAlerts } from "./credit-alerts";
import { demoReply } from "./demo-reply";
import { dailyAgenda } from "./daily-agenda";
import { eventAlerts } from "./event-alerts";
import { googleCalendarSync } from "./google-calendar-sync";
import { handoffAlert } from "./handoff-alert";
import { handoffSla } from "./handoff-sla";
import { kbIngest } from "./kb-ingest";
import { kbSweep } from "./kb-sweep";
import { leadNudges } from "./lead-nudges";
import { mediaDownload } from "./media-download";
import { noShowRebooking } from "./noshow-rebooking";
import { outboundWebhooks } from "./outbound-webhooks";
import { ownNumberOutcome } from "./own-number-outcome";
import { phoneReplyReturn } from "./phone-reply-return";
import { ping } from "./ping";
import { postVisit } from "./post-visit";
import { processMessage } from "./process-message";
import { reportFailedJobs } from "./report-failed-jobs";
import { releaseHolds } from "./release-holds";
import { tokenExpiry } from "./token-expiry";
import { trialLifecycle, trialLifecycleSweep } from "./trial-lifecycle";
import { unpaidTrialCleanup } from "./unpaid-trial-cleanup";

// Every Inngest function is registered here and served from the API's /api/inngest (see serve.ts).
export const functions = [
  ping,
  releaseHolds,
  kbIngest,
  kbSweep,
  processMessage,
  handoffAlert,
  bookingReminders,
  handoffSla,
  postVisit,
  leadNudges,
  googleCalendarSync,
  noShowRebooking,
  dailyAgenda,
  ownNumberOutcome,
  phoneReplyReturn,
  creditAlerts,
  eventAlerts,
  connectionHealth,
  connectionHealthCheck,
  tokenExpiry,
  billingRenewals,
  trialLifecycle,
  trialLifecycleSweep,
  demoReply,
  mediaDownload,
  unpaidTrialCleanup,
  outboundWebhooks,
  reportFailedJobs,
];
