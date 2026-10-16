# Day 9, Dev 3: request for the two staging rehearsals (16 Oct 2026)

To: Raja, Dev 1, Dev 2. From: Dev 3. Status: **a request. Nothing below has been provided, and no rehearsal has run.**

The Day 8 exit test says the section 15 demo checklist passes **twice in a row, each run by a different developer, with no manual database edits**. The procedure is `docs/demo-script.md`. Dev 3 cannot start without the items below.

## What Dev 3 needs, and from whom

| # | Need | Who provides it | Notes |
|---|---|---|---|
| 1 | The staging web URL and API URL, and confirmation they run the latest green `main` (`GET <API>/api/health` shows the commit) | Raja / Dev 2 | |
| 2 | An authorized test account for Dev 3, with its role stated | Raja | Owner, plus a second account as admin or staff to check roles |
| 3 | Two approved test businesses, for tenant isolation | Raja / Dev 2 | Each with its own members; a second business must see none of the first one's data |
| 4 | A Meta-approved **test number** and a recipient list that Meta allows | Raja / Meta | The fallback in the task list: if the test number blocks a recipient or the token expires, regenerate the token and update the connection row |
| 5 | Embedded Signup configuration (`NEXT_PUBLIC_META_APP_ID`, `NEXT_PUBLIC_META_ES_CONFIG_ID`) | Raja | **Names only; no values in tickets or chat.** Embedded Signup also needs Meta App Review |
| 6 | Confirmation that migrations 0047 to 0052 and the seed are applied on staging | Dev 2 | The frontend relies on them |
| 7 | The environment variables the frontend needs on Vercel: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_DEMO_WHATSAPP_NUMBER`, `NEXT_PUBLIC_SETUP_CALL_URL` | Dev 2 / Raja | Check the names are set; not their values |
| 8 | Two developers free in the same window, one per run, plus an observer taking notes | Raja | Dev 1 and Dev 2 are the natural pair |
| 9 | A knowledge base for the real-estate demo business | Owner of the demo | The seed has none (demo script, section 1) |
| 10 | Spend limits checked on the Anthropic Console, and free-tier headroom on Inngest and Supabase | Dev 2 / Raja | The exit test asks for this before the demo |

## Rules for the window

- **No real customer notifications, charges or data.** Use test phone numbers and PayU test mode only.
- **No manual database edits** during a run: that is the exit criterion.
- **No destructive operations** on the staging project (no `db reset --linked`). Supabase holds real sign-ups; treat it as production data.
- Record each run: date, who ran it, the commit, each step's result, and each defect with a proposed priority (P0, P1, P2).
- If a P0 appears late, Day 9 morning is reserved for P0 fixes only; the demo runs on the last green `main`.

## What Dev 3 will check in each run

Onboarding with a fresh tenant (300 credits, countdown, test link), Home numbers, Inbox takeover and Return to AI, Leads and Calendar, billing in PayU test mode, the connection screen, team invites, and role limits for an owner, an admin and staff. It will also record what the mocked tests could not show: real RLS, Realtime, signed media URLs and webhook delivery.

## Open questions

- Who is the staging owner who can answer 1 and 6?
- A proposed time window for both runs: **Raja to set it.**
