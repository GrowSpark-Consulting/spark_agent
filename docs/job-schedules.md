# Background Jobs and Scheduled Tasks

Owner: Dev 2. Covers every Inngest function in `backend/src/inngest/functions.ts` served via `POST /api/inngest` on Railway.

## Overview

The backend uses [Inngest](https://www.inngest.com) for durable execution, cron scheduling, and multi-step retries. Every function is declared with idempotent steps (`step.run`), explicit sleep delays (`step.sleep` / `step.sleepUntil`), and deduplication / idempotency keys passed to `notify.send()` or database writes.

There are **27 registered Inngest functions** in `backend/src/inngest/functions.ts`.

---

## 1. Cron-Scheduled Jobs

Schedules as the code has them (`triggers: [{ cron }]` in each file). Times are UTC unless the cron starts with `TZ=`.

| Function ID | Cron | When | Idle cost per run* | Purpose |
|---|---|---|---|---|
| `daily-agenda` | `30 * * * *` | Hourly at :30 | 1 (ends before any step unless a business is at 8:00) | Each live business in the hour after 8:00 local time (8:00 sharp in India) gets today's bookings, sent to each owner with an alert number (`daily_agenda`, Growth and Pro). Key `daily_agenda:<tenant>:<owner>:<local date>`. |
| `kb-sweep` | `0 * * * *` | Hourly | 1 (no steps) | Fails documents still `processing` after 30 minutes. |
| `outbound-webhooks` | `5 * * * *` | Hourly at :05 | 1 (ends before any step when nothing is pending) | Claims and sends due outbound webhook deliveries (0050). Retries wait for the next hourly run at the earliest. |
| `trial-lifecycle-sweep` | `TZ=Asia/Kolkata 15 */2 * * *` | Every 2 hours at :15, India | ~3 | Pauses trials that ended with no plan; sends the day 3, 5, 6 and 7 notices between 09:00 and 20:00 India time. |
| `billing-renewals` | `TZ=Asia/Kolkata 0 6 * * *` | Daily 06:00 India | ~4 | PayU renewals: pre-debit notices, charges, lapses. |
| `unpaid-trial-cleanup` | `TZ=Asia/Kolkata 30 3 * * *` | Daily 03:30 India | ~2 | Warns from day 23 and deletes a business 30 days after its trial ended unpaid (0048). |
| `token-expiry` | `0 4 * * *` | Daily 04:00 | ~3 | Warns about WhatsApp tokens close to expiry. |
| `connection-health` | `30 1 * * *` | Daily 01:30 | ~3, plus ~2 per active connection | Fans out one `connection-health-check` run per active connection. |

\* Executions when there is nothing to do: the run, plus each step it reaches. Not on Inngest: **lapsed booking holds** are
marked `expired` every minute by Postgres itself (`pg_cron` job `release-expired-holds`, migration 0053); it was the
`release-holds` Inngest function until 22 Oct.

### Idle usage budget (Inngest free plan: 50,000 executions a month)

At most about **150 executions a day with no customers**, so the month's remainder is left for messages. The schedules above
come to about **120 a day idle**: daily-agenda 24, kb-sweep 24, outbound-webhooks 24, trial sweep ~36, the four daily jobs
~12, plus ~2 per active WhatsApp connection. Before 22 Oct it was about 6,300 a day (two every-minute crons), which
used the month's 50,000 in about 14 days.

Rules for a new scheduled job:
- Nothing more often than hourly without a reason written next to the cron.
- An idle run must end before its first step: check cheaply whether there is any work (a read outside `step.run`), and
  return. Base the check on the run's scheduled time (`ctx.event.ts`), not the clock, so a replay judges the same moment.
- Work that is only a database update belongs in `pg_cron` (a migration), not on Inngest.
- Check the Inngest dashboard's Functions page for the runs a day after any change.

One app only: the Inngest **Apps** page must list exactly one synced URL,
`https://sparkagent-production-dc1a.up.railway.app/api/inngest`. Every other synced app (an old Railway domain, a Vercel URL
from the Vercel Marketplace integration, a tunnel) runs every cron again and doubles the cost.

---|---|---|---|---|
| `release-holds` | `* * * * *` (Every 1m) | UTC | None | Releases booking holds where `status = 'held'` and `held_until < now()`. Resets status to `expired` so slot engine releases the slot. |
| `daily-agenda` | `*/15 * * * *` (Every 15m) | Tenant TZ | `daily_agenda` (Growth & Pro) | Checks live businesses where local time is 08:00–08:15. Summarises today's confirmed bookings and sends WhatsApp briefing to owners/staff. Idempotency key: `daily_agenda:<tenantId>:<userId>:<YYYY-MM-DD>`. |
| `billing-renewals` | `0 6 * * *` (Daily 06:00) | `Asia/Kolkata` | None | Runs PayU auto-debit renewals outside NPCI peak hours. Steps: send pre-debit notices (T-24h), charge due mandates, reconcile pending charges, grant annual monthly credits, expire lapsed subscriptions. |
| `trial-lifecycle-sweep` | `15 * * * *` (Hourly at :15) | `Asia/Kolkata` | None | Runs single-concurrency sweep. Expires trials past day 14 without active plan; dispatches automated WhatsApp reminder notices on days 3, 5, 6, and 7 between 09:00 and 20:00 IST. |
| `connection-health-check` | `0 6 * * *` (Daily 06:00) | UTC | None | Validates Meta WhatsApp Business Account (WABA) tokens and phone number status for all active connections. Reports degraded connections to Sentry (`kind: "connection_health"`). |
| `token-expiry` | `0 * * * *` (Hourly) | UTC | None | Scans Google Calendar OAuth tokens. Flags connections requiring re-authentication within 7 days (Google Cloud Testing mode). |
| `unpaid-trial-cleanup` | `0 2 * * *` (Daily 02:00) | UTC | None | Enforces DPDP compliance. Deletes customer contact data, messages, and vectors for trial accounts expired > 14 days without subscription. |
| `kb-sweep` | `*/15 * * * *` (Every 15m) | UTC | None | Sweeps stuck or un-embedded knowledge base documents, retrying Voyage-4 embedding generation. |

---

## 2. Event-Triggered Asynchronous Workflows

| Function ID | Trigger Event | Cancellation / Timeout | Idempotency Key / Guard | Purpose & Workflow |
|---|---|---|---|---|
| `process-message` | `whatsapp/message.received` | Debounce 2.5s on sender | `msg:<wamid>` | Core agent loop: verifies customer consent, matches knowledge base embeddings, generates Claude 3.5 Sonnet reply, holds/confirms slots, and deducts 1 credit via `spend_credits()`. |
| `booking-reminders` | `booking.confirmed` | `cancelOn: [booking.changed]` matching `bookingId` | `${kind}:${bookingId}:${start}` | Schedules multi-step sleeps for 24-hour and 2-hour WhatsApp reminder messages with interactive "Confirm" and "Reschedule" buttons. |
| `handoff-sla` | `handoff.opened` | None (sleeps `sla_minutes`) | `handoff_sla:${handoffId}:${userId}` | Waits for business SLA window (default 15 mins). If chat is still unassigned or in `human` mode with no human reply, escalates alert to business owner. |
| `noshow-rebooking` | `booking.no_show` | None | `noshow_rebook:${bookingId}` | Automatically dispatches polite WhatsApp rebooking follow-up message with quick-booking button when staff marks booking as no-show. |
| `post-visit` | `booking.completed` | None (sleeps 2h after visit) | `post_visit:${bookingId}` | Sends post-appointment feedback / review request to customer on WhatsApp. |
| `lead-nudges` | `lead.inactive` | Cancelled if customer messages | `nudge:${conversationId}:${step}` | Sends gentle re-engagement prompts to qualified leads who stopped replying mid-qualification. |
| `google-calendar-sync` | `booking.created`, `booking.rescheduled`, `booking.cancelled` | None | `gcal_sync:${bookingId}:${version}` | Two-way synchronization of confirmed bookings and buffer periods to staff member's connected Google Calendar. Catches `invalid_grant` and triggers `needs_reconnect`. |
| `trial-lifecycle` | `tenant.trial_started` | None | `trial_started:<tenantId>` | Dispatches Day-0 onboarding welcome WhatsApp notice to new business owner with starter guidance. |
| `handoff-alert` | `handoff.alert` | None | `alert:${handoffId}:${userId}` | Immediate WhatsApp notification to on-duty staff when conversation requires human intervention or sensitive inquiry. |
| `credit-alerts` | `billing.credits_low` | Rate-limited (1 per 24h) | `credit_alert:${tenantId}:${tier}` | Notifies owner when available balance drops below 50 leads or 15% threshold; prompts top-up pack. |
| `event-alerts` | `alert.event` | None | `event_alert:${eventId}` | Dispatches urgent system notifications to owners/staff. |
| `media-download` | `whatsapp.media_received` | Retryable step | `media_download:${mediaId}` | Fetches binary media (photos, voice notes, PDFs) from Meta Cloud API and persists into Supabase Storage `message-media` bucket. |
| `own-number-outcome` | `handoff.own_number` | None | `handoff_own_number:${handoffId}` | Tracks staff takeover to personal WhatsApp (`wa.me`); monitors conversation outcome and delivery reconciliation. |
| `phone-reply-return` | `phone.reply_returned` | None | `reply_return:${conversationId}` | Returns conversation control from staff back to AI agent once staff member marks thread resolved. |
| `report-failed-jobs` | `inngest/function.failed` | None | Sentry event ID | Terminal failure handler: catches unrecoverable job errors and transmits redacted Sentry envelopes (`kind: "job_failed"`). |
| `ping` | `system/ping` | None | None | Health check and latency testing endpoint. |
| `demo-reply` | `demo.message_received` | None | `demo_reply:${wamid}` | Orchestrates sandboxed demo experience on shared WhatsApp number for prospective customers. |

---

## 3. Operational Rules for Inngest

1. **Deploy Synchronization:**
   - Inngest must be re-synced after adding or renaming any function:
     ```bash
     curl -X PUT https://api.pakkaagent.in/api/inngest
     ```
2. **Step Idempotency:**
   - All side effects (WhatsApp messages, credit deductions, database writes) must occur inside `step.run` with deterministic naming.
   - Code outside `step.run` re-executes on every retry and replay.
3. **No PII in Inngest Payloads:**
   - Events passed to Inngest must contain only IDs (`tenantId`, `bookingId`, `conversationId`, `handoffId`). Never pass customer names, phone numbers, or raw message text in event payloads.
