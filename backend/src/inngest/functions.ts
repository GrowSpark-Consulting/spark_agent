import { bookingReminders } from "./booking-reminders";
import { dailyAgenda } from "./daily-agenda";
import { googleCalendarSync } from "./google-calendar-sync";
import { handoffAlert } from "./handoff-alert";
import { handoffSla } from "./handoff-sla";
import { kbIngest } from "./kb-ingest";
import { kbSweep } from "./kb-sweep";
import { leadNudges } from "./lead-nudges";
import { noShowRebooking } from "./noshow-rebooking";
import { ownNumberOutcome } from "./own-number-outcome";
import { ping } from "./ping";
import { postVisit } from "./post-visit";
import { processMessage } from "./process-message";
import { releaseHolds } from "./release-holds";

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
];
