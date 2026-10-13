# Dev 3: Day 6 audit and completion (13 Oct 2026)

Branch `dev3/day6-completion`, made from `origin/main` at `838ca77` and fast-forwarded to `5fefa4f` on 13 Oct (see "Post-merge update") (local `main` was 4 commits behind: #140, #141, #142, #145). Working tree was clean at the start. Nothing committed, pushed, merged, migrated or deployed. No backend, migration or shared-type file changed.

Evidence is unit tests and mocked Playwright only. No staging, real Supabase, Meta, Razorpay, Realtime server or Docker run.

## Baseline and the "#139 regression"

The regression reported against PR #139 is not described anywhere in the repo (no report, matrix row or issue text names it), so it could not be reproduced from a description. On a clean checkout of `origin/main` the checks were: `tsc --noEmit` exit 0, `eslint .` exit 0 (1 existing warning, `leads-board.tsx:155`), `vitest run` 55 files, 942 passed, 4 todo. Nothing failed, so no #139 regression is confirmed. The one #139-era defect that did surface is in "Findings" below (a console 404 from a link to a page that did not exist). Ask whoever reported it for the failing command or screen.

## Backend contract audit (what is actually on `origin/main`)

| Contract named in the task | On `routes.ts`? |
|---|---|
| `GET /api/dashboard/summary`, `GET /api/billing/balance` | Yes (#140) |
| `GET /api/conversations/:id/templates` | Yes (#141) |
| `GET /api/features` (`handoff_own_number` row) | Yes |
| `POST /api/billing/checkout`, `/topup`, `/change-plan`, `POST /api/webhooks/razorpay`, invoices | **No** (Dev 2) |
| `POST /api/admin/whatsapp/connect-link`, `GET /api/connect-links/:token`, `POST /api/onboarding/whatsapp/embedded-signup` | **No**: only the token helpers (`connect-link-token.ts`) and the contract doc exist (Dev 1) |
| `PATCH /api/agent/settings` | No (not wanted; writes stay RLS-backed) |

## Task matrix

| Task | Status | Evidence |
|---|---|---|
| A. Home from summary + balance | DONE (mocked) | Shared `AccountStatus` / `DashboardSummary` from `@pakka/types`; all four `aiPausedReason` values worded; trial countdown; hot leads and today's bookings; loading, empty, error, retry. `home-api.test.ts`, `home-overview.spec.ts` |
| B. Realtime | PARTIALLY DONE / live BLOCKED | Subscription lifecycle, cleanup, tenant filter, burst coalescing, reconnect catch-up, move to another business already have deterministic tests (`table-changes.test.ts`, `published-tables.test.ts` reads the migrations, `realtime-refresh.spec.ts`). No change needed. **Live verification BLOCKED**: no staging URL or credentials in this checkout. Owner: ops / Dev 2 |
| C. `?chat=` deep link | DONE (mocked) | Opening, older-than-200 chats, refresh and invalid-shape ids already worked. Added: a valid id that is not this business's (or deleted) now says so with "Show my chats"; a failed by-id read says so with Try again. 4 new specs in `inbox.spec.ts` |
| D. Own-number entitlement | DONE (mocked) | Team: "How you take over chats" reads the `handoff_own_number` row. locked + `requiredPlan` shows the plan and a link; locked without a plan, off, disabled and a missing row each show their reason. No plan name is read. Return-to-AI not built (Raja). `takeover-pref.test.ts`, `team-takeover.spec.ts` |
| E. Template picker via server | DONE (mocked) | Loads `GET /api/conversations/:id/templates`; `connectionId: null` state; empty; loading; error with Try again; name, language, category, body, variable inputs; sends `{ template: { name, language, params } }` with double-press guard. `template-reply.test.ts`, `inbox-template-reply.spec.ts` |
| F. Staff permissions (0028) | DONE (mocked) | Booking setup, services, resources and hours were already role-gated (`canWrite`) with a read-only notice. Added: a row-level-security refusal (`42501`) is worded "Only an owner or admin can change this" and is not retryable; zero-row updates on business settings point at the role. Owner/admin still write (existing specs). No Business-name/timezone or catalog screen exists to gate |
| G. Booking service setting | DONE (mocked) | Existed on Booking setup (select, explicit "No choice", stale warning, explanation, UUID check, RLS write). Added: a choice that is not an active service is refused before the write (`isSelectableChoice`). There is no separate Agent settings screen in the app (`features/agent` is the prototype on sample data) |
| H. Day 5 screens | DONE (mocked), Home done above | Audited, unchanged. See `dev-3-day5-audit.md` |
| I. Billing | PARTIALLY DONE | New `/dashboard/billing` (owner, admin; staff are told no): plan and status, credits, plans from the `plans` catalogue compared by price, credit history from `credit_ledger` under RLS, trial countdown, paused reason, loading/empty/error/retry. **BLOCKED**: pay, upgrade/downgrade, top-up, invoices, Razorpay (no routes; Dev 2). The screen has no such buttons and says so |
| J. Onboarding and connect | PARTIALLY DONE / BLOCKED | New public `/connect/:token`: token shape check, link read, expired/invalid, switched-off, rate-limited, retry, Embedded Signup run and exchange with `connectToken`, setup-call fallback (optional `NEXT_PUBLIC_SETUP_CALL_URL`). The wizard keeps its labelled preview and manual path. **BLOCKED**: the three Dev 1 routes are not on the API; "Book a setup call" as a wizard method and a live status panel need those routes and a URL decision (Raja). Success path unverified end to end |
| K. Day 3–4 regression | Unchanged, passing | Full suite below |

## Files changed

Home: `features/home/home-api.ts`, `home-overview.tsx` (+ tests, `home-overview.spec.ts`), dashboard `page.tsx` (time zone). Inbox: `template-reply.ts`, `template-reply-panel.tsx`, `inbox-screen.tsx`, `conversation-list.tsx` (+ tests, `inbox-template-reply.spec.ts`, `inbox.spec.ts`). Team: `takeover-pref.ts`, `takeover-section.tsx`, `team-screen.tsx` (+ tests, `team-takeover.spec.ts`, `team.spec.ts`, `mock-supabase.mjs` takeoverPref). Permissions: `lib/errors.ts`, `booking-service.ts`, `booking-service-section.tsx`, `resources-data.ts` (+ tests). Billing: `features/billing/billing-data.ts`, `billing-screen.tsx`, `app/(dashboard)/dashboard/(app)/billing/page.tsx`, nav item (+ tests, `billing.spec.ts`). Connect: `features/connect/*`, `app/connect/layout.tsx`, `app/connect/[token]/page.tsx`, `lib/api/client.ts` (`anonymous` option), `lib/env.ts` (`setupCallUrl`), `.env.example` (+ tests, `connect.spec.ts`). `lib/api/backend-routes.test.ts` (drift guard).

Deliberate behaviour change: `42501` used to map to a retryable "couldn't load" message; two older unit tests were updated to the new forbidden wording.

## Findings

1. Links to `/dashboard/billing` (Home banners, Team upgrade) 404-prefetched until the page existed and tripped the console guard in 25 tests; fixed by building the page.
2. `lib/api/backend-routes.test.ts` "every frontend file that calls the API" timed out once at 5 s when run alongside the whole suite (passes alone, 7 tests, and in the full run).

## Blockers

| Dependency | Owner |
|---|---|
| `/api/billing/checkout`, `/topup`, `/change-plan`, Razorpay webhook, invoice listing, daily usage | Dev 2 |
| `/api/admin/whatsapp/connect-link`, `/api/connect-links/:token`, `/api/onboarding/whatsapp/embedded-signup`, `EMBEDDED_SIGNUP_ENABLED` | Dev 1 / Raja |
| Setup-call URL; whether `ask` also needs the own-number entitlement (assumed yes); return own-number chats to AI | Raja |
| Staging access for Realtime, tenant isolation, live Meta, Razorpay test mode | ops |

## Verification

| Check | Result |
|---|---|
| Baseline, clean `origin/main` | tsc 0; eslint 0 (1 warning); vitest 55 files, 942 passed, 4 todo |
| After changes | tsc exit 0; eslint exit 0 (same 1 warning); vitest 58 files, 991 passed, 4 todo |
| Playwright, first batch (9 specs, 3 widths) | 330 passed, 25 failed, 3 skipped: all traced to the missing billing page and test mistakes of mine, fixed |
| Playwright, second batch (billing, connect, home, template picker, team takeover) | 157 passed, 0 failed |
| Playwright, full suite (before the last three fixes) | 1212 passed, 9 failed, 13 skipped (17.0 min): 3 navigation (new Billing link; fixed), 3 inbox linked-chat test (fixed), 3 leads |
| Playwright, reruns after those fixes | navigation, billing, linked-chat test, leads-paging: passed at 1 worker. The full suite was NOT rerun end to end after the final fixes |
| Leads specs | `leads-filters.spec.ts:66` (read count 2, expected 1) also fails on a clean `origin/main` (desktop and tablet, 1 worker), so it predates this work; `leads-paging.spec.ts:60` failed at 2 workers and passed at 1. Likely candidates for the reported #139 regression. Not changed here (Leads board is not in the Day 6 scope); `leads-board.tsx:155` has a `react-hooks/exhaustive-deps` warning on the same code path |
| Backend tests, `pnpm db:test` (Docker) | not run |
| Staging / live (Meta, Razorpay, Realtime, tenant isolation) | not run, unavailable |

## Post-merge update (13 Oct, after fast-forward to `5fefa4f`)

Git: branch `dev3/day6-completion`, HEAD `5fefa4f` = `origin/main` (0 ahead, 0 behind after `git fetch`). 48 uncommitted files (modified and new). Nothing committed, nothing pushed, nothing stashed (a stash was used twice to run clean-`main` baselines and was popped each time with no conflicts).

### The five new commits and their frontend effect

| PR | Change | Frontend effect |
|---|---|---|
| #147 | `AccountStatus.aiPausedReason` gains `whatsapp_not_connected` | Shared enum broke my exhaustive wording (1 tsc error, 1 unit failure). Fixed: Home and Billing word it and link to `/dashboard/whatsapp`. Unit test and Home and Billing specs cover it |
| #143 (0032) | Replies and alerts for routed trials go through the platform number; the chat templates route now asks `notify_target` and reads templates by connection | None needed: the picker uses whatever `connectionId` and templates the server returns |
| #144 (0033) | One free trial per WhatsApp number | See Task A |
| #148 | Daily health check can set a manual number to `failed` on its own; 7-day token-expiry warning | See Task B |
| #146 | `saveSubmittedTemplate` stores a template Meta accepted | None |

### Task status

| Task | Status | Evidence |
|---|---|---|
| 1. Reconcile main | DONE | Types, copy and links checked; `whatsapp_not_connected` verified present in `AI_PAUSED_REASONS` and in both screens |
| A. Trial refusal message | BLOCKED, no frontend surface | `claim_trial_phone` runs on the WhatsApp routing step for a message with a TRIAL code, using the sender WhatsApp names; the number typed during onboarding is "never claimed" (`billing/trial-phone.ts`). `POST /api/onboarding/trial` has no refusal status (`StartTrialResult`: ready, has_business, unavailable, invalid, failed). The refusal reaches the person as a WhatsApp reply, and the routing is not wired yet (`claimTrialPhoneNotBuilt` returns "claimed", `demo/route.ts:57`). Nothing invented. Owner: Dev 1 (routing, replies in PR 1b) and Dev 2 |
| B. Connection-health UI | DONE (mocked) | Status, quality rating, messaging limit, last-check time and the six checks were already shown. Added: the full WhatsApp screen re-reads on a timer (10 s while pending or validating, 60 s otherwise, paused when the tab is hidden, none when every number is disconnected) and when the tab is shown again, because connections are not on Realtime (contract open decision 5). A failed manual number gets a note about the daily check. Recheck and Disconnect unchanged and still gated by role, method and status. Token expiry is not in `whatsapp_connections_public`, so it is not shown. No secrets rendered (`expectNoSecrets` in the specs) |
| C. Billing and assisted connect | BLOCKED, re-verified | `routes.ts` at `5fefa4f`: only `/api/onboarding/trial`, `/api/billing/balance`, `/api/admin/whatsapp/manual`, `/api/webhooks/whatsapp` among billing, connect, onboarding and webhook paths. No checkout, top-up, change-plan, Razorpay webhook, invoices, connect-link, `connect-links/:token` or Embedded Signup. Screens unchanged: no pay buttons, plain "isn't switched on yet" text, `/connect/:token` reads a route that answers 404 today and shows the invalid-link state. Owners: Dev 2 (billing), Dev 1 (connect). Not yet confirmed with them |
| D. Setup-call fallback | PARTIALLY DONE | Unset state: the connect page says to reply to whoever sent the link (`connect.spec.ts`, 3 widths). `parseSetupCallUrl` unit-tested: accepts https only, rejects http, `javascript:`, blank and non-URLs. The configured link is not browser-tested because `NEXT_PUBLIC_*` is fixed at build time. Dependency: Raja supplies the URL; none was invented |

### Verification (commands run from `frontend/`, exit codes inspected)

| Check | Result |
|---|---|
| `next typegen` then `tsc --noEmit` | exit 0 |
| `eslint .` | exit 0, 1 existing warning (`leads-board.tsx:155`) |
| `vitest run` | 59 files, 996 passed, 4 todo |
| `playwright test --workers=2` (full suite) | 1231 passed, 5 failed, 13 skipped (18.6 min). Of the 5: 3 were my new Home-card test counting the wrong requests (fixed; whatsapp.spec rerun passes); 2 are `leads-paging.spec.ts:60` on tablet and mobile |
| Reruns after the test fix: whatsapp, leads-paging, leads-filters | 140 passed, 2 failed (the same leads-paging pair) |
| Clean `origin/main` (stash), `leads-paging` + `leads-filters`, 2 workers | 47 passed, 2 failed: the same leads-paging tablet and mobile failures |

The full suite was not run again after the one-line test fix; the affected spec file was.

### Failures: confirmed regressions versus pre-existing

- **No regression caused by this branch is known.**
- `leads-paging.spec.ts:60` (tablet, mobile): fails identically on clean `origin/main` at 2 workers; passes at 1 worker and on desktop. Pre-existing. It expects two first-page reads (the read plus a catch-up after Realtime joins) and sees one.
- `leads-filters.spec.ts:66`: expects 1 extra read after the score filter, sees 2. Failed on clean `main` once (1 worker), passed in this full run. Pre-existing and intermittent. Same family: read counts depend on when the Realtime catch-up read lands. Not changed (Leads is out of scope); `leads-board.tsx:155` has an exhaustive-deps warning on that path.

### Still unverified (no access)

Backend tests and `pnpm db:test` (Docker off), migrations 0032 and 0033, staging Realtime and tenant isolation, live Meta and Embedded Signup, Razorpay test mode.

## Final verification (13 Oct, pre-PR)

Git: branch `dev3/day6-completion` at `5fefa4f`; `origin/main` is 1 commit ahead (`99bb5cf`, #149, backend and docs only: demo menu and replies, trial-phone check wired into routing). 31 modified and 17 untracked paths, all under `frontend/` or `docs/`; none staged, none committed, none pushed. No backend, migration, shared-type or `supabase/` file changed. A scan of the diff found no secrets, no generated files and no test artefacts. The three entries in `git stash list` predate this work and were not touched.

### Results (exit codes read)

| Command (from `frontend/`) | Exit | Result |
|---|---|---|
| `next typegen && tsc --noEmit` | 0 | clean |
| `eslint .` | 0 | 0 errors, 1 existing warning (`leads-board.tsx:155`) |
| `vitest run` | 0 | 59 files, 996 passed, 4 todo |
| `playwright test --workers=2` (full suite, current tree) | 1 | 1234 passed, 2 failed, 13 skipped (24.3 min) |

The two failures are `leads-paging.spec.ts:60` on tablet and mobile. Every other spec passed, including Home, Billing, WhatsApp, onboarding, template picker, inbox deep links, Team, connect-link, features, booking setup and navigation.

Classification: pre-existing. In the previous round the same two failures reproduced on a clean checkout of `5fefa4f` (diff stashed and restored) at 2 workers, and the spec passes at 1 worker and on desktop. That clean-baseline run was NOT repeated in this round (no stash was used, as instructed), and `origin/main` has since moved by a backend-only commit. `leads-filters.spec.ts:66` passed in this run; it failed once on clean `main` earlier and is intermittent. No Leads code was changed.

### Change since the last update

Onboarding "Try your assistant" now says there is one free trial per WhatsApp number and that the test chat will say so if the phone already used one (`step-try.tsx`, asserted in `onboarding.spec.ts`). Reason: PR #149 (Dev 1) wires `claimTrialPhone` into the demo routing, and the refusal is a WhatsApp reply to the sender. The wizard gets no API answer for it, so the wizard sets the expectation and claims nothing.

### Final review checklist

| Item | Evidence |
|---|---|
| `whatsapp_not_connected` on Home and Billing | `home-api.test.ts`; `home-overview.spec.ts` and `billing.spec.ts` (all widths) |
| WhatsApp status refreshes without Realtime | timer plus tab-return read; `auto-refresh.test.ts`; 3 `whatsapp.spec.ts` tests |
| `?chat=` opens the chat | `inbox.spec.ts` (open, refresh keeps it, unknown id, failed read) |
| Template picker | server list and `{ template: { name, language, params } }`; `template-reply.test.ts`, `inbox-template-reply.spec.ts` |
| Staff restrictions | existing `canWrite` gating plus permission wording; `errors.test.ts`; booking and team specs |
| Booking service validates active services | `isSelectableChoice`; `booking-service.test.ts`, `booking-service.spec.ts` |
| Billing and connect name missing backend work | `payments-unavailable` text; connect page invalid and switched-off states; `backend-routes.test.ts` awaiting list |
| Trial refusal | no frontend surface until an API carries it; expectation line only |
| Setup call unset | text fallback; `parseSetupCallUrl` tests. Configured link not browser-tested |

### Readiness

Ready for review as a Dev 3 frontend change set, with these conditions: it is one large uncommitted set and should be split (see the final message); the Billing screen and the `/connect/:token` page depend on routes that are not registered, so they are honest about it rather than working; nothing here proves a payment, a Meta connection, Realtime or tenant isolation.

### Explicitly unverified

Backend unit tests, `pnpm db:test`, migrations 0028 to 0033, the new `supabase/tests` (Docker off); staging Realtime and RLS; real Meta and Embedded Signup; Razorpay test mode; the configured setup-call link in a browser; the Tamil and Tanglish demo wording (unreviewed by a native speaker, per Dev 1).

## PR split: inspection before any branch is made (13 Oct)

State re-read: branch `dev3/day6-completion` at `5fefa4f`; `origin/main` is 1 commit ahead (#149). `git status --short --untracked-files=all` lists **52 paths: 33 modified and 19 untracked** (earlier figures of 48 and 50 counted untracked directories as one entry). None staged; no commits, pushes or stash changes made for the split. The 3 older stashes are untouched.

PR #149 touches only `backend/`, `docs/` and `supabase/` paths (20 files). No frontend file, test fixture or contract the frontend reads changed. Nothing to update on the frontend for it.

Overlaps found (one file serving more than one planned PR):

| File | Hunks and owners |
|---|---|
| `lib/api/backend-routes.test.ts` | 3 hunks: billing-data entry (Billing), template-route entry plus removal of its "not called yet" line (template picker), connect entries (Connect). Each must travel with its PR or the route guard fails |
| `tests/e2e/support/mock-supabase.mjs` | 4 hunks: `plans`/`credit_ledger` tables (Billing), `takeoverPref` (Team) |
| `features/settings/booking-service.ts` | 2 hunks: zero-row message (permission wording) and `isSelectableChoice` (booking-service validation) |
| `tests/e2e/app/navigation.spec.ts` | 3 hunks, all Billing |
| `components/onboarding/step-try.tsx` + `onboarding.spec.ts` | one-trial-per-number note: in none of the seven planned groups |

**Blocking dependency loop (Billing, Home, `home-api.ts`).**
- `features/billing/billing-screen.tsx` imports `daysLeft`, `meterShare` and `pausedNotice` from `features/home/home-api.ts`. `daysLeft` and `pausedNotice` are new in this work.
- `home-overview.tsx` and Team link to `/dashboard/billing`, so those PRs need the Billing page first (otherwise Next prefetch 404s fail about 25 specs).
- `home-api.ts` now parses the full shared `AccountStatus`/`DashboardSummary`. The base `home-overview.spec.ts` uses narrowed fixtures (no `status`, `plan`, `hotLeads`, ...), so it fails against the new parser; the new spec needs the new Home UI.

So "Billing before Home" cannot be satisfied with `home-api.ts` in the Home PR (Billing would not compile), and with `home-api.ts` in an earlier PR the Home end-to-end spec breaks at that commit. Resolved by merging Billing and Home into one PR (Option 1); see the next section.

## PR split result (13 Oct)

Eight local branches, stacked in this order, each based on the previous one and on `5fefa4f` (not rebased onto `origin/main`, which is one backend-only commit ahead). Built in a separate worktree (`C:/Users/PC/AgentX-split`) so the working tree on `dev3/day6-completion` was not touched. **All local; nothing pushed, no PR opened.** The original uncommitted work is still in the working tree on `dev3/day6-completion`, and the stack's final tree matches it file by file (all 52 paths, compared ignoring line endings).

| # | Branch | Commit | Files | Purpose | Needs |
|---|---|---|---|---|---|
| 1 | `dev3/pr1-shared-plumbing` | `e854e68` | 10 | permission-aware write errors (`lib/errors`), zero-row wording (`resources-data`, `booking-service`), `anonymous` API option, setup-call env setting, mock `plans`/`credit_ledger`/`takeoverPref` | none |
| 2 | `dev3/pr2-billing-home` | `b17c138` | 13 | Billing screen and nav item; Home on shared `AccountStatus`/`DashboardSummary` with every pause reason; route-guard entry | 1 |
| 3 | `dev3/pr3-template-picker` | `19b829b` | 5 | template picker reads `GET /api/conversations/:id/templates`; route-guard entry | stack order only |
| 4 | `dev3/pr4-inbox-deeplink-wa-refresh` | `f863077` | 8 | `?chat=` not-available and failed-read states; WhatsApp screen polling and daily-check note | stack order only |
| 5 | `dev3/pr5-team-takeover-booking-service` | `c156048` | 9 | own-number takeover choice from `handoff_own_number`; active-service check for the booking-service choice | 1 (mock), 2 (Billing link) |
| 6 | `dev3/pr6-connect-page` | `e02de1b` | 7 | `/connect/:token` page, awaiting backend; route-guard awaiting entries | 1 (anonymous calls, setup-call setting) |
| 7 | `dev3/pr7-onboarding-trial-note` | `acb3565` | 2 | one-trial-per-number note on the onboarding "try it" step | none |
| 8 | `dev3/pr8-docs-audit` | see `git log` | 1 | this report | none |

Deviations from the planned groups: the template picker is its own PR (it only shares the route-guard test file with Billing); the onboarding note is a seventh code PR because it fitted no planned group.

Per-branch checks (each run inside its own worktree checkout; exit codes read):

| Branch | tsc | eslint | vitest | Playwright |
|---|---|---|---|---|
| pr1 | 0 | 0 (1 warning, existing) | 55 files, 945 passed, 4 todo | booking-setup, booking-service, team, knowledge: 187 passed |
| pr2 | 0 | 0 | 56 files, 963 passed, 4 todo | home-overview, billing, navigation, whatsapp, auth: 211 passed |
| pr3 | 0 | 0 | 56 files, 963 passed, 4 todo | inbox-template-reply, inbox, inbox-limits: 178 passed, 3 skipped |
| pr4 | 0 | 0 | 57 files, 966 passed, 4 todo | inbox, inbox-limits, whatsapp, inbox-lead-card: 283 passed, 6 skipped |
| pr5 | 0 | 0 | 58 files, 989 passed, 4 todo | team, team-takeover, booking-service, booking-setup, features: 133 passed |
| pr6 | 0 | 0 | 59 files, 996 passed, 4 todo | connect, onboarding: 76 passed |
| pr7 | 0 | 0 | not rerun (two files, no unit code) | onboarding: 49 passed |
| pr8 | docs only, no code checks | | | |

The full Playwright suite was NOT run per branch (a run takes about 18 to 24 minutes). The last full run was on the combined working tree: 1234 passed, 2 failed, 13 skipped.

The two failures are `leads-paging.spec.ts:60` on tablet and mobile. They reproduced on a clean checkout of `5fefa4f` earlier; they have not been re-baselined against the current `origin/main` (`99bb5cf`, backend-only). No Leads code is touched by any branch. `leads-filters.spec.ts:66` is intermittent.

Test harness note: the worktree shares `node_modules` with the main checkout through junctions, so a local-only `turbopack.root` setting was added to the worktree's `next.config.ts` and marked skip-worktree. It is not in any commit.
