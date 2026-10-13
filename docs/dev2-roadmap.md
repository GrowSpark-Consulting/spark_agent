# Dev 2 — Booking, jobs and money

What this area owns, what each milestone delivers, which dashboard screens depend on it, and the
open questions between the specs (`docs/handover.md`, Production Blueprint) and the dashboard designs.
Reviewer for this area: Dev 3.

## What I own

| Module | Contract | Lives in |
|---|---|---|
| 4. Booking and slot engine | `findSlots`, `holdSlot`, `confirmBooking`, `rescheduleBooking`, `cancelBooking`; Google Calendar sync | `backend/src/booking` |
| 5. Notifications and jobs | `notify.send()` (the only way out), every Inngest function except `process-message` | `backend/src/notify`, `backend/src/inngest` |
| 7. Feature flags and credits | `isEnabled`, `spendCredits` → `spend_credits()` SQL, `getBalance` | `backend/src/features`, `backend/src/billing` |
| 8. Billing, trial, demo number | PayU auto-debit mandates, one-time payments and webhooks (decision 20; was Razorpay), trial grant and lifecycle, route codes | `backend/src/billing` |
| Shared | Repo, CI, environments, migrations tooling | `.github`, `supabase`, `docs/environments.md` |

## Milestones

| Milestone | My tasks | Done when |
|---|---|---|
| Day 0 | Repo + branch protection + CI; Supabase local + staging; Inngest dev server; Vercel project; `api.*` rewrite + DNS; password manager; `.env.example`; `CLAUDE.md`; `docs/handover.md` | A fresh clone runs on each machine |
| M0 | `0001_init.sql` with RLS on every table and a cross-tenant read test; seed with one demo tenant per pack; Inngest wired on staging | Message to the test number lands in `messages` |
| M1 | `notify.send`; `spend_credits()` with row lock, soonest-expiring-first, never below zero; `isEnabled` with 60 s cache; credit cost constants mirrored in `features.credit_cost` | Agent answers on WhatsApp within 10 s |
| M2 | Slot engine (hours, duration, buffer, lead time, free/busy, pincode); 10-minute holds; exclusion constraint; Google OAuth + sync; `release-holds` cron | Booking shows in Google Calendar and dashboard |
| M3 | `booking-reminders`, `post-visit`, `lead-nudges`, `daily-agenda`, `handoff-sla`, `own-number-outcome`; templates submitted | 24 h / 2 h reminders with working buttons |
| M4 | `PATCH /api/features/:key` with plan checks; outbound webhooks (signed, Pro); audit log everywhere | Business sets its own toggles and goes live |
| M5 | Plans seed + PayU auto-debit plans, annual plans, top-ups, setup fee; renewal grants and rollover; `trial-lifecycle`; `credit-alerts`; zero-credit fallback | Stranger → demo → trial → pays → gets credits |
| M7 | `date_range` and `callback` booking kinds; event-relative reminder scheduler replacing fixed reminder jobs | YatraKraft runs a week on the travel pack |

## What the dashboard designs need from this area

From the onboarding/dashboard prototype (Home, Calendar, Billing, Settings, Team, Templates screens):

| Screen | Needs |
|---|---|
| Home | Credit meter (left / total, resets on renewal date), trial countdown, low-credit and paused banners, credits shown as leads (≈ 15 credits a lead) |
| Features | Toggle list from `features` × plan, locked items with Upgrade, "≈ N credits/month" per toggle from the last 30 days, reminder timing choice (48 / 24 / 12 / 6 h) stored in `tenant_features.settings` |
| Top-up modal | Packs, pay with UPI (PayU one-time payment), balance updates and Maya resumes when credits arrive |
| Upgrade modal | Plan comparison, upgrade starts today with extra credits for the rest of the month |
| Billing | Plan, next bill + GST, daily usage chart, credit history (ledger rows), top-up packs, monthly/yearly switch, downgrade from next renewal, ₹4,999 setup add-on, GST invoices |
| Calendar | Day/week per staff, statuses confirmed / held / completed / no-show, reschedule (re-sends time and resets reminders), mark visited / no-show, cancel, undo |
| Settings → Booking | Services (length, who, where); rules: gap between bookings, earliest booking, book-ahead window, hold time; Google Calendar connected / disconnect |
| Settings → Notifications | Event × channel matrix (WhatsApp / email / dashboard) for SLA, hot lead, booking, handover, low credits, daily agenda, weekly report; quiet hours with hot leads still allowed |
| Settings → Data | Chat retention 6 / 12 / 24 months; STOP opt-out count |
| Team | Seat count against plan limit (enforced in `POST /api/team/invite`) |

## Open questions to settle with Raja and Dev 3

The prototype's numbers predate v1.0. The Handover says pricing is already decided, so the specs win
unless Raja says otherwise.

| Topic | Specs (v1.0) | Prototype |
|---|---|---|
| Plans | Starter ₹2,499 / 1,500 cr · Growth ₹5,999 / 5,000 · Pro ₹12,999 / 15,000 | ₹1,999 / 1,000 · ₹4,999 / 3,000 · ₹9,999 / 8,000 |
| Trial credits | 300 | 150 |
| Top-ups | 1,000 credits for ₹1,199 (₹1.20 a credit) | 500 / 1,000 / 2,000 at ₹2.40 a credit |
| Marketing templates | 1 credit (**confirmed by Raja, 9 Oct**, inside or outside the 24-hour window) | 2 credits |
| Pro seats | Unlimited (999) | 15 |
| Auto top-up pack | Not specified | 500 credits for ₹1,199 |

Designed but not yet in the specs (each needs a decision and, where noted, schema):

- Prorated credits on upgrade mid-cycle; downgrades and monthly↔yearly switches at next renewal.
- Notification channel matrix, quiet hours and a Monday weekly report (new job, email via Resend).
- Book-ahead window per tenant (only buffer and minimum lead time are in module 4).
- Chat retention setting and a deletion job.
- GST invoices: our own numbering (PayU has no invoices) (`INV-YYMM-NNNN` in the prototype).
- Zero credits: the Blueprint sends one holding message and moves the lead to Human; the prototype
  says "new chats go to your inbox". Same intent, but `notify.send` needs one exact behaviour.
