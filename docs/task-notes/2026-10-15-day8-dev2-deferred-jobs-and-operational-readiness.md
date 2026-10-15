# 15 Oct (Dev 2): Day 8 Deferred Jobs and Operational Readiness

Owner: Dev 2 (Shaaz). Audience: Nitisha (Dev 1), Dhatri (Dev 3), Raja.

Status of the six tasks from the **Day 8 Task List (Dev 2: deferred jobs and operational readiness)**.

---

## 1. Finish deferred P1 jobs
All four background jobs are implemented and verified with passing test suites:
- **Daily Agenda (`backend/src/inngest/daily-agenda.ts`, `backend/src/booking/daily-agenda.ts`)**: Summarises staff member's confirmed bookings for the day. (4/4 tests pass in `daily-agenda.test.ts`).
- **No-Show Rebooking (`backend/src/inngest/noshow-rebooking.ts`, `backend/src/booking/no-show.ts`)**: Invites customers to rebook when marked no-show. (5/5 tests pass in `noshow-rebooking.test.ts`).
- **Handoff SLA Escalation (`backend/src/inngest/handoff-sla.ts`)**: Alerts staff and owners if human takeover is pending past SLA threshold. (14/14 tests pass in `handoff-sla.test.ts`).
- **Own-Number Outcome (`backend/src/inngest/own-number-outcome.ts`)**: Reconciles message statuses and records delivery outcomes for non-platform connections. (4/4 tests pass in `own-number-outcome.test.ts`).

---

## 2. Google Reconnect Flow (7-day Testing-mode token expiry)
- **Token Refresh & Reconnect Marking**: `getGoogleAccessToken` in `backend/src/booking/google-calendar.ts` catches `invalid_grant` from Google's token endpoint (which occurs when access tokens expire after 7 days in Google Cloud OAuth "Testing" mode or when permissions are revoked).
- **Status update**: Automatically marks `google_calendar_connections.status = "needs_reconnect"` with `last_error = "Google refused the saved access (revoked or expired). Reconnect to resume syncing."`.
- **Dashboard UX**: When `needs_reconnect`, `features/settings/google-calendar.ts` renders the "Reconnect" button, and slot queries ignore the connection safely without breaking the booking engine.
- **Tests**: Verified in `backend/src/booking/google-calendar.test.ts` (10/10 pass).

---

## 3. Sentry Alert Rules
- **Error Pipeline (`backend/src/lib/report.ts`)**: Directly posts envelopes to Sentry with strict payload redaction (no customer names, PII, or message text).
- **Tagging**:
  - `kind: "api_error"`: Route 500s (`route`, `method`).
  - `kind: "job_failed"`: Inngest terminal job failures via `inngest/report-failed-jobs.ts`.
  - `kind: "connection_health"`: Meta health check degradation.
- **Alert Rules documented in `docs/environments.md`**:
  1. Failed jobs (`kind:job_failed`, `function:pakka-agent-process-message` > 3 in 10m).
  2. Webhook errors (`kind:api_error` on `/api/webhooks/whatsapp` or `/api/webhooks/payu` > 5 in 5m).
  3. API 500 errors (`kind:api_error` > 20 in 10m or new issue).
  4. Connection-health failures (`kind:connection_health`, any event).
- **Tests**: Verified in `src/lib/report.test.ts`, `src/inngest/report-failed-jobs.test.ts`, and `src/server/report-wiring.test.ts` (28/28 pass).

---

## 4. Webhook Burst Load-test Script
- **CLI Script (`backend/src/scripts/webhook-burst.ts`, `backend/src/scripts/webhook-burst-lib.ts`)**:
  - Callable via `pnpm --filter @pakka/backend webhook:burst -- <API origin> [total=200] [concurrency=20]`.
  - Sends cryptographically signed WhatsApp payload batches for an unowned phone number.
  - Exits with 0 only if 100% of responses return HTTP 200 and $p95 \le 2000\text{ ms}$.
- **Tests**: Verified in `backend/src/scripts/webhook-burst-lib.test.ts` (5/5 pass).

---

## 5. Backup and Restore Dry Run
- **Procedure**: Outlined in `docs/production-checklist.md` section 9.
- **Verification steps**:
  1. Export staging Supabase database dump or snapshot.
  2. Restore into an isolated scratch project.
  3. Run `supabase migration list --linked` and table count comparisons.
  4. Verify that encryption keys correctly decrypt sample access tokens and webhook secrets.

---

## 6. Cost-per-Credit & Trial-to-Paid Metrics (P1)
- **Database (`supabase/migrations/0051_admin_metrics.sql`)**: Function `public.admin_metrics(window_end)` aggregates 7-day and 30-day stats for real businesses:
  - `credits_spent`: WhatsApp replies and templates.
  - `ai_cost_usd` & `ai_calls`: AI spend ledger.
  - `trials_started` & `trials_paid`: Conversion counts.
- **Backend Route (`GET /api/admin/metrics`)**: Handled by `backend/src/billing/metrics.ts`, registered in `backend/src/server/routes.ts`.
- **Staging status**: Migration 0051 is fully applied to linked staging Supabase.
- **Tests**: Verified in `backend/src/billing/metrics.test.ts` (3/3 pass) and `supabase/tests/admin_metrics.test.sql`.
