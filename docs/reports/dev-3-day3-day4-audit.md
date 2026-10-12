# Dev 3: Day 3 and Day 4 task completion audit

**Audited:** 12 Oct 2026, local checkout on `main` at `602e26e` plus the uncommitted Dev 3 work, with this run's changes on top. `origin/main` is now four commits ahead (#116 to #119, the same AL-1, SR-1, LC-1 and WA-4/WA-2 work as PRs); nothing was fetched, pulled or merged by this run.
**Sources:** `Day 3 Task List – It Qualifies and Books` and `Pakka Agent — Day 4 Task List` (the PDFs in the request), the three Dev 1 handoff notes, `docs/contracts.md`, `docs/dashboard-screen-contracts.md`, the E2E regression matrix, and the code.
**Nothing was committed, pushed, merged or deployed.** No backend code, migration, shared contract, environment file or deployment setting was changed.

## How to read the statuses

| Status | Meaning here |
|---|---|
| DONE | Implemented and the relevant tests pass at the level named. For Dev 3's screens that level is unit plus mocked E2E (a mock Supabase, stubbed API routes). It is never a live check. |
| PARTIAL | Some of the requirement is built. |
| BLOCKED | A specific contract, backend change, product decision or credential is missing. |
| UNVERIFIED | Code may exist (often with backend unit tests), but nothing here shows it working for real. |
| NOT STARTED | No implementation found. |

**Nothing in this report is live evidence.** No staging, real Supabase, real Realtime, live WhatsApp, live Meta or live Google run was made or seen. Docker is not running on this machine, so `pnpm db:test` and `scripts/db/*.sh` could not be run.

## 1. Task matrix

### Day 3, Dev 3

| Task ID | Requirement | Status | Evidence / files / tests | Remaining work or blocker | Owner |
|---|---|---|---|---|---|
| D3-1a | Services: service length, gap between bookings, minimum notice | DONE | `features/knowledge/{data,services-editor}` (also shown on Booking setup) write `services.duration_min`, `buffer_min`, `min_notice_min` (migration 0015) under RLS. E2E `booking-setup.spec.ts`, `knowledge.spec.ts`; unit `knowledge/data.test.ts`. Persisted by real table writes, no stub | Not exercised on a real database. Owner or admin only is enforced in the page, not by the database: the write policies in `0002` are tenant-scoped only (RL-1) | Dev 3 / Dev 2 (RL-1) |
| D3-1b | Working hours | DONE | `tenants.business_hours` and `resources.working_hours` (`features/settings/{hours,resources-data}.ts`). Unit `hours.test.ts`, `resources-data.test.ts`; E2E `booking-setup.spec.ts` (split shift, closed day, overlaps refused) | As D3-1a | Dev 3 |
| D3-1c | Service-area pincodes for field visits | DONE | `resources.service_area = { pincodes: [...] }`, 6-digit validation, up to 500 (`hours.ts`). Unit `hours.test.ts`; E2E `booking-setup.spec.ts` | The assistant does not offer field visits yet (Day 3 handoff §5.5: `findSlots` needs a pincode) | Dev 1 |
| D3-1d | Which service the assistant books when several are active (Dev 1 handoff §4.2; not a Day 3 checkbox, but without it a two-service business hands every booking to a person) | DONE (new, this run) | `features/settings/booking-service{,-section}`, writes `tenants.agent_settings.bookingServiceId`, keeps every other key, refuses non-object settings. Unit `booking-service.test.ts` (14); E2E `booking-service.spec.ts` (5 × 3 widths) | `docs/contracts.md` still lists the `agent_settings` shape as "To define: Dev 1 + Dev 3" (open decision 8). Whether the real assistant then books that service is unseen. Read-then-write on one jsonb column: two people saving at the same instant could lose one | Dev 1 + Dev 3 |
| D3-1e | The catalog the scorer reads (`catalog_items.price_from`, `attributes.price_to`, `attributes.area`) has an editor | NOT STARTED | The dashboard never reads or writes `catalog_items`; the Knowledge → Services editor writes `services`, a different table (CAT-1 in the matrix). The seed has no catalog rows | Without catalog rows the budget and area rules earn nothing, the best staging score is warm, and a budget far below the cheapest home never disqualifies. Needs a product decision on the screen and per-pack fields | Dev 3 + product |
| D3-2 | Leads board: stage columns, score filter, hot/warm/cold filter, pagination past 500, loading, error, refresh | PARTIAL | Columns by stage; filters; keyset paging 200 at a time with "Load more", no silent cap at 500 (`features/leads/{data,paging,leads-board}`). Unit `paging.test.ts` (1,234 leads through the real `fetchLeadsPage`), `data.test.ts`, `contract-shapes.test.ts`; E2E `leads.spec.ts`, `leads-paging.spec.ts`, `loading-and-refresh.spec.ts` | The temperature and score filters and the counts cover only the leads already loaded (counts read "200+"): PG-2. The keyset filter is unseen on a real PostgREST and a real `timestamptz` (PG-1). No live updates: `leads` is not in the Realtime publication (RT-1) | Dev 3 (filters), Dev 2 (counts, publication) |
| D3-3 | Lead detail: collected answers, timeline, nullable score, right tenant and conversation | DONE | Answers labelled from the pack, timeline from chat, handovers and bookings, "Not scored yet" for a null score (`features/leads/{data,lead-detail}`). Refresh added this run (LD-1): `lead-detail-refresh.spec.ts` (3 × 3 widths). Tests `leads.spec.ts`, `data.test.ts` | See D3-3b. The lead card is in the inbox (D4-1), where the stored lead and the API's words are kept apart so they cannot disagree on score, stage, answers or booking | Dev 3 |
| D3-3b | Booking confirmed and cancelled time and actor, handover opened time, on the timeline | BLOCKED | `bookings` has only `created_at` and `handoffs` has no opened time (0001, 0015). 4 `it.todo` in `booking-lifecycle.test.ts` | Dev 2 adds the columns (BT-1, BT-2) | Dev 2 |
| D3-4 | Calendar: Day and Week, per staff or resource, read-only, timezone, loading, error, refresh | DONE | `features/calendar/*`: Day/Week, one column per staff member, a "no one assigned" filter, no write calls in the feature, times in the business zone (E2E "viewed from another time zone"), a notice at 1,000 bookings, Refresh. Unit `calendar.test.ts`, `booking-lifecycle.test.ts`; E2E `calendar.spec.ts`, `loading-and-refresh.spec.ts` | No live updates: `bookings` is not published (RT-2). Google events are not drawn (the internal table is the source of truth) | Dev 2 (RT-2) |
| D3-5 | Realtime for leads and bookings | BLOCKED | `lib/realtime/published-tables.ts` and its test read the migrations: only `messages`, `conversations`, `handoffs`, `kb_documents` are published. Screens say "Not updating live. Use Refresh." | A Dev 2 migration adds `leads` and `bookings`; the hosted publication is unchecked (RT-8) | Dev 2 |

### Day 3, shared exit criteria (all backend, database or staging)

| Task ID | Requirement | Status | Evidence / files / tests | Remaining work or blocker | Owner |
|---|---|---|---|---|---|
| D3-X1 | Three real offered slots; the picked slot confirmed | UNVERIFIED | Dev 1: `findSlots` → offer → `holdSlot` → `confirmBooking`, 11 scripted booking chats with fakes. **Product change:** times are offered in a plain sentence, not a WhatsApp list (Day 3 handoff §6), so the exit test wording is out of date | A staging run | Dev 1 + Dev 2 |
| D3-X2 | The booking shows for the right staff member | UNVERIFIED | The calendar renders `bookings.resource_id` correctly (mocked) | Needs a booking made by the real assistant | Dev 1 + Dev 2 |
| D3-X3 | Two holds at once: exactly one wins | UNVERIFIED | `scripts/db/hold-slot-concurrency.sh` (20 parallel holds) and `supabase/tests/booking.test.sql` exist; **not run here (no Docker)** | Run `pnpm db:test` and the script | Dev 2 |
| D3-X4 | A booking with no staff member never clashes | UNVERIFIED | Same script (5 parallel callbacks); not run | As above | Dev 2 |
| D3-X5 | "Tomorrow evening" in the business's time zone | UNVERIFIED | Backend unit `booking-timezone.test.ts` passed in this run's backend suite; not a staging check | A staging chat with the server clock in another zone | Dev 1 |
| D3-X6 | One credit entry per AI reply; zero credits sends one free holding message | UNVERIFIED | Backend unit tests for `notify.send` and credits passed in this run; `credits.test.sql` and `spend-credits-concurrency.sh` not run. Dev 1 has "not looked at the ledger on staging" | A staging check of the ledger | Dev 2 |

### Day 4, Dev 3

| Task ID | Requirement | Status | Evidence / files / tests | Remaining work or blocker | Owner |
|---|---|---|---|---|---|
| D4-1 | Pinned lead card (real, follows the chat, loading, retry, error, nullable score, stale answers) | DONE | `lead-card-api.ts` → `GET /api/conversations/:id/lead-card`; `lead-card-panel.tsx` (beside the chat from 1180 px, a sheet below); per-chat state with sequence guards in `inbox-screen.tsx`; the full phone number is dropped before it reaches the page; the panel takes score, stage, answers and booking from the stored lead and only words and flags from the API. Unit `lead-card-api.test.ts`, `lead-card-panel.test.ts`; E2E `inbox-lead-card.spec.ts` (route stubbed) | The real route was never called from a browser. The API's "Hot lead" flag can differ for a moment from the stored temperature | Dev 1 (staging) |
| D4-2 | AI/human switch and Return to AI (system note) | DONE | `conversation-mode.ts` → `POST /api/conversations/:id/mode`; the backend writes "Returned to the AI. It will reply to new messages." and closes the chat's open handoffs; a refusal changes nothing on screen (E2E `inbox.spec.ts`) | Not run against a real database or WhatsApp | Dev 3 |
| D4-2b | An own-number (`external`) chat can go back to the AI | BLOCKED | `backend/src/conversations/mode.ts:48` answers `conflict` to any change from `external`, and the switch is disabled for it. Dev 1's Day 4 note says only "Return to AI" returns such a chat. **Nothing returns it** (XM-1) | A product decision, then a change to `mode.ts` (backend) | Dev 3 (route owner) + Dev 1 |
| D4-3a | Free-form staff reply inside 24 hours at 0 credits | DONE | `staff-reply.ts`, `reply-composer.tsx` → `POST .../messages`. Sending state; a failed send keeps the draft; an outcome-unknown failure is never retried; `staff_reply` costs 0 (`billing/credit-costs.ts`). Unit `staff-reply.test.ts`; E2E `inbox.spec.ts` (route stubbed) | Credit use is not shown (not in the contract). No live send | Dev 3 |
| D4-3b | Template picker outside the 24-hour window | BLOCKED | `backend/src/conversations/staff-reply.ts:46` still throws `not_available` for a `template`, and `SendStaffReplyInput` has no template field. `notify.send` already accepts `template: { name, language, params }` for `staff_reply` (Dev 2, #87, `docs/contracts.md`), and `whatsapp_templates` is member-readable. No fake success path was built | The route and its input type must accept the template: a small backend change that this audit was told not to make. Then the picker is a frontend task | Dev 3 (route) + Dev 2 |
| D4-4a | Team: alert preferences | BLOCKED | `memberships` has only `whatsapp_phone` and `takeover_pref`; there is no column or contract for per-alert choices | A contract and storage | Dev 2 + Dev 1 |
| D4-4b | Team: staff WhatsApp phone | DONE | `features/team/{alert-number,team-screen}`: E.164, own row only under RLS. Unit `alert-number.test.ts`; E2E `team.spec.ts` | Alert delivery to that number is unseen | Dev 3 |
| D4-4c | Team: takeover preference | BLOCKED | The column exists and a member may update it (0002), but only "inbox" is safe to offer without knowing the plan | See D4-4d | Dev 2 |
| D4-4d | Own-number option shown only on a plan that includes it | BLOCKED | `handoff_own_number` is worked out on the server (`features/is-enabled.ts`: business live, plan lists it, toggle on). No approved contract hands that to the browser, and copying the rule into the page is not allowed | A readable entitlement from Dev 2 (OW-1, TP-1) | Dev 2 |
| D4-5 | AI-suggested reply | DONE | `suggest-reply.ts`, `reply-composer.tsx` → `POST /api/conversations/:id/suggest` (exists on `main`). Fills the box and never sends (the E2E counts sends: 0); a typed draft is kept unless "Replace my draft" is chosen; `reply: null` reads "No suggestion this time"; a late answer or one after a send is dropped. Unit `suggest-reply.test.ts`; E2E `inbox.spec.ts` | The real model's suggestions are unseen | Dev 1 (staging) |
| D4-6 | An alert or takeover link opens the right chat (frontend half) | DONE | `?conversation=` and `?chat=` both read (`initial-chat.ts`). **New this run (IB-1):** a chat older than the newest 200 opens too, by id (`fetchConversation`), and the list says when it is cut. Unit `initial-chat.test.ts`, `data.test.ts`; E2E `inbox.spec.ts`, `inbox-limits.spec.ts` (6 × 3 widths) | See AH-1 below | Dev 3 |

### Day 4, shared exit criteria

| Task ID | Requirement | Status | Evidence / files / tests | Remaining work or blocker | Owner |
|---|---|---|---|---|---|
| D4-X1 | The alert shows the lead card, with an inbox button (and an own-number button on a plan that has it) | BLOCKED | `backend/src/notify/staff-alerts.ts:101` sends `headline` and a plain `/dashboard/inbox?conversation=<id>` link. `createHandoffLinks` (`agent/handoff/token.ts`) has **no caller outside its tests**, so a signed `/h/:token` link is never sent (AH-1) | Wire the links and the two buttons into the alert | Dev 2 (alert) + Dev 1 (links) |
| D4-X2 | Staff replies cost 0 credits | UNVERIFIED | Cost 0 in code; backend unit tests pass; no ledger check on staging | Staging | Dev 2 |
| D4-X3 | Return to AI restores AI mode with a system note | UNVERIFIED | `mode.ts` and `mode.test.ts` (unit, a fake database) pass; the screen is mocked | Staging | Dev 3 |
| D4-X4 | Expired, reused and wrong-staff tokens are rejected | UNVERIFIED | `agent/handoff/{token,takeover}.test.ts` (unit) pass: tampered signature, another staff member, 24-hour expiry, one use. Not testable through a real alert until D4-X1 | Staging, after AH-1 | Dev 1 |
| D4-X5 | Own-number takeover is plan-gated and redirects to wa.me | UNVERIFIED | `takeover.ts` gate and `takeover.test.ts` | Staging | Dev 1 |
| D4-X6 | Reminder toggles and scheduled jobs | UNVERIFIED | See section 2 | Staging | Dev 2 |

### Shared, Raja and operational items (not Dev 3's; classified, not changed)

| Task ID | Requirement | Status | Evidence | Remaining | Owner |
|---|---|---|---|---|---|
| OP-1 | `booking-reminders` (24 h, 2 h, offsets in `tenant_features.settings`, cancelled by `booking.changed`) | UNVERIFIED | `inngest/booking-reminders.ts`, `booking/reminders.ts` and tests | Staging at test offsets | Dev 2 |
| OP-2 | `post-visit` (feedback at end + 2 h, review link at 4 to 5, outcome prompt) | UNVERIFIED | `inngest/post-visit.ts`, `booking/post-visit.ts` and tests | Staging | Dev 2 |
| OP-3 | `lead-nudges` (2 h, 24 h, then nurture) | UNVERIFIED | `inngest/lead-nudges.ts`, `leads/nudges.ts` and tests | Staging; the 1 or 2 credits question is Raja's | Dev 2 / Raja |
| OP-4 | `handoff-sla` (escalate to the owner) | UNVERIFIED | `inngest/handoff-sla.ts` and test | Staging | Dev 2 |
| OP-5 | `own-number-outcome` (ask after 4 h) | UNVERIFIED | `inngest/own-number-outcome.ts`, `leads/own-number-outcome.ts` and tests | Staging | Dev 2 |
| OP-6 | `daily-agenda` (8 am tenant time, Growth and Pro) | UNVERIFIED | `inngest/daily-agenda.ts` checks `isEnabled("daily_agenda")` and keys one send per local date | Staging | Dev 2 |
| OP-7 | No-show rebooking | UNVERIFIED | `booking/no-show.ts`, `inngest/noshow-rebooking.ts` and test | Staging | Dev 2 |
| OP-8 | Versioned English and Tamil template catalogue | PARTIAL | `notify/template-catalogue.ts` and test, committed as drafts; wording needs a native speaker; nothing submitted | Review, then submission once a WABA exists | Dev 2 / Raja |
| OP-9 | Google event create, update, free/busy | UNVERIFIED | `booking/google-calendar.ts`, `google-sync.ts`, `inngest/google-calendar-sync.ts` and tests; no real Google project seen | A Google Cloud project and a real consent | Dev 2 / Raja |
| OP-10 | Evening exit tests, including a deliberately angry customer | NOT STARTED | No staging run is recorded. A scripted angry-customer chat exists (mocked models) | Run on staging | All |
| OP-11 | Raja: template submission, entity route status, Tech Provider registration | UNVERIFIED | Nothing in the repository shows the outcome | Raja reports | Raja |

## 2. Pending, by list

**Day 3 still pending:** D3-1e (catalog editor), D3-2 (server-side filters and counts, PG-2), D3-3b and D3-5 (Dev 2), and every D3-X exit criterion (staging).

**Day 4 still pending:** D4-2b (own-number chats can never return to the AI), D4-3b (template picker: the route), D4-4a, D4-4c, D4-4d (entitlement and storage contracts), D4-X1 (the alert), and the staging half of D4-X2 to D4-X6.

**Shared and staging, unverified:** all of D3-X1 to D3-X6, D4-X2 to D4-X6, OP-1 to OP-11. Nothing was run against Supabase, Realtime, Meta, WhatsApp or Google.

## 3. Independent Dev 3 work completed in this run

| Id | What | Tests |
|---|---|---|
| IB-1 | A staff-alert or takeover link to a chat older than the newest 200 now opens it (it was silently selecting nothing); the list says it shows the newest 200, and a chat says it shows the latest 300 messages | Unit `data.test.ts` (+3, written first and seen failing); E2E `inbox-limits.spec.ts` (6 tests × 3 widths: the cut list, no notice when nothing is cut, both link forms, an unknown id, another business's chat never opened) |
| LD-1 | Refresh on the lead detail: reads the lead and its bookings together and replaces the page only if both succeed; says "Not updating live" until `leads` and `bookings` are published | E2E `lead-detail-refresh.spec.ts` (3 × 3 widths) |
| BK-1 | "Service the assistant books" on Booking setup | Unit `booking-service.test.ts` (14, written first); E2E `booking-service.spec.ts` (5 × 3 widths) |
| FL-1 | `knowledge.spec.ts:587`: cause found (the 100 rounds each pay `expect.poll`'s 100 ms back-off), back-off shortened, rounds and assertion unchanged | 9 of 9 repeats pass in 8.7 to 17.2 s (was 20.3 to 22.5 s passing, 39.0 to 44.6 s failing) |
| DOC | Regression matrix: new rows IB-1, BK-1, XM-1, AH-1, updated lead-detail and booking-setup rows, flake notes. Two stale comments corrected (`inbox/data.ts`, `inbox/chat-view.tsx`) | none needed |

Test support changed so these can be proven: `mock-supabase.mjs` now answers conversation reads newest first and at most `limit`, stores `agent_settings`, and can seed many chats; `day3.ts` has the matching options.

**Not done on purpose:** the template picker, the own-number option, the takeover preference and alert preferences (blocked, above); server-side leads filters (a design choice with Dev 2, larger than this run); a catalog editor (needs a product decision).

## 4. Commands run and results

Run on this machine with `corepack pnpm` (pnpm is not installed; a `pnpm.cmd` shim in the scratchpad let Playwright's web servers start). All numbers are from this run.

| Command | Result |
|---|---|
| `pnpm typecheck` (all workspaces) | exit 0: `packages/types`, `backend`, `frontend` |
| `pnpm lint` (all workspaces) | exit 0 |
| `pnpm --filter @pakka/frontend test` (Vitest) | **45 files, 812 passed, 4 todo, 0 failed** (baseline before this run: 793) |
| `pnpm test` backend (Vitest, 159 files) | 3,617 passed, **1 failed**: `lint-rules/no-industry-branching.test.ts` "a comparison with a name that says vertical" timed out at 5,000 ms (took 5,147 ms) while 159 workers ran. The same file passed 30 of 30 on three isolated runs (about 3 s each). No file under `backend/` is modified. `packages/types`: 109 passed (5 files). Because `pnpm -r` stops at the first failure, the frontend ran separately, above |
| New and changed E2E, three widths, run alone | `inbox-limits` 19 passed (incl. setup); `lead-detail-refresh` 10 passed; `booking-service` + `booking-setup` 55 passed and 3 failed on my first draft (an expected 403 reached the console guard), fixed with the suite's own pattern |
| Full Playwright (`playwright test`) | **909 passed, 13 skipped, 9 failed** in 18.8 min (10.7 min earlier): 8 mobile failures were browser crashes (`Target crashed`, `insufficient memory`, GPU launch failures) on a 15.9 GB machine with other applications open; the 9th was `knowledge.spec.ts:587` |
| Rerun of the 3 files with failures (184 tests) | 174 passed, 9 skipped, **1 failed**: `knowledge.spec.ts:587` on tablet (44.6 s). All 8 mobile failures passed |
| `knowledge.spec.ts:587` after the back-off change, `--repeat-each=3` | 9 of 9 passed |

**Not run:** `pnpm db:test`, `scripts/db/*.sh` (no Docker), `pnpm test:conversations`, anything against staging or live providers. **A baseline Playwright run of an unmodified checkout was not made**, so "no regression from the uncommitted work" rests on the failing test and the crashed ones not touching changed code, and on the earlier report of the same `knowledge.spec.ts:587` failure before this run's changes.

A final full Playwright run after the last edit to `knowledge.spec.ts` was not made: that edit changed one test's poll interval and was verified by the nine repeats above.

## 5. Risks

1. **Own-number chats cannot return to the AI (XM-1).** The route refuses it, the screen follows the route, and Dev 1's note says that is the way back. A business using own-number takeover has chats that stay with a person forever.
2. **The staff alert has no card, no buttons and no signed link (AH-1).** Day 4 exit tests 2 to 4 cannot pass end to end until it does.
3. **Template picker blocked at a route Dev 3 owns (D4-3b).** The send layer is ready; the route rejects the field.
4. **Row-level security does not check the role (RL-1).** Any member can write services, resources and, now, `tenants.agent_settings` straight to the database; only the page hides the controls from staff. The new setting inherits this.
5. **Test flakiness.** `knowledge.spec.ts:587` is mitigated, not removed. A full run on this machine at 4 workers can exhaust memory; the backend lint-rule test has a 5 s limit that a loaded run can pass (Dev 1's file).
6. **Merge friction.** `origin/main` already holds #116 to #119 (the earlier uncommitted work). My edits touch `features/inbox/inbox-screen.tsx`, `tests/e2e/support/mock-supabase.mjs` and `tests/e2e/regression-matrix.md`, which those PRs also changed, so expect conflicts there.
7. **No paging for a chat's history.** A chat shows its latest 300 messages and now says so; earlier ones cannot be reached from the inbox.
8. **Security checked, no finding.** The lead-card client drops the customer's full phone number before it reaches the page; the API client sends the tenant only in `X-Pakka-Tenant` and the backend checks it against the session; model and server error text is never shown raw (`formatError`).

## 6. Files changed by this run, and Git status

Edited: `features/inbox/{data,data.test,inbox-screen,conversation-list,chat-view}`, `features/leads/lead-detail.tsx`, `features/settings/booking-setup-screen.tsx`, `tests/e2e/app/knowledge.spec.ts`, `tests/e2e/support/{mock-supabase.mjs,day3.ts}`, `tests/e2e/regression-matrix.md`.
New: `features/settings/{booking-service.ts,booking-service.test.ts,booking-service-section.tsx}`, `tests/e2e/app/{inbox-limits,lead-detail-refresh,booking-service}.spec.ts`, this file.

Git: branch `main` at `602e26e`, **behind `origin/main` by 4** (not by this run), nothing staged, nothing committed, 2 stashes and 22 branches untouched. `git diff --check` reports no whitespace errors (only the repository's existing LF/CRLF notices).

## 7. Next three priorities

1. **Sync, then split and commit.** Everything of this run and the earlier uncommitted work exists only in this checkout, and `origin/main` has moved. Pull #116 to #119, resolve the three overlapping files, and open small PRs (inbox limits; lead-detail refresh; booking service; the poll fix). Reason: unmerged work is the largest risk to Dev 3's progress.
2. **Get the three cross-owner blockers decided.** AH-1 (alert uses the signed links and buttons: Dev 2 with Dev 1), D4-3b (route accepts a template, then build the picker: Dev 3 and Dev 2), and XM-1 (can an own-number chat return to the AI?). Plus a readable `handoff_own_number` entitlement and an alert-preferences contract. Reason: they stop Day 4 exit tests 2 to 4 and four of Dev 3's Day 4 items.
3. **Leads filters and counts over the whole business (PG-2), and the staging script (ST-1).** The filters are the one Day 3 Dev 3 requirement that is only partly met for businesses with more than 200 leads, and a script for the two-business staging check turns this report's UNVERIFIED rows into evidence. Reason: both are Dev 3's and need no one else except Dev 2's counts decision.
