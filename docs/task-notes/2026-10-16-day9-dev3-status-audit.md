# Day 9, Dev 3: refreshed Day 6 to 8 status audit (16 Oct 2026)

Status: **evidence-based, mocked unless stated. Nothing here was run against staging, Meta, WhatsApp, PayU, a real Supabase, real RLS, real Realtime, signed media or a live webhook.** Where a row says DONE it means: built, and covered by tests at the level named (unit or mocked browser test). It never means "verified live". Release readiness is at the end and is **not** claimed.

Re-audited against: `main` at `d073c24` (origin, fetched 16 Oct), the local branch `a11y/semantic-landmarks-headings` (HEAD `851807d`, based on `39ffdd2`, **not pushed**), and the uncommitted working tree described below.

**The earlier 34-requirement audit is not in the repository or its history** (searched `docs/`, `docs/reports/`, the task notes and `git log -S`). The only trace is `2026-10-16-day9-dev3-triage.md` (15 items). This table is therefore rebuilt from the Day 6, 7 and 8 task lists and the Day 9 list (Dev 3 items and the shared ones that touch Dev 3). It is **not reconciled row for row** with the old audit. Numbering below is new (D6-1, D7-3, ...).

Status words: DONE · PARTIAL · PENDING · BLOCKED · UNVERIFIED. Priorities: P0 blocks the demo or release, P1 required behaviour, P2 polish.

## 1. The three things you asked to be refreshed first

### Accessibility

- **Fixes are local only.** Landmarks and headings are in commit `851807d` on `a11y/semantic-landmarks-headings`, which has **no remote branch**; `main` does not have them. (`dev3/a11y-fixes` and `a11y/contrast-landmarks-headings` are older local branches; `68c0e9d` there holds the colour change.)
- **Automated audit** (`tests/e2e/app/a11y-audit.spec.ts`, `support/a11y.ts`: DOM rules, computed-colour contrast, a Tab walk; not axe, not a screen-reader test). Run 16 Oct at 390, 820 and 1440 px, desktop project, `A11Y_REPORT_FILE` set:
  - The 19 **pinned** rules (landmarks, headings, names, focus, zoom ...): **0 findings** on every page and width audited, including the new Integrations and admin Plans pages.
  - **Contrast is not fixed and not pinned.** On the 28 pages at HEAD (84 page-width records): **67 contrast findings on 39 records**, the same figures the commit message gave before the two new pages were added (they added none). The three legal pages that another session has in the working tree (below) add 18 more on 9 records: 85 findings on 48 of 93 records in total, still every one a contrast finding.
  - The colours (deeper red and green) are a visible design change awaiting design approval. Not applied.
- Not done and not claimed: keyboard-only walkthrough by a person, a screen reader, reduced-motion, zoom to 400%, real devices.

### Playwright in CI

- `.github/workflows/ci.yml` has a third job, **`e2e`** (30-minute limit, Chromium, `pnpm test:e2e`, artefacts kept 7 days). Its own comment says it is **not a required status check**. Branch protection on `main` (read through the API, 16 Oct) requires **`check` and `migrations` only**, `strict: true`, 0 reviews.
- So Playwright runs in CI but cannot block a merge. Making it required is P1-9 in the triage note and Raja's call.
- **Concurrency hazard:** the workflow cancels an in-progress run for the same ref (`cancel-in-progress: true`). On `main` that means a push that lands while `e2e` is still running (it takes 17 to 24 minutes) cancels it. This is what happened to the post-merge runs for #244 (`e184150`, e2e cancelled after 21 minutes) and #245. `main` therefore has **no completed `e2e` result after `39ffdd2`**; the last complete one is the #244 pull-request run (below).
- Also seen in CI on 16 Oct, none caused by this work: (a) `check` failed once at `next build` on `2414c27` (Turbopack could not resolve a Google font: the build needs network access to Google Fonts); (b) `check` failed on `d073c24`, a docs-only commit, in the backend test `src/kb/fetch-page.test.ts` "returns the page's HTML and the address it ended at": expected `timeoutMs: 15000`, received `14999`, an exact-value assertion on a deadline that moved by 1 ms on a busy runner. It is a flake in Dev 1's website-import code and `check` is a required check, so it can block an unrelated merge. Reported, not fixed (backend is not Dev 3's).

### PR #244 and the last E2E on `main`

- #244 "stabilize leads paging refresh E2E timing": **MERGED** 16 Oct 07:51 (`e184150`). Its pull-request run `38869838345`: `check` success, `migrations` success, **`e2e` success** (07:51 to 08:15, 24 min), Vercel preview success.
- Its post-merge run on `main` (`38872483733`): `check` and `migrations` success, `e2e` **cancelled** at 08:37 (by the next push), so no result.
- `.last-run.json` was not used as evidence.
- Previous complete `e2e` on `main`: `39ffdd2`, success (07:02 to 07:19).

### Concurrent edits in this checkout (not Dev 3's, not mine)

While this work ran, **another process added uncommitted changes to the same working directory**: public `/privacy`, `/terms`, `/data-deletion` pages (`frontend/app/(legal)/`, `components/legal/`, `content/legal/`, `lib/legal/`, three root `.md` files), a logo in the onboarding header and the app sidebar (`onboarding-flow.tsx`, `app.css`, `onboarding.css`, `favicon.ico`, `icon.png`, `apple-icon.png`, `public/*.png`), and three extra paths in the accessibility spec. Some of this already appears on `main` as merged PRs. **I did not touch, revert or test those changes; I only noticed them.** Every browser run below was built from a tree that contains them, so none of my results are from a clean checkout.

## 2. Status table

`mocked` = a Playwright spec that runs against the mock Supabase and `page.route` stand-ins. `unit` = Vitest. Files are under `frontend/` unless stated.

### Day 6 (Dev 3: billing, wizard, connect page)

| ID | Requirement | Status | Evidence | Remaining | Owner / dependency | Priority · acceptance |
|---|---|---|---|---|---|---|
| D6-1 | Billing screen: plan, upgrade, downgrade, top-ups, credit history | DONE (mocked) | `features/billing/*`; `billing.spec.ts`; unit `billing-data.test.ts`, `payu-form.test.ts`, `payment-poll.test.ts` | A real PayU test payment (needs the PayU test merchant and recurring payments enabled) | Raja, Dev 2 | P0 for the demo · an owner pays a plan in PayU test mode and the balance moves |
| D6-2 | Billing: invoices | **BLOCKED** | The screen says "No invoice list yet" (`billing-screen.tsx`). No route lists invoices; `docs/dashboard-screen-inventory.md` marks it "PROPOSED, Dev 2 (our own numbering: PayU has no invoices)". `payments` rows are readable by members under RLS (0035 `tenant_read`), but a row has no invoice number, no document and no GST invoice | **The exact missing contract:** either (a) Dev 2 returns `{ id, number, date, amountInr, url }[]` (the shape in `dashboard-screen-contracts.md` line 417) with our own numbering and a document per payment, or (b) the owner decides a **payment history** read straight from `payments` (kind, amount with GST, status, method, settled_at) is enough for now, and says so, since that is not an invoice. Dev 3 builds either in about a day once chosen | Dev 2 / owner | P1 · a paying owner sees every payment of their business and no one else's |
| D6-3 | Trial countdown and upgrade prompts | DONE (mocked) | `billing-screen.tsx`, `home-overview.tsx`; `billing.spec.ts` "a trial counts down and says to pick a plan", `home-overview.spec.ts` "a running trial counts the days left" | none for the screens | n/a | done |
| D6-4 | Wizard: signup (email) | DONE (mocked) | `signup.spec.ts`, `trial-signup.spec.ts`, `onboarding.spec.ts` ("a new account walks the existing wizard") | none | n/a | done |
| D6-5 | Wizard: business and industry | DONE (mocked) | `step-business.tsx`; `onboarding.spec.ts` walk; the trades come from the active packs | none | n/a | done |
| D6-6 | Wizard: optional website import | DONE (mocked) | `step-teach.tsx`; `onboarding.spec.ts` Teach step; `website-import.spec.ts`; backend route `POST /api/onboarding/import-site` exists | A real page imported on staging | Dev 1 (route), staging | P1 |
| D6-7 | Wizard: demo test link (`wa.me` with a TRIAL code) | DONE (mocked) | `step-try.tsx`; `onboarding.spec.ts` asserts the link `https://wa.me/15555550100?text=TRIAL-xxxx` (a fictional test number) | Confirm `NEXT_PUBLIC_DEMO_WHATSAPP_NUMBER` is set on Vercel and is the real demo number (names only) | Dev 2 / Raja | P0 for the demo |
| D6-8 | Wizard: Connect WhatsApp step (Connect with Facebook, Book a setup call, live status panel) | **PARTIAL** | Buttons and panel exist and are tested: `onboarding.spec.ts` (not configured, own app, partner access) and, **new this session, four tests x 3 widths** for the saved states (active, failed, pending, read error). The setup-call offer is `SetupCall` (a link when `NEXT_PUBLIC_SETUP_CALL_URL` is set, otherwise "Ask the Spark Agent team") | The Day 9 line "clearly says Embedded Signup and assisted onboarding are **waiting on Meta approval**": the screen says "Connecting with Facebook isn't set up on this site yet" and "isn't switched on yet", not that Meta App Review is pending. Whether to say so, and in what words, is a product claim only Raja can make (it must be true on demo day) | Raja (wording), Meta (App Review) | P0 for the demo, copy only · the step names Meta approval as the reason, shows the manual path and the setup-call offer |
| D6-9 | Wizard: staff, services and slots | **PARTIAL (by design)** | The Team step adds nobody and explains that staff, Calendar and hours are set up in Team and Booking setup; services are added in Knowledge (Teach step says so). Tested: `onboarding.spec.ts` "keeps nothing for staff or the calendar" | (1) The Team step's sentence "**Inviting staff isn't switched on yet**" is **stale**: team invitations are on `main` since #237 (`0052`). A one-line copy change, **not made** (copy needs approval). (2) Whether the wizard should embed staff and hours instead of pointing to them is a product decision | Raja, Dev 3 | P1 · a new owner can add staff and hours without leaving the wizard, or the wizard stops saying invites are off |
| D6-10 | Wizard: toggles review | DONE (mocked) | `step-team.tsx`, `features/onboarding/persistence.ts`; 7 `onboarding.spec.ts` tests (saved switches, a switch moves only after the server saves, Reminders is two rows, failed save, plan refusal, one press one request, failed read) and unit `persistence.test.ts` | Real `PATCH /api/features` on staging | Dev 2, staging | P1 |
| D6-11 | `/connect/:token` page | DONE (mocked) | `features/connect/*`; `connect.spec.ts` (valid, invalid, malformed, failed read, Meta not configured); loading state new this session | The Meta popup and a live connection cannot run until Embedded Signup passes App Review | Meta | P0 for the assisted path; blocked |
| D6-12 | Team invites with seat limits (P1) | DONE (mocked) | `features/team/*`, `features/invite/*`; `team-invites.spec.ts`, `invite.spec.ts`; CI `migrations` runs `scripts/db/team-invite-concurrency.sh` | Real email delivery is not part of the design (the link is copied) | n/a | done |
| D6-13 | Day 6 exit: a fresh tenant completes onboarding on staging | **BLOCKED** | None: no staging access | Staging URL and logins | Raja / Dev 2 | P0 |

### Day 7 (Dev 3: admin panel, agent settings, roles, Playwright)

| ID | Requirement | Status | Evidence | Remaining | Owner / dependency | Priority · acceptance |
|---|---|---|---|---|---|---|
| D7-1 | Admin: all businesses with status, plan, credits | DONE (mocked) | `admin/billing`; `admin-billing.spec.ts` | Real `GET /api/admin/tenants` against a database | Dev 2, staging | P1 |
| D7-2 | Admin: extend trial | DONE (mocked) | same; checks the days, sends once, re-reads | none | n/a | done |
| D7-3 | Admin: grant credits (ledger reason `admin`) and an audit entry naming the admin | PARTIAL | The screen sends `requestId` so a retry cannot grant twice (`admin-billing.spec.ts`). The ledger reason and the audit row are the server's (`0041`, actor `admin:<id>`); not seen in a real ledger | A grant on staging and the `credit_ledger` and `audit_logs` rows read back | Dev 2 / staging | P0 for the Day 7 exit test |
| D7-4 | Admin: edit plans and features | **DONE (mocked), uncommitted** | **Built this session** at `/dashboard/admin/plans`: `lib/admin/catalogue.ts` (+ 18 unit tests), `components/dashboard/admin-catalogue-panel.tsx`, `admin-plans.spec.ts` (14 tests x 3 widths). Contracts confirmed first: **read** = `plans` and `features` are global catalogues any signed-in user reads (`0001` `catalogue_read`; `isolation.test.sql` proves a member cannot change them), the same read the Billing screen uses; **write** = `PATCH /api/admin/plans/:key` and `/features/:key` (`packages/types/src/admin.ts`, `backend/src/billing/admin.ts`, `0041`) | A save on staging by a platform admin; the Day 7 note called the read path "missing", it is not. Not in the navigation (like the other admin pages) | Dev 2 (nothing to build), staging | P1 · an admin changes a plan field, the server answers, the row reads back; a non-admin is refused |
| D7-5 | Admin: open a business's dashboard with an audit entry | **BLOCKED** | No route in `backend/src/server/routes.ts` | A route and its audit contract: request and response, who may call it, how tenant isolation is kept, the audit row naming the admin | Dev 2 | P1 · an `audit_logs` row names the admin who opened it |
| D7-6 | Admin: connection list (method, status, last check) | DONE (mocked) | `admin/connections`; `admin-connections.spec.ts` | Real data | staging | P1 |
| D7-7 | Admin: connect-link generator | DONE (mocked) | `admin/whatsapp`; `admin-connect-link.spec.ts` | The link used end to end needs Embedded Signup | Meta | P1 |
| D7-8 | Admin: flag for businesses that paid the setup fee | DONE (mocked) | `admin-billing.spec.ts` "setup call owed" | none | n/a | done |
| D7-9 | Agent settings | **PARTIAL** | Built and tested for every field the contract has: assistant name, tone, privacy notice, which handovers fire (`agent-settings.spec.ts`, 11+ tests; unit `agent-settings.test.ts`). Business hours live in Booking setup and the screen links there | **Languages, lead-scoring and qualification rules, and the takeover default have no storage contract**: the shared `AgentSettings` and `UpdateAgentSettings` (`packages/types/src/agent-settings.ts`) are a strict object that rejects them, and the backend reads none from `tenants.agent_settings`. Nothing was invented or mocked as persistence. Own-number hand-back is blocked in `conversations/mode.ts` | Dev 1 (storage, then Dev 3) | P1 · each agreed field loads, saves, survives a reload and is read by the agent |
| D7-10 | Deletion-request screen | DONE (mocked) | `settings/privacy`; `privacy.spec.ts` (preview, one request on double click, conflict, refusal, empty, failed read) | A real deletion and the `consent_logs` `deleted` row | Dev 2 / staging | P0 for the Day 7 exit test |
| D7-11 | Role checks for owner, admin and staff on every screen and route | **PARTIAL** | Server: `backend/src/server/authorization-routes.test.ts` drives the real route table with five roles. Screens: each has refusal tests. **New this session:** `docs/dashboard-roles-and-routes.md` (the written matrix, every cell read in code) and `role-access.spec.ts` (staff can use Leads, Calendar and the Inbox takeover; 3 tests x 3 widths), because only refusals were tested before | RLS-level proof (`pnpm db:test`, Docker) and a real platform-admin lookup; D7-5's route | Dev 2 | P1 · a written matrix, allowed and denied cases tested for each route |
| D7-12 | Playwright suite: login, inbox takeover, KB edit, toggle, booking cancel, billing, admin grant, manual connection | DONE (mocked) | `auth.spec.ts`, `inbox.spec.ts` ("who replies"), `knowledge.spec.ts`, `features.spec.ts` and the wizard toggles, `calendar-actions.spec.ts`, `billing.spec.ts`, `admin-billing.spec.ts`, `onboarding.spec.ts` and `admin-whatsapp.spec.ts` (manual connection); runs in CI as `e2e` | `e2e` is not a required check | Raja | P1 |
| D7-13 | Mobile layout check | DONE (mocked) | Every spec runs at 390, 820 and 1440 px and the screens assert no horizontal overflow; `responsive-matrix.spec.ts` | Real phones | testers | done for the mock |
| D7-14 | Error, empty and loading states everywhere | **PARTIAL, improved** | Error and empty were covered nearly everywhere. **Gap found and closed this session:** no browser test showed the loading state of Billing, Features, Integrations, Team, Home, the connect page or the invite page. `loading-states.spec.ts` (7 tests x 3 widths) holds each read and checks that it says it is loading and nothing else, then shows the content | Remaining per screen are listed in section 4 | Dev 3 | P1 |
| D7-15 | Cross-review each other's high-risk code; sign off the checklist in the PR | UNVERIFIED | No sign-off was found in the repository; PR review comments were not read | Check the merged PRs for the checklist | Dev 1, 2, 3 | P1 |
| D7-16 | Day 7 evening exit test (replay, one reply under timeout, grant and deletion rows, rate limits, CI green, no secret in logs) | UNVERIFIED | Backend tests exist for most (`failure`, `idempotency`, `authorization`); none re-run for this audit; the staging parts were not run | Run on staging | Dev 1, Dev 2 | P0 |

### Day 8 (Dev 3: screens, polish, demo data)

| ID | Requirement | Status | Evidence | Remaining | Owner / dependency | Priority · acceptance |
|---|---|---|---|---|---|---|
| D8-1 | Finish the wizard and missing screens: home summary, billing history, connection health | PARTIAL | Home summary (`home-overview.spec.ts`), credit history (`billing.spec.ts`) and connection health (`whatsapp.spec.ts`, `admin-connections.spec.ts`) are done. "Billing history" as **invoices** is D6-2 | D6-2, D6-8, D6-9 | see rows | P1 |
| D8-2 | Client metrics: enquiries, qualified leads, booked visits, after-hours enquiries handled | DONE (mocked) | `home-overview.spec.ts`; the numbers are the server's (`backend/src/dashboard/summary.ts`: enquiries and after-hours from `leads.created_at` and the business hours, booked from `bookings`) | The four numbers against real rows (needs the seed or a real week) | Dev 2, D8-4 | P0 for the demo · Home's four numbers equal the SQL counts |
| D8-3 | Visual polish, mobile layout and an accessibility pass | **PARTIAL** | See section 1: structure clean, **contrast open (67 findings on 39 records)**, fixes unpushed | Push `851807d` (needs approval); decide the colours | Raja (design), Dev 3 | P1 · pinned rules stay clean; contrast pinned once the colours land |
| D8-4 | Seed a believable week of demo data | **BLOCKED** | A **reviewable draft only**: `docs/drafts/demo-week.DRAFT.sql` (refuses to run until its guard is removed), plus the 15 and 16 Oct plan and checklist. **Not run anywhere** | (1) Owner approval for inserting `messages` directly (it bypasses `notify.send()`), or an approved alternative; (2) a machine with Docker to prove it is idempotent and that `pnpm db:test` still passes; (3) who runs it on staging | Owner / Raja, Dev 2 | P0 for the demo · re-running changes no row counts; Home's four numbers match the SQL |
| D8-5 | Landing page with pricing and demo buttons (P2) | PENDING | Not started | Approved pricing content and the demo number | Raja | P2 |
| D8-6 | Two end-to-end rehearsals on staging by two developers, no manual database edits | **BLOCKED** | Request written (`2026-10-16-day9-dev3-staging-rehearsal-request.md`); nothing provided | Staging URL and API URL on the latest green `main`, two test businesses, a Meta test number, migrations 0047 to 0052 applied | Raja, Dev 2 | P0 |
| D8-7 | Triage every issue as P0, P1 or P2 | PARTIAL | `2026-10-16-day9-dev3-triage.md` drafted (untracked); this note adds findings | Review by Dev 1, Dev 2 and Raja | Raja | P0 |
| D8-8 | Freeze all non-fix work | PENDING | Proposal drafted (`...-freeze-proposal.md`); no freeze in force | Date, approver, exceptions | Raja | P0 |

### Day 9 (Dev 3)

| ID | Requirement | Status | Evidence | Remaining | Owner / dependency |
|---|---|---|---|---|---|
| D9-1 | Run the dashboard side of the demo as the business owner | BLOCKED | No staging | Staging, the seed, five tester phones | Raja, Dev 2 |
| D9-2 | Document screens, roles and the routes each screen calls | DONE | `docs/dashboard-roles-and-routes.md` (new, uncommitted); older `dashboard-screen-contracts.md` and `-inventory.md` are proposals and partly stale | Keep it in step with `routes.ts` (the drift guard in `backend-routes.test.ts` covers the route list) | Dev 3 |
| D9-3 | Connect WhatsApp step: says Embedded Signup and assisted onboarding wait on Meta approval; shows the manual path and the Book a setup call button | PARTIAL | Manual path and setup-call offer shown and tested; the wording is D6-8 | Wording decision | Raja |

## 3. Dependencies and questions (nobody is being waited on)

| To | Question | Why it matters |
|---|---|---|
| **Dev 1** | Where are agent **languages, scoring and qualification rules, and the takeover default** stored, by which route, with which key names and validation, and do writes merge? Is handing an own-number chat back to the AI wanted (blocked in `conversations/mode.ts`)? | D7-9 |
| **Dev 1** | `backend/src/kb/fetch-page.test.ts` asserts `timeoutMs` equals exactly 15000 and failed on `main` with 14999. Can the test inject the clock or accept a range? | A required check can fail for an unrelated merge |
| **Dev 2** | A route to open a business's dashboard with an audit entry: request, response, who may call it, tenant isolation, the audit row | D7-5 |
| **Dev 2** | Invoices: build the list route with our own numbering, or accept a payment history read directly from `payments`? | D6-2 |
| **Dev 2** | Message media: is the browser signing URLs with the member's session approved, who may read a file, how long may a URL live? (`2026-10-15-day7-dev3-open-questions.md`). Outbound webhooks: is there any read of recent deliveries, is `test` rate limited? | Open since 15 Oct |
| **Dev 2** | Migrations 0047 to 0052 applied on staging, and the three Vercel variable names set (`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_DEMO_WHATSAPP_NUMBER`, `NEXT_PUBLIC_SETUP_CALL_URL`) | Rehearsals |
| **Raja** | Staging URLs and logins, two test businesses, a Meta test number and recipients; the two rehearsal developers and the window | D8-6, D13 |
| **Raja** | Wording for the Meta-approval message on the Connect step; the stale "Inviting staff isn't switched on yet" line | D6-8, D6-9 |
| **Raja** | Make `e2e` a required check? Fix the `cancel-in-progress` behaviour on `main` so a post-merge `e2e` can finish? | Section 1 |
| **Raja** | Freeze date, approver and exceptions; approved pricing and demo number for the landing page; design approval for the contrast colours | D8-8, D8-5, D8-3 |
| **Owner** | Approval to insert `messages` without `notify.send()` for the demo seed (nothing is sent), or the approved alternative | D8-4 |
| **Meta** | App Review for Embedded Signup (app and configuration ids, by name only), and a test number | D6-8, D6-11 |
| **PayU** | Test merchant key and salt on Railway, recurring payments (SI) enabled | D6-1 |

## 4. Loading, empty and error coverage after this session

`L` loading, `E` empty, `R` error with retry, `S` double-submit guard. ✅ browser test exists, ➖ none found, n/a not applicable.

| Screen | L | E | R | S | Where |
|---|---|---|---|---|---|
| Billing | ✅ new | ✅ | ✅ | ✅ | `loading-states.spec.ts`, `billing.spec.ts` |
| Features | ✅ new | ✅ | ✅ | n/a | same, `features.spec.ts` |
| Integrations (webhook) | ✅ new | ✅ | ✅ | ✅ | same, `webhooks.spec.ts` |
| Team (members) | ✅ new | ✅ | ✅ | ✅ | same, `team.spec.ts`, `team-invites.spec.ts` |
| Home | ✅ new | ✅ | ✅ | n/a | same, `home-overview.spec.ts` |
| Connect page | ✅ new | n/a | ✅ | n/a | same, `connect.spec.ts` |
| Invite page | ✅ new | n/a | ✅ | ✅ | same, `invite.spec.ts` |
| Admin plans and features | ✅ | ✅ | ✅ | ✅ | `admin-plans.spec.ts` (new) |
| Wizard WhatsApp step (saved connection) | ➖ ("Checking for a saved WhatsApp connection…" is not asserted; the slow-read test is for the dashboard's WhatsApp page) | n/a | ✅ new | n/a | `onboarding.spec.ts` (new), `whatsapp.spec.ts` |
| Inbox media (signed URL) | ➖ | n/a | ✅ | ✅ | `inbox-media.spec.ts` |
| Website import form | ➖ | ✅ | ✅ | ➖ | `website-import.spec.ts`: no test that the button is off while an import is in flight |
| Team (your number, how you take over) | ➖ | ✅ | ✅ | n/a | `team.spec.ts`, `team-takeover.spec.ts` |
| Knowledge, Inbox, Leads, Calendar, Booking setup, Agent settings, Privacy, Admin billing, connections, metrics, WhatsApp | ✅ | ✅ | ✅ | ✅ | already covered before this session |

Remaining small gaps (P2): inbox media loading, website import double submit, the Team screen's two lesser sections' loading text.

## 5. Not claimed

- Anything live (WhatsApp, Meta Embedded Signup, PayU, real Realtime, real RLS from a browser session, signed media, a live webhook).
- That the product is release-ready. The Day 8 exit test (two staging rehearsals) and the Day 9 exit test have not happened; see section 6.
- "Razorpay" wording in the Day 6 to 9 task lists is historical: billing is **PayU** (decision 20). The task lists were not edited.

## 6. Tests run on 16 Oct 2026, and release readiness

All commands from the repository root or `frontend/`. The browser runs were built from a working tree that **also holds another session's uncommitted legal-page and logo changes** (section 1), so they are not from a clean checkout. `pnpm` is not on PATH here; a `corepack pnpm` shim in the scratchpad was used (never in the repo).

| Command | Result |
|---|---|
| Baseline before any change: `frontend/node_modules/.bin/vitest run` | 79 files, **1286 passed**, 4 todo, 0 failed |
| Same, after all changes | 80 files, **1304 passed** (+18: `lib/admin/catalogue.test.ts`), 4 todo (the same four `it.todo` in `booking-lifecycle.test.ts`), 0 failed |
| `pnpm typecheck` (root, all workspaces) | exit 0 (backend and frontend `tsc --noEmit` clean) |
| `pnpm lint` (root) | exit 0, **0 errors, 0 warnings**. The one warning present at the start (`signIn` unused in `onboarding.spec.ts`) is gone because the new tests use it |
| `pnpm --filter @pakka/types test` | 8 files, **170 passed** |
| `pnpm --filter @pakka/backend test` | 288 files, **7124 passed, 2 failed**: `conversation-tests/latency.test.ts` ("counts the replies that were written again...") and `agent/scoring/display-text.test.ts` ("a very long input is cleaned in a blink", 531 ms): both timing assertions, run while the machine was also loaded. Review pass: `display-text` **fails in the full suite every time on this machine** (expected 531, then 505, to be less than 500: a wall-clock budget, a test-design defect) and failed 1 of 4 repeats under load; `latency` did not fail again and its message was never captured, so its cause is **unknown** (it takes about 1.0 s alone against vitest's 5 s default); a third test, `kb/fetch-page.test.ts` "returns the page's HTML...", failed in one aborted run, and in CI on `d073c24`, because `fetchPage` reads `Date.now` twice and the test does not inject its `now` parameter, so a 1 ms tick gives 14999 (deterministic mechanism, rare) |
| `playwright test --workers=2`, **all projects (setup, desktop, tablet, mobile)**, one run, 43.6 min | **1938 passed, 2 failed, 119 skipped** (the skips are the audit specs that run only in the desktop project) |
| The 2 failures, both on **tablet**: `leads-filters.spec.ts:178` (14.2 s) and `loading-and-refresh.spec.ts:122` "Calendar · Refresh" (41.1 s) | Rerun alone, same project, `--workers=1`: **17 passed**. Review pass: **not reproduced** in 24 further runs (12 each, tablet, 3 workers). Both failed because the page's first data never appeared within the 5 s assertion window (0 board links; "Karthik R" not found), not because a count or order was wrong. Original traces were overwritten by later runs, so the cause is **unknown**; it is consistent with machine load, which is not evidence of it |
| New browser tests added: wizard saved connection (4), admin plans (14, one added in the review pass), loading states (7), staff access (3) | all pass at the three widths, on the full run and on their own runs. The first versions of `loading-states` and `role-access` failed because of the Next route-announcer alert (a defect in my specs, fixed) |
| `a11y-audit.spec.ts` | 14 passed, 26 skipped (other projects), 0 failed; report: 93 records, 85 contrast findings, 0 findings for any other rule |
| **Not run**: `pnpm db:test`, `scripts/db/*.sh` (no Docker), `pnpm test:conversations`, staging, Meta, PayU, a real Supabase | stated as not run, never as passing |

### Release readiness: **not claimed**

The product cannot be called release-ready from this evidence, because:

1. **Neither exit test has happened.** The Day 8 exit test (the section 15 demo checklist twice in a row on staging, by two developers, no manual database edits) and the Day 9 live demo have no run, no staging access and no tester phones.
2. **Everything above is mocked.** Real RLS, Realtime, signed media, Meta, WhatsApp, PayU and a real Supabase were not exercised, and `pnpm db:test` could not run.
3. **Known open items:** invoices (no contract), agent-settings fields (no storage contract), open-a-business's-dashboard (no route), Embedded Signup (Meta App Review), the demo seed (draft only, awaiting approval and Docker), accessibility contrast (awaiting design approval), the accessibility fixes (not pushed).
4. **CI health on `main`:** a required check (`check`) failed on `d073c24` for a backend timing flake, and the post-merge `e2e` run is cancelled by the next push.
5. My branch is based on `39ffdd2`; `origin/main` has moved on (#244 to #246 and later). Rebase or re-test on the new `main` before anything is merged.

## 7. Review pass and this branch (16 Oct 2026, later)

- **Base moved.** This work was audited on a local branch based on `39ffdd2`. It is now prepared on `dev3/day6-8-review`, based on `origin/main` at `fe56793` (#248), in an isolated worktree. The logo (#247) and the legal pages (#248) that sections 1 and 6 call "another session's uncommitted changes" have since merged; none of that work is in this branch's commits.
- **Commits** (local first, then this PR): the accessibility commit cherry-picked (`851807d`), the admin plans and features editor, the loading, staff-access, wizard and wider accessibility tests, and these documents. `a11y-audit.spec.ts` carries only Dev 3's additions; the three legal paths another developer added to their copy are left out until ownership is confirmed.
- **Defect found in review and fixed:** in the plans editor, two overlapping saves finishing out of order could revert the other card's saved row. Fixed with a functional state update; `admin-plans.spec.ts` now has a test that fails without the fix (checked) and passes with it.
- **Failure investigation** (section 6 had called these load flakes; the evidence is now):
  - Backend `agent/scoring/display-text.test.ts` "cleaned in a blink": **fails in the full backend suite every time on the review machine** (expected 531, then 505, to be under 500). A wall-clock budget: a test-design defect.
  - Backend `kb/fetch-page.test.ts` "returns the page's HTML and the address it ended at": `fetchPage` reads `Date.now` twice and the test does not inject its `now` parameter, so a 1 ms tick gives `timeoutMs` 14999 instead of 15000. Deterministic mechanism, rare. It failed `check` in CI on `d073c24`. Dev 1's file; not changed here.
  - Backend `conversation-tests/latency.test.ts` "counts the replies that were written again": did not fail again in six further runs and its message was never captured. **Cause unknown.**
  - Tablet `leads-filters.spec.ts:178` and `loading-and-refresh.spec.ts:122`: both failed because the page's first data did not appear within the 5 s assertion window (0 board links; "Karthik R" not found), not because a count was wrong. 24 repeats (12 each, tablet, 3 workers) and 17 reruns all passed; the original traces were overwritten. **Cause unknown.**
- **Seed draft:** `docs/drafts/demo-week.DRAFT.sql` was corrected in review (a keyword-like parameter name, a helper wrongly marked `immutable`, and the missing `kind` column on message rows). It still refuses to run on its first statement, lives outside `supabase/`, and is not referenced by any script.
- **Browser run on this branch:** a full Playwright run on this worktree was started on 16 Oct and its result is added to the pull request when it finishes. Vitest (81 files, 1309 passed, 4 todo), typecheck and lint were clean on this tree before it started.
