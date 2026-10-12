# Spark Agent / Pakka Agent — Weekly Engineering Report, Day 0 to Day 4

**Role:** Dev 3 — Frontend, Dashboard and Integration
**Reporting commit:** `main` at `072cf8c7c2457fbb0da866133543f8072dd6e51b` (9 Oct 2026, 17:03 +0530, "feat(consent): privacy notice on the first AI reply and STOP handling", #69), **plus 30 uncommitted paths in the working tree** (14 modified, 16 new files or folders; all under `frontend/`). The local `main` matched `origin/main` at the last fetch state available offline; no `git fetch` was performed.
**Audit date:** 9 Oct 2026 (checks run between about 18:40 and 19:00 IST)
**Report status:** Draft for the team. Nothing in this report was staged, committed or pushed, and no source file was edited to produce it.

---

---

## 1. Title and reporting scope

### How this report was produced, and its limits

Everything below comes from the local repository, its Git history and checks that were run on this machine during the audit. Claims are marked with the file that supports them. Where something could not be checked, the report says so.

Three limits matter for reading it:

1. **No day-by-day task document exists in the repository.** The only planning documents are `docs/handover.md` (milestones M0 to M6 with per-developer checklists) and `docs/dev2-roadmap.md` (Dev 2 only). "Day N" appears as a label inside commit messages, code comments and contract documents, not as a task list. The per-day "planned responsibilities" below are therefore **reconstructed** from the handover milestones, the "Day N" labels, and the Day 2/3/4 scopes in the audit brief. Day 0 and Day 1 requirements for Dev 3 could not be independently reconstructed beyond the M0 checklist. Calendar dates do not map one-to-one to Day numbers (Day 2 and Day 3 work overlap on 8 Oct; Day 4 UI work landed on 9 Oct).
2. **No real Supabase, staging, live WhatsApp or live Realtime check was possible or run.** Every "tested" claim here is a unit test, a mocked browser test, or a test against a stand-in server.
3. **`pnpm` is not installed on this machine.** The checks were run through the repository's local binaries (`tsc`, `eslint`, `vitest`, `playwright`), which is what the `pnpm` scripts call, plus a temporary `corepack pnpm` shim outside the repository so Playwright could start the API. This is a local-machine fact, not a repository fault.

Status words used in this report:

| Word | Meaning |
|---|---|
| **DONE — VERIFIED** | Works and was confirmed against the real thing (real database, API, provider). *Nothing in this report reaches this level for live behaviour.* |
| **IMPLEMENTED — MOCK/UNIT TESTED** | Built and passing unit or mocked-browser tests. Says nothing about the real backend. |
| **PARTIAL** | Part is built; part is missing or unverified. |
| **BLOCKED** | Cannot be finished until the named owner delivers the named thing. |
| **NOT STARTED** | Nothing built yet, and nothing is blocking it. |
| **BROKEN** | Built or wired, and wrong. |
| **EXTERNAL VERIFICATION REQUIRED** | The code is done; only a real database, staging or provider can prove it. |

---

## 2. Executive summary

### What was delivered

Across Day 0 to Day 4 I authored **21 commits on `main`** (of 82 non-merge commits on `main`; Dev 2 has 31 and Dev 1 has 30), plus a body of uncommitted work. In plain terms:

- **A working signed-in dashboard** with auth, tenant resolution and a shell, built on top of the original prototype, which is kept at `/dashboard/preview` as the visual reference.
- **Inbox (Day 2):** conversation list, chat history, AI / Needs human / Human tags, masked phone numbers, filters and search, an inbox-wide Realtime subscription with resync, and empty, loading and error states.
- **Knowledge base (Day 2):** services and prices (add, edit, delete), document upload with live status and server error text, FAQs (add, edit, delete, retry of FAQs the AI could not use yet) and the "questions the AI couldn't answer" list.
- **Leads, lead detail, calendar, booking setup (Day 3):** a stage board with temperature and score filters, lead detail with collected answers and a timeline, a read-only day and week calendar in the business's time zone, and settings for hours, staff, resources and services including Google Calendar connect status.
- **Takeover and handoff UI (Day 4):** a pinned lead-card panel, AI / Human switch with Return to AI, a staff reply box that respects the 24-hour window, and a personal WhatsApp alert-number setting on the Team page. The two backend routes these need were also written by me (`/api/conversations/:id/messages` and `/mode`).
- **WhatsApp onboarding:** "Use my own Meta app" connect flow (frontend plus its backend routes and migration `0020`).
- **Uncommitted, this week:** WhatsApp calls now send a validated tenant header; the leads board loads in pages of 200 with "Load more"; Refresh buttons on the board and calendar; a Realtime guard that only subscribes to tables the database actually publishes; a provisional lead-card adapter; loading-state tests; and a rewritten regression matrix.

### Current completion status

**What is true:** the screens render, behave correctly and are well covered by unit and mocked-browser tests. **What is not true:** none of these workflows has been verified end to end against a real database, real Realtime or a live WhatsApp number.

The most useful measure is the tally of the 29 remaining-work items in section 7, counted from the statuses assigned there (this is a count of open items, not a completion percentage; PG-1 is counted once, as PARTIAL, though it also needs a real-database check):

| Status | Items |
|---|---|
| BROKEN | 1 (AL-1) |
| BLOCKED (by a named developer) | 15 |
| PARTIAL | 5 |
| EXTERNAL VERIFICATION REQUIRED | 3 |
| NOT STARTED | 5 |
| **Total** | **29** |

### Highest-risk issues

1. **The staff-alert link opens the wrong place (AL-1, BROKEN).** The backend builds alert links as `/dashboard/inbox?conversation=<id>` (`backend/src/notify/staff-alerts.ts:100`). The Inbox page reads only `?chat=<id>` (`frontend/app/(dashboard)/dashboard/(app)/inbox/page.tsx:16`). A staff member tapping an alert lands on the inbox list, not the chat. I can fix this alone.
2. **Leads and bookings are not live.** `leads` and `bookings` are not in the `supabase_realtime` publication in any migration, so the board and calendar need the Refresh button. The UI says so honestly; the fix is a Dev 2 migration.
3. **Nothing scores leads yet.** No code in `backend/src` writes `score`, `temperature` or the `qualified` stage, so every real lead reads "Not scored" and the hot / warm / cold filters have nothing to show in live use (Dev 1).
4. **The WhatsApp dashboard panel can say "Connected" while the webhook is unverified (WA-2).** The backend saves a manually connected number as `active` while the `webhook_subscribed` check stays `not_verified`; the panel maps `active` to "Connected — your assistant replies to customers from this number." (`frontend/components/dashboard/whatsapp-connection-panel.tsx:11`). The connection view does expose `last_check`, so I can show the check state myself once Raja agrees the wording.
5. **The current Playwright result is worse than the previous report.** The full suite is 781 tests, not 394; 766 passed, 13 skipped and **2 failed**. Both failures passed when rerun on their own (section 5), so they are logged as not reproduced, not as fixed.
6. **All of this week's Dev 3 work is uncommitted.** If this checkout is lost, it is lost. It needs review and splitting into pull requests (see P0-1).
7. **Dev 3 also authored backend and migration code.** Commits #78, #79, #82 and #83 changed `backend/` and added migration `0020`; commit #36 added migration `0010`. The handover assigns the conversation routes to Dev 3, but the WhatsApp connect routes and webhook-handshake changes sit in Dev 1's area. See section 4 for what needs a named reviewer.

### Have the end-to-end workflows been verified?

**No.** Not one workflow (inbox with real messages, takeover with a real WhatsApp send, knowledge ingestion to an answer, lead to booking to calendar, staff alert to inbox) has been run against staging or real providers. The table in section 8 lists each Day 2 to Day 4 exit criterion with its honest status.

---

## 3. Day-by-day contribution report

All commits below are yours (`dhatri` / `Dhatripatel06`) on `main`, with their merge dates. Test files are counted in the totals but not listed again.

### Day 0 (5 Oct)

**Planned responsibilities (reconstructed, M0 checklist):** "Next.js shell, auth with WhatsApp/phone OTP, dashboard layout, 'send message' and 'create template' screens for Meta App Review" (`docs/handover.md`, M0). Repo, CI, Supabase and Inngest setup are Dev 2's Day 0 items (`docs/dev2-roadmap.md`).

**Work implemented (evidence):**

| Commit | What it did |
|---|---|
| `e376cf7` (#3) consolidate frontend into monorepo — 119 files, +13,312/−180 | Merged the two separate Next.js prototype exports (dashboard and onboarding) into `frontend/` on Next 16, moved the Day 0 scaffold into `backend/` and `frontend/` (19 pure renames such as `src/inngest/*` to `backend/src/inngest/*`), added the `components/ui` kit and the dashboard fixtures. Visual output was held identical (the 213-state baseline in `docs/frontend-architecture-map.md`). |

**Honest note on authorship:** the original prototype exports predate the repository; this commit is the consolidation, not the design of the prototypes.

**Tests and verification:** Playwright dashboard and onboarding suites against the prototype (`frontend/tests/e2e/dashboard/*`, `onboarding/*`). The baseline claim ("0 of 213 differ") is recorded in the architecture map; it was not re-run in this audit.

**Blockers / outstanding:** the M0 item "auth with WhatsApp/phone OTP" is **not done** as written. The sign-in that exists is email and password plus Google (see Day 1/2). The onboarding "Verify phone" step uses a dummy code (the E2E test is named "…with the same dummy WhatsApp code and no email code"). The handover lists the login method as an open decision for "Dev 3 + Raja" (`docs/handover.md`, open questions). Tracked as AU-1.

### Day 1 (6 Oct)

**Planned responsibilities (reconstructed):** M0's Meta App Review screens, plus aligning to the Day 1 contract freeze (`docs/contracts.md`, "Day 1 freeze", Dev 2's PR #20).

| Commit | What it did |
|---|---|
| `8b598c1` (#15) WhatsApp messaging and template screens — 76 files, +4,484 | "Send test message" and "Create template" screens, API client, shared types (`packages/types/src`), auth session helpers. These are the two screens Meta App Review needs. |
| `915fae4` (#23) align WhatsApp contracts — 15 files | Brought the screens and types in line with the frozen send/template/error contracts (`docs/shared-types.md`). |
| `181c7ba` (#26) create the trial business on the Business step — 15 files | Onboarding's Business step now creates exactly one real trial through the API (`lib/onboarding`). |

**Tests and verification:** the API client and error formatting have unit tests today (`lib/api/client.test.ts`, `lib/errors.test.ts`); I could not tell from history which were added on Day 1. Mocked E2E `messaging.spec.ts` (17 tests) and `trial-signup.spec.ts`. These run against the mock Supabase and a real local copy of the API, never Meta.

**Blockers encountered (recorded at the time in `docs/frontend-architecture-map.md`, "Day 1 dependencies still open"):** the WhatsApp adapter, Meta template submission and Embedded Signup route were not built yet. Several of these have since been built by Dev 1; the table in that document is now stale (see DOC-1).

### Day 2 (7–8 Oct) — Inbox and knowledge-base UI

**Planned responsibilities (reconstructed, M1):** "inbox (realtime), conversation view, KB editor (services, prices, FAQs), website import screen".

| Commit | What it did |
|---|---|
| `96edf62` (#35) auth UX; `cede280` (#39) auth flow and rebrand to Spark Agent | Production auth routing, password reset, sign-up and the Spark Agent rebrand. Google sign-in, email confirmation, redirect safety and tenant resolution are covered by `lib/auth/*` and their E2E specs; I did not attribute each to a single commit. |
| `917802a` (#43) auth, rebrand and dashboard hardening | Squashed from three changes: auth/rebrand, a test update, and "harden dashboard UX and regression coverage": WhatsApp connection panel with a plain explanation per status, Recheck and Disconnect shown **switched off** until the API has those routes, Embedded Signup preparation (not wired), skip-to-content link, sample-data bar on `/dashboard/preview`. |
| `23eeb5a` (#36) inbox read path — 33 files, +4,539 | Inbox list and chat reading `conversations`, `contacts`, `handoffs`, `messages` under RLS with an ordered-read guard; one Realtime channel `inbox:<tenantId>`; **migration `0010_inbox_realtime.sql` (adds `messages`, `conversations`, `handoffs` to the Realtime publication) and its pgTAP test `supabase/tests/inbox_rls.test.sql`**; first knowledge-base screens. |
| `bdda1b2` (#47) integrate knowledge-base contract | FAQs, documents and gaps wired to the `/api/kb/*` contract (`features/knowledge/kb-api.ts`). |
| `a0524c6` (#55) complete Day 2 frontend integration — 20 files | Inbox renders the inbound kinds the webhook stores (image, document, voice, location, sticker, interactive) as placeholders; no Recheck/Disconnect on Spark Agent's own numbers; trial copy says 300 credits; clear wording when a KB route is not deployed; KB mock aligned to the contract. |
| `94f5320` (#61) offer only trades with an active vertical pack | Onboarding no longer offers trades that have no pack. |
| `2071b77` (#62) document upload status and errors | Uploading → Processing → Ready on Realtime, polling when Realtime is off, the server's error text, 5 MB and file-type refusals before sending. |
| `359cee3` (#73) recover FAQs the AI can't use yet | Saving such an FAQ again retries preparing it. |

**Audit of the Day 2 areas:**

| Area | Status | Evidence |
|---|---|---|
| Inbox list and message history | IMPLEMENTED — MOCK/UNIT TESTED | `features/inbox/*`; unit `data.test.ts` (49); E2E `app/inbox.spec.ts` |
| Realtime and mode badges | IMPLEMENTED — MOCK/UNIT TESTED | `features/inbox/use-inbox-realtime.ts` (tables `messages`, `conversations`, `handoffs`, resync at most every 10 s); tags AI / Needs human / Human in `conversation-list.tsx`. E2E emulates the Phoenix protocol with `routeWebSocket`; **never seen on a real Realtime server**. |
| KB editor: services | IMPLEMENTED — MOCK/UNIT TESTED | `features/knowledge/*` (direct `services` writes under RLS); E2E `app/knowledge.spec.ts` (37 tests) |
| FAQs, gaps, document upload | IMPLEMENTED — MOCK/UNIT TESTED | Routes exist on `main` (`backend/src/server/routes.ts` lines 153–159). E2E stands the routes in with `page.route` (`tests/e2e/support/kb-api.ts`), so these tests prove the screen follows the contract, **not** the real backend, embeddings or Inngest. |
| Website import screen | **PARTIAL** | The onboarding "Teach" step (`components/onboarding/step-teach.tsx`) runs on simulated timers; no import route exists in `backend/src/server/routes.ts`. Tracked as WI-1. |
| Empty, loading, error states | IMPLEMENTED — MOCK/UNIT TESTED | Shared `components/shared/states.tsx`; E2E in `knowledge.spec.ts`, `inbox.spec.ts` (loading state added this week, uncommitted) |
| Tenant isolation | IMPLEMENTED — MOCK/UNIT TESTED | Every read filters on `tenant_id`; E2E "other business's rows never shown" proves the **screen's own filter**, not RLS. RLS is covered by pgTAP files in `supabase/tests/` that were **not run** (need Docker and a local Supabase). |

**Needs real verification before it counts:** RLS on `messages`, `conversations`, `handoffs`, `kb_documents` (pgTAP, `pnpm db:test`); Realtime delivery from a real project (also: whether the hosted `supabase_realtime` publication really contains the four tables); document ingestion to a searchable answer (Inngest and the embeddings provider); WhatsApp messages actually appearing in the inbox.

### Day 3 (8 Oct) — Leads, settings and calendar

**Planned responsibilities (reconstructed, M2):** "leads board, lead detail, calendar view, services and resources settings".

| Commit | What it did |
|---|---|
| `c534136` (#57) Day 3 leads and booking views — 40 files, +5,129 | Leads board and lead detail, read-only calendar, booking setup (hours, staff and resources, services with length, gap and minimum notice). Squashed together with the Day 2 integration commit, so its message repeats #55. |
| `fb53f65` (#58) connect Google Calendar per staff member from booking setup — 8 files | The frontend side of Dev 2's Google Calendar connect route (`/api/calendar/google/connect`, #54): status per staff member, redirect to consent, outcome after the callback. The Google side is stood in; no real consent flow was run. |

**Audit:**

| Area | Status | Notes |
|---|---|---|
| Services and resources settings | IMPLEMENTED — MOCK/UNIT TESTED | `features/settings/*`; E2E `booking-setup.spec.ts` (14). The page hides edits from staff, **but RLS lets any member write services and resources** (`0002_packs_and_bookings.sql`); tightening this is Dev 2 (RL-1). |
| Leads board, filters, score and temperature display | IMPLEMENTED — MOCK/UNIT TESTED | Score and temperature are shown exactly as stored and never computed. Unit tests read migrations `0001`, `0002`, `0015` and fail if the screen's stage, temperature and booking-status lists drift (`features/leads/contract-shapes.test.ts`). |
| Lead detail, answers, timeline | IMPLEMENTED — MOCK/UNIT TESTED | Answers labelled from the business's pack; timeline built from `conversations`, `handoffs`, `messages`, `bookings`. The time a handover opened is missing: `handoffs` has `picked_at` and `resolved_at` but no opened time (`0001_init.sql`). |
| Day / week calendar, times, staff assignment | IMPLEMENTED — MOCK/UNIT TESTED | Business time zone, not the viewer's; one column per staff member; bookings with no one assigned get their own column; expired holds and replaced bookings never read as appointments. |
| Booking timestamps | **BLOCKED** | `bookings` has only `created_at` (`0001_init.sql`; `0015` adds no status-change time). Every timeline line sits at `created_at`. |
| Pagination, filtering, loading, refresh | See "Latest work" below | Uncommitted this week. |
| Booking data and Realtime dependencies | BLOCKED / EXTERNAL | `bookings` and `leads` are not published to Realtime (verified in migrations); Google Calendar events on the grid need Dev 2's sync. |

**Rendering versus receiving live data.** The Day 3 screens render correctly from rows shaped like the database's. That proves the **display logic**. It does not prove that the real agent produces those rows: nothing writes lead scores today, the real booking functions (`0015`) have not been driven by a real chat, and the mock Supabase compares timestamps as plain strings where Postgres compares real `timestamptz` values.

### Day 4 (9 Oct) — Inbox takeover and handoff UI

**Planned responsibilities (reconstructed, M3):** "lead card panel, AI/human switch, AI-suggested reply, team and alert preferences".

| Commit | What it did |
|---|---|
| `c10a864` (#74) personal WhatsApp alert number | Team page, first slice: each member sets or removes their own alert number (E.164, own row only under RLS). |
| `2053fa1` (#75) tenant-scoped lead card panel | Pinned beside the chat from 1180 px, a sheet below; score, stage, labelled answers, handover, booking, link to the lead; never another chat's lead. |
| `46f494f` (#78) connect your own Meta app | Frontend panel **and** backend: `GET /api/whatsapp/webhook-config`, `POST /api/whatsapp/manual`, `POST /api/admin/whatsapp/manual`, per-business verify token (migration `0020`), handshake and signature changes. |
| `f3fb9b7` (#79) staff reply and takeover | Frontend switch and reply box **and** backend `POST /api/conversations/:id/messages`, `POST /api/conversations/:id/mode`, shared types (`packages/types/src/conversation.ts`). |
| `71246ca` (#82) audit log on connect; `df9aa61` (#83) Return to AI closes the chat's open handoffs | Backend fixes following review. |

**Audit:**

| Area | Status | Notes |
|---|---|---|
| Pinned lead-card panel | IMPLEMENTED — MOCK/UNIT TESTED | Shows **stored** data only (leads, bookings, handoffs). The AI-written rows are not live (LC-1). |
| AI / Human switch, Return to AI | IMPLEMENTED — MOCK/UNIT TESTED | Backend tests: 111 passed across the conversation, connect and alert files (section 5). Real send to WhatsApp, and Return to AI with a real database, **not tested**. The Return-to-AI note is a fixed sentence, not a summary (stated in the PR). |
| Staff reply and the 24-hour window | IMPLEMENTED — MOCK/UNIT TESTED | The API refuses free text outside the window (`outside_window`) and for opted-out customers; the UI shows the closed-window strip; a failed send whose outcome is unknown never retries on its own. The AI-mode refusal is a 409 `conflict`. |
| Team settings and takeover preferences | **PARTIAL** | Only the alert number exists. The takeover preference (`memberships.takeover_pref`) is not shown because nothing reads it (TP-1). |
| Plan-gated own-number option | BLOCKED | No eligibility the browser can read (OW-1). |
| Template picker | BLOCKED | The API answers `not_available` to a `template` field (TM-1). |
| AI-suggested reply | BLOCKED | No route or types exist (SR-1). |
| Staff-alert deep links, conversation selection | **BROKEN** | See AL-1. `?chat=` selection itself works and is tested. |
| Connection-status UI | PARTIAL | Six states are covered by E2E; Recheck and Disconnect are shown switched off because no routes exist (WA-4); "Connected" can be shown with the webhook unverified (WA-2). |
| `/h/:token` takeover link | BLOCKED | The handover's inbox/own-number buttons point to `/h/{token}?mode=…`; no such route exists in `backend/src` (HD-1, Dev 1). |

### Latest Dev 3 work this week (uncommitted), verified against the code

I read the code and ran the tests rather than accepting the earlier report. Findings:

**1. WhatsApp tenant header — confirmed.**
- `frontend/lib/api/tenant.ts` (new, 36 lines) wraps the same `resolveTenant` function the dashboard gate and the API use; it reads the signed-in user's memberships under RLS and remembers nothing between calls.
- `frontend/lib/whatsapp/manual-connect.ts`: `loadWebhookConfig(tenantId, …)` and `submitManualConnect(form, tenantId)` both pass `tenantId` to `apiFetch`, which sets `x-pakka-tenant` next to the bearer token (`frontend/lib/api/client.ts`). A tenant id that is not a GUID sends no request.
- `step-whatsapp.tsx` resolves the business on every read; `own-app-connect.tsx` resolves it **again at submit** and, if the business changed since the webhook details were shown, refuses to send, shows a message and reloads the details. With no business, several businesses, or signed out, nothing is sent and the screen says why.
- Backend side: `requireTenant` (`backend/src/server/auth.ts`) compares the header with the caller's memberships, so the header is a request, not authorization.
- One precision on "tenant changes trigger a recheck": the recheck happens at **submit** and on **retry or re-open**, not by watching for a business change live.
- Tests: unit `manual-connect.test.ts` (30), `tenant-header.test.ts` (6, real API client with a fake `fetch`), `tenant.test.ts` (6); E2E `onboarding.spec.ts` checks the header and bearer on both calls, but the routes there are `page.route` stubs.
- **Not proven:** the real API accepting the header for a member and refusing a non-member (needs a running API and database).

**2. Lead-card preparation — confirmed as UI preparation only.**
- `features/inbox/lead-card-provisional.ts` transcribes the *proposed* `LeadCard` from `docs/dashboard-screen-contracts.md` and lists seven open questions for Dev 1. `fixtures/inbox/provisional-lead-card.ts` is invented sample data.
- `lead-card-panel.tsx` accepts an optional `ai` field. A search of `features`, `components`, `app` and `lib` shows **nothing outside tests supplies it**, so production shows exactly what it showed before. When the field is supplied, the panel labels it as a sample.
- No `LeadCard` exists in `packages/types` and no lead-card route exists in `backend/src/server/routes.ts`. This is **not** a live lead-card integration.
- Tests: `lead-card-panel.test.ts` (20), including text that must never be treated as markup and "never another chat's summary".

**3. Pagination and dashboard improvements — confirmed, with limits.**
- `features/leads/data.ts`: `LEAD_PAGE_SIZE = 200`; `fetchLeadsPage` orders by `updated_at` then `id` (descending), filters by `tenant_id`, and pages by value with `or=(updated_at.lt.X,and(updated_at.eq.X,id.lt.Y))`. The cursor keeps the raw timestamp string from the database. A full page with an unreadable last row throws instead of guessing.
- `features/leads/paging.ts` is a pure reducer: a generation number drops answers for an older business or try; a late or repeated page is ignored; leads are de-duplicated by id; refresh merges by id and starts over when a burst of more than a page may have left a gap.
- `leads-board.tsx`: "Load more leads" button, "Showing the N most recently updated leads" notice, and counts shown as `200+` while older leads are unread.
- **Limit:** the temperature and score filters and the counts run over the leads **already loaded**, not the whole business. Exact counts need a server-side contract (PG-2).
- **Not proven:** the keyset filter against a real PostgREST and a real `timestamptz`. The mock server (`mock-supabase.mjs`) implements the filter with a string comparison. Test data uses a microsecond timestamp in PostgREST's format, which is a good sign but not proof.
- Unit `paging.test.ts` (32 tests, including 1,234 leads through the real `fetchLeadsPage`); E2E `leads-paging.spec.ts` (7).

**4. Realtime safeguards — confirmed, and honestly switched off for leads and bookings.**
- `frontend/lib/realtime/published-tables.ts` lists `messages`, `conversations`, `handoffs`, `kb_documents`. I checked the migrations: `0010_inbox_realtime.sql` adds the first three and `0011_knowledge_base.sql` adds `kb_documents`; **no migration on `main` or on any remote branch adds `leads` or `bookings`**.
- `published-tables.test.ts` (5) reads the migration files and fails if the list and the migrations disagree.
- `table-changes.ts`: a channel per screen and business, filtered on `tenant_id=eq.<id>`; events naming another business are ignored; bursts are coalesced into one re-read; a reconnect re-reads at most every 10 s; cleanup removes the channel and drops pending reads. For a table that is not published it reports `unavailable`, and `RefreshControl` says "Not updating live. Use Refresh."
- Tested only against a **fake client** (`table-changes.test.ts`, 16). **Live Realtime for leads and bookings does not work and has not been seen working for anything on a real server.** One caveat: if the hosted project's `supabase_realtime` publication were `FOR ALL TABLES`, migration `0010` would skip its `add table` step and `leads` and `bookings` would be published anyway; only a query on the hosted project can say (RT-8).

**5. Loading states and regression coverage — confirmed.**
- New E2E: `leads-paging.spec.ts` (7), `loading-and-refresh.spec.ts` (7); added to `inbox.spec.ts` (loading chats) and `onboarding.spec.ts` (header test); support changes in `mock-supabase.mjs` (`manyLeads`) and `day3.ts`.
- New unit: `refresh-control.test.ts` (5), `booking-lifecycle.test.ts` (45 + 4 todo), `contract-shapes.test.ts` (58), `score-badge.test.ts` (13), plus those named above.
- `frontend/tests/e2e/regression-matrix.md` was substantially rewritten (about 230 changed lines) with evidence levels and an integration tracker. It was checked against the code in this audit; it matched on every point I tested, with the exceptions listed under AL-1, WA-2 and DOC-1.

---

## 4. Files and implementation evidence

### Main modules (committed)

| Module | Purpose | Tests |
|---|---|---|
| `frontend/app/(dashboard)/…`, `components/dashboard/*`, `lib/auth/*` | Signed-in shell, tenant gate, sign-in / sign-up / reset / Google | `lib/auth/*.test.ts`, `app/auth.spec.ts`, `signup.spec.ts`, `google.spec.ts`, `password-reset.spec.ts`, `no-business.spec.ts` |
| `features/inbox/*` | Conversation list, chat, Realtime, staff reply, mode switch, lead-card panel | `data.test.ts` (49), `lead-card-data.test.ts` (14), `staff-reply.test.ts` (5), `conversation-mode.test.ts` (7); `inbox.spec.ts` (24), `inbox-lead-card.spec.ts` (8) |
| `features/knowledge/*` | Services, documents, FAQs, gaps | 116 unit tests across 5 files; `knowledge.spec.ts` (37) |
| `features/leads/*`, `features/calendar/*` | Board, lead detail, calendar | `data.test.ts` (38), `calendar.test.ts` (20); `leads.spec.ts` (9), `calendar.spec.ts` (9) |
| `features/settings/*` | Booking setup, Google Calendar status | 40 unit tests; `booking-setup.spec.ts` (14), Google Calendar status tests inside `booking-setup.spec.ts` |
| `features/team/*` | Alert number | `alert-number.test.ts` (11); `team.spec.ts` (5) |
| `components/onboarding/*`, `lib/whatsapp/*` | Wizard, own-Meta-app connect | `manual-connect.test.ts` (30), `embedded-signup.test.ts` (29); `onboarding.spec.ts` (16) |
| Dev 3-authored **backend** code | `backend/src/conversations/{staff-reply,mode}.ts`, `backend/src/channels/whatsapp/connect/{manual,webhook-token}.ts`, routes in `server/routes.ts`; migrations `0010`, `0020`; `packages/types/src/conversation.ts` | 111 backend tests passed in this audit for these files and the staff-alert file |

**Cross-area authorship that needs a named reviewer.** The handover lists the conversation `messages` and `mode` routes as Dev 3's, so #79 is in scope. The WhatsApp connect backend (#78: manual connect, webhook-config, handshake and signature changes touching `inbound.ts`, `verify-challenge.ts`, `crypto.ts`, `env.ts`) belongs to Dev 1's module 10, and migrations `0010` and `0020` are in Dev 2's area. I could not see pull-request reviews from the repository, so I cannot say who approved them. Recommend confirming that Dev 1 signed off #78 and Dev 2 signed off migrations `0010` and `0020`.

### Uncommitted work (new / changed)

New: `lib/api/tenant.ts`, `lib/realtime/{published-tables,table-changes,use-table-refresh}.ts`, `components/shared/refresh-control.tsx`, `features/leads/paging.ts`, `features/inbox/lead-card-provisional.ts`, `fixtures/inbox/provisional-lead-card.ts`, tests `lib/api/tenant.test.ts`, `lib/realtime/*.test.ts`, `components/shared/refresh-control.test.ts`, `features/leads/{paging,contract-shapes,score-badge}.test.ts`, `features/calendar/booking-lifecycle.test.ts`, `features/inbox/lead-card-panel.test.ts`, `lib/whatsapp/tenant-header.test.ts`, `tests/e2e/app/{leads-paging,loading-and-refresh}.spec.ts` — **16 untracked entries, about 2,700 lines**.
Changed: `lib/whatsapp/manual-connect.ts`, `components/onboarding/{step-whatsapp,own-app-connect}.tsx`, `features/leads/{data,leads-board}`, `features/calendar/calendar-screen.tsx`, `features/inbox/lead-card-panel.tsx`, `tests/e2e/{app/inbox.spec,onboarding/onboarding.spec,regression-matrix.md,support/mock-supabase.mjs,support/day3.ts}`, `features/leads/data.test.ts`, `lib/whatsapp/manual-connect.test.ts` — **14 files, +660/−81**.

The repository's own rule is pull requests of about 400 changed lines. This work is roughly 3,400 lines and should be split (see P0-1).

---

## 5. Testing and verification report

### Commands run on 9 Oct 2026

| Check | How it was run | Exit | Result |
|---|---|---|---|
| TypeScript | `next typegen` then `tsc --noEmit` in `frontend/` (what `pnpm --filter @pakka/frontend typecheck` runs) | 0 / 0 | Passed. |
| ESLint | `eslint` in `frontend/` | 0 | Passed, no output. |
| Vitest (frontend) | `vitest run` in `frontend/` | 0 | **716 passed, 4 todo, 0 failed, 40 files** (720 tests). |
| Playwright (frontend, mocked) | `playwright test` over the setup + desktop (1440), tablet (820) and mobile (390) projects; production build, real local API, mock Supabase | 1 | **781 tests: 766 passed, 13 skipped, 2 failed** (10.7 min). |
| Rerun of the 2 failures | `playwright test knowledge.spec.ts:587 navigation.spec.ts:56 --project=desktop` | 0 | Both **passed** in isolation. |
| Vitest (backend, subset) | `vitest run` on `src/conversations`, `server/conversation-routes`, `server/whatsapp-connect-routes`, `channels/whatsapp/connect`, `notify/staff-alerts` | 0 | 111 passed, 7 files. |

The first Playwright attempt failed to start because `next` and `pnpm` were not on `PATH` (a local-machine issue, not a test failure); the numbers above are from the second, complete run.

### The two Playwright failures

| Test | Symptom | After rerun alone | Assessment |
|---|---|---|---|
| `knowledge.spec.ts:587` "stops polling after the polling window and offers Check again" (desktop) | 30 s test timeout | Passed | Timing-sensitive under 4 parallel workers; cause not established. |
| `navigation.spec.ts:56` "Back and Forward move between sections…" (desktop) | "Request context disposed" in the knowledge-API stand-in (`tests/e2e/support/kb-api.ts:68`) after the test ended | Passed | A stand-in route still in flight when the test finished. |

Neither file is among the uncommitted changes. The matrix already records an earlier, similar unexplained flake (7 Oct). I did not retry, lengthen a timeout or skip anything. **Not reproduced does not mean fixed.** If they recur, keep `test-results/` and record the error before rerunning.

### Comparison with the previous report

| Previous report | Current audit | Verdict |
|---|---|---|
| TypeScript passed | Exit 0 | Matches |
| ESLint passed | Exit 0 | Matches |
| Vitest 716 passed, 4 todo, 40 files | 716 passed, 4 todo, 40 files | Matches exactly |
| Playwright 388 passed, 6 skipped | 766 passed, 13 skipped, 2 failed (781 tests) | **Does not match.** The previous figure (394 tests) is about half of the full suite. It was likely a subset or a single project; I cannot reconstruct which. Use the current figures. |
| No staging, real Supabase, live WhatsApp or real Realtime tests | Confirmed: none run | Matches |
| Only frontend files modified, nothing staged or committed | Confirmed: 30 paths, all under `frontend/`, nothing staged | Matches |

### What each kind of test proves

| Level | Examples | Proves | Does not prove |
|---|---|---|---|
| **Unit** (Vitest, node only, fixed clocks) | `paging.test.ts`, `contract-shapes.test.ts`, `table-changes.test.ts`, `tenant-header.test.ts` | Pure logic: paging order, de-duplication, stale-answer guards, header contents, subscription cleanup | Browser layout, real data, RLS |
| **Mocked E2E** (Playwright, mock Supabase + `page.route` stand-ins) | `leads-paging.spec.ts`, `loading-and-refresh.spec.ts`, `inbox.spec.ts` | The screen against the contract at three widths | The real database, RLS, Realtime, WhatsApp, or that the real API behaves the same. A "no other business's lead shown" test proves the screen's own filter, **not RLS**. |
| **Browser tests against stubs** | WhatsApp calls in `onboarding.spec.ts`; KB routes in `kb-api.ts` | What leaves the browser (headers, payloads) and how the screen reacts to canned answers | That the backend accepts it |
| **Real database / API integration** | none run | — | — |
| **Staging / external provider** | none run | — | — |

### Skipped and todo tests

- **4 `it.todo`** in `features/calendar/booking-lifecycle.test.ts`: confirmed time, cancelled time and actor, previous time of a moved booking, lead stage after a cancellation. All are blocked on Dev 2 / Dev 1 data that does not exist (BT-1, BT-2).
- **13 skipped Playwright results.** In the code, every `test.skip` is conditional: wide-only or phone-only layouts (`inbox.spec.ts`, `inbox-lead-card.spec.ts`, `navigation.spec.ts`, `screens.spec.ts`) and two tests that need the flag-off server (`auth.spec.ts`, `no-business.spec.ts`). I did not list the 13 results one by one.

### Not run, and why

- `pnpm db:test` (pgTAP RLS tests in `supabase/tests/`) — needs a local Supabase stack in Docker. A Docker executable is present on this machine; I did not start a stack or touch any database.
- Backend tests beyond the five areas above, `pnpm test:conversations`, the visual baseline.
- Anything against staging, live Meta, live Realtime, or the hosted Vercel and Railway settings.

---

## 6. Remaining Dev 3 work, prioritized

### P0 — do first, no one else needed

| # | Action | Acceptance criteria |
|---|---|---|
| P0-1 | **GIT-1:** review the uncommitted work and open the four PRs described above | All checks green; reviewers named; matrix updated in the same PR as the tests it describes |
| P0-2 | **AL-1:** make the Inbox page accept `?conversation=` as well as `?chat=` | New E2E passes at all three widths; no change to `?chat=` behaviour |
| P0-3 | **WA-2 (UI side):** show the webhook check from `last_check` on the dashboard WhatsApp panel, with wording agreed with Raja | The panel never says plain "Connected" while `webhook_subscribed` is `not_verified` |

### P1 — this coming week

| # | Action | Acceptance criteria |
|---|---|---|
| P1-1 | **DOC-1:** refresh `docs/frontend-architecture-map.md` and the inventory | Each status row matches `routes.ts` and `features/` |
| P1-2 | **FL-1:** run the full suite two or three times and find the cause of the two flakes | Cause named, or three green runs recorded |
| P1-3 | Push server-side filters for temperature and minimum score into the leads query, and decide the counts approach with Dev 2 (**PG-2**) | Filters apply to the whole business; E2E with more than 200 leads |
| P1-4 | Confirm who reviewed #36 (migration `0010`) and #78 (migration `0020`, WhatsApp connect backend); ask for sign-off from the owning developer | Named reviewers recorded |
| P1-5 | Prepare the staging checklist and test script for ST-1 (two businesses, one test number) | Script reviewed by Dev 1 and Dev 2 |

### P2 — later

- **LD-1:** Refresh on lead detail. Marking a chat read (nothing stores read state; the Unread filter stays off). Changing lead stage or owner from the screen (read-only today).
- Replace the provisional adapter when LC-1 lands (this should cost one new adapter and the deletion of `lead-card-provisional.ts`).
- Build the template picker, suggested reply, takeover preference and own-number option **only after** their contracts exist; building them first would show controls that do nothing.

---

## 7. Blocker and dependency matrix

### Table A — status and ownership

| ID | Requirement (day) | Status | Can I do it alone? | Blocker |
|---|---|---|---|---|
| **GIT-1** | Review, split and commit this week's uncommitted work (D4) | NOT STARTED | **Yes** | none |
| **AL-1** | Inbox opens the chat from `?conversation=` as well as `?chat=` (D4) | **BROKEN** | **Yes** (accept both now); Dev 2 only to confirm the name | none |
| **WA-2** | Dashboard WhatsApp panel must not read plainly "Connected" when the webhook is unverified (D2–D4) | PARTIAL | **Mostly:** I can show the check state; wording needs Raja | Raja (wording); Dev 1 (a real webhook check) |
| **DOC-1** | Update stale docs (`frontend-architecture-map.md` status table, `dashboard-screen-inventory.md`) (D4) | NOT STARTED | **Yes** | none |
| **FL-1** | Understand the two intermittent E2E failures (D4) | PARTIAL | **Yes** | none |
| **LD-1** | Refresh on lead detail (D3) | NOT STARTED | **Yes** | none |
| **PG-2** | Exact counts and filters over the whole business (D3) | BLOCKED | Partly (see note) | Dev 2 (view / RPC), with Dev 1 |
| **PG-1** | Keyset paging proven against real PostgREST (D3) | PARTIAL + EXTERNAL VERIFICATION REQUIRED | Code yes; proof needs a real database | staging access |
| **WA-1** | `X-Pakka-Tenant` accepted by the real API for a member, refused for a non-member (D2–D4) | PARTIAL | No (proof) | Dev 1 / Dev 2 running API + database |
| **BT-1** | Show the confirmed time on timeline and calendar (D3–D4) | BLOCKED | No | Dev 2 |
| **BT-2** | Show the cancelled time and by whom (D3–D4) | BLOCKED | No | Dev 2 |
| **RT-1** | Live lead updates (D3–D4) | BLOCKED | No | Dev 2 (publication migration) |
| **RT-2** | Live booking updates (D3–D4) | BLOCKED | No | Dev 2 |
| **RT-8** | Confirm what the hosted database really publishes (D3) | EXTERNAL VERIFICATION REQUIRED | No | Dev 2 / staging |
| **LC-1** | Replace the provisional lead-card adapter with the real schema and route (D4) | BLOCKED | No | Dev 1 |
| **SR-1** | AI-suggested reply button (D4) | BLOCKED | No | Dev 1 |
| **TP-1** | Team takeover preference (D4) | BLOCKED | No | Dev 2 (entitlement), Dev 1 (consumer) |
| **OW-1** | Own-number option only on a plan that includes it (D4) | BLOCKED | No | Dev 2, Dev 1 |
| **TM-1** | Template picker outside the 24-hour window (D4) | BLOCKED | No | Dev 2 |
| **WA-4** | Recheck, disconnect, connect routes (D4) | BLOCKED | No | Dev 1 |
| **HD-1** | `/h/:token` takeover link route (D4) | BLOCKED | No | Dev 1 |
| **SC-1** | The engine writes score, temperature, stage `qualified` (D3) | BLOCKED | No | Dev 1 |
| **CAL-1** | Create, move, cancel, mark visited from the calendar; Google events on the grid (D3–D4) | BLOCKED | No | Dev 2 (routes, sync), Raja (Google project) |
| **RL-1** | Owner/admin-only writes enforced by the database for services, resources, hours (D3) | BLOCKED | No | Dev 2 |
| **WI-1** | Real website import in onboarding (D2) | PARTIAL (screen simulated) | UI side yes | Dev 1 (route) |
| **AU-1** | Phone / WhatsApp OTP login (D0) | NOT STARTED | After a decision | Raja + Dev 3 (login method) |
| **WA-6** | Hosted settings the connect flow needs (D2–D4) | NOT STARTED | No | Dev 2 / ops |
| **DB-1** | RLS, pagination filters and tenant isolation against a real database (D2–D4) | EXTERNAL VERIFICATION REQUIRED | No | Dev 2 / database access |
| **ST-1** | Day 2–4 end-to-end staging exit tests (D2–D4) | EXTERNAL VERIFICATION REQUIRED | No | All three, plus staging and provider access |

Note on **PG-2:** an interim option exists that needs no new backend contract: exact per-temperature and per-stage counts can be read with plain PostgREST count queries under RLS. That is a design choice for the team (many small queries versus one view), not something I have built or tested.

### Table B — evidence and closure

| ID | Evidence | Why it is incomplete | Deliverable that unblocks it | Acceptance criteria and test |
|---|---|---|---|---|
| GIT-1 | `git status`: 14 modified, 16 untracked; nothing on a branch | Work lives only in this checkout | Split into PRs under ~400 lines: (1) tenant header + tests, (2) leads paging + refresh + Realtime guard, (3) lead-card provisional adapter, (4) loading tests + matrix + docs | Each PR passes `typecheck`, `lint`, `test`, and the relevant `test:e2e` spec; reviewer named per `CODEOWNERS` |
| AL-1 | `backend/src/notify/staff-alerts.ts:100` builds `?conversation=`; `inbox/page.tsx:16` reads only `chat`; `inbox-screen.tsx:182` writes `chat` | Parameter names differ | Page reads `chat` or `conversation` (one wins, the other ignored, ID validated as a GUID) | New E2E: open `/dashboard/inbox?conversation=<id>` selects that chat on desktop, tablet and mobile; unknown or other-business id opens the list with no error |
| WA-2 | `backend/src/channels/whatsapp/connect/manual.ts:128` `webhook_subscribed: not_verified`; `:179` status `active` unless a check fails; panel `whatsapp-connection-panel.tsx:11`; view `whatsapp_connections_public` exposes `last_check` | Panel ignores `last_check`; no real webhook check exists | Raja agrees wording; panel shows "Connected, webhook not yet confirmed" while that check is `not_verified`; Dev 1 later adds a real check | E2E in `whatsapp.spec.ts`: `active` with `not_verified` shows the caveat; with `pass` shows plain "Connected" |
| DOC-1 | `docs/frontend-architecture-map.md` "Dev 3 integration status (7 Oct)" still lists FAQs, gaps and upload as "Blocked on Dev 1" and sending / lead card as "Not started" | Written before those were built | Refresh the table to the current state | Each row verified against `routes.ts` and `features/` |
| FL-1 | Section 5 | Two failures not reproduced | Run the full suite 2–3 times at fewer workers; keep `test-results/` on failure | Same suite green on repeated runs, or the cause named and fixed |
| LD-1 | Matrix section I: "not built" | Added to board and calendar only | Reuse `RefreshControl` | E2E like `loading-and-refresh.spec.ts` |
| PG-2 | Matrix PG-2; `leads-board.tsx` filters over loaded leads | No server-side counts | A view or RPC under RLS, or the interim count queries | Counts equal a full read on seeded data; E2E with more than 200 leads |
| PG-1 | Mock compares timestamps as strings (`mock-supabase.mjs`) | Never run against real PostgREST | A staging business with more than 200 leads | Load more reads every lead once, none repeated, with `timestamptz` ties |
| WA-1 | Unit + stubbed E2E only | Backend side unverified | A running API and database | Member of A calling with A succeeds; with B refused; two-business user sees "choose" |
| BT-1 / BT-2 | `bookings` columns in `0001_init.sql` and `0015_booking_engine.sql`: only `created_at`; 4 `it.todo` | No status-change time or actor | Dev 2: field names, types, null-while-held, cancelled variant, readable under RLS | Replace the 4 `it.todo` with real tests; timeline reads "Confirmed <time>" in business time |
| RT-1 / RT-2 | `lib/realtime/published-tables.ts`; migrations `0010`, `0011` only | Tables not published | Dev 2 migration adding `leads` and `bookings` to `supabase_realtime` | `published-tables.test.ts` fails and names the list; extend it; then confirm on staging with two sessions |
| RT-8 | Section 3, "Latest Dev 3 work", item 4 | Hosted state unknown | Run `select * from pg_publication_tables where pubname = 'supabase_realtime'` on staging | Result matches the intended list |
| LC-1 | `lead-card-provisional.ts` (seven open questions); no route in `routes.ts` | No schema or route | Dev 1: JSON schema in `packages/types`, route or view, null / enum rules for score, temperature, sentiment | Adapter replaced; `lead-card-panel.test.ts` updated; E2E shows AI rows only beside their own chat |
| SR-1 | `/api/conversations/:id/suggest` appears only in docs | No route or types | Dev 1: route, request and response shape | A button fills the reply box; nothing is sent automatically |
| TP-1 / OW-1 | `features/team/alert-number.ts` header comment; `memberships.takeover_pref` exists; `handoff_own_number` is in `supabase/seed/plans.sql` | The browser cannot read an entitlement; nothing reads the preference | Dev 2: entitlement readable by members; Dev 1: consumer of the value | Option visible only when entitled; value stored and read back; E2E for eligible and ineligible plans |
| TM-1 | `backend/src/conversations/staff-reply.ts` answers `not_available` to `template` | `notify.send` has no staff-template path | Dev 2: route accepting `{ template: { name, lang, params } }` | Picker lists approved templates; a send outside the window succeeds on staging |
| WA-4 | `routes.ts` has only `webhook-config`, `manual`, admin `manual` | No recheck / disconnect / connect routes | Dev 1: the three routes | Buttons enabled; E2E and a staging disconnect / recheck |
| HD-1 | No `/h/` route in `backend/src` | Not built | Dev 1: signed token route | Alert buttons open inbox or own-number flow |
| SC-1 | No writer of `score` / `temperature` in `backend/src` | Decide step not built | Dev 1: scoring writes | A seeded chat yields a score; the board's hot filter shows it |
| CAL-1 | `routes.ts` has no booking route | Calendar is read-only | Dev 2: booking routes and Google sync; Raja: Google project | Reschedule / cancel / mark visited from the calendar |
| RL-1 | `0002_packs_and_bookings.sql` allows member writes | Role is enforced in the page only | Dev 2: tighten policies | pgTAP test: staff write refused |
| WI-1 | `step-teach.tsx` runs simulated timers; no import route | Backend missing | Dev 1: import route and contract | Real import fills the KB; E2E against the real contract |
| AU-1 | Login is email, password and Google; phone step uses a dummy code | Method undecided | Raja + Dev 3 decision, then OTP provider | OTP sign-in end to end |
| WA-6 | `NEXT_PUBLIC_API_URL`, `API_PUBLIC_URL`, `ENCRYPTION_KEY`, `META_*` | Not checkable from the repo | Dev 2 / ops confirm hosted values (names only) | The connect flow starts on staging |
| DB-1 | `supabase/tests/*.test.sql` exist; not run | Needs Docker and a local Supabase | Run `pnpm db:test`; two-business staging login | pgTAP green; cross-business reads return nothing |
| ST-1 | Section 8 | No staging run | Staging with Inngest, embeddings, a connected test number | Every row in section 8 marked verified |

### Summaries by owner

#### Dev 3 — my contribution and my own outstanding work

Delivered: the dashboard, the inbox, the knowledge-base UI, the leads / calendar / booking-setup screens, the takeover UI, the Team alert number, the own-Meta-app connect flow, the two conversation routes, and this week's uncommitted improvements. Outstanding and mine alone: **GIT-1, AL-1, DOC-1, FL-1, LD-1**, the UI side of **WA-2**, and **WI-1** on the screen side.

#### Dev 1 — Nitisha (agent and WhatsApp) — only what blocks the frontend

| Needed | Item |
|---|---|
| Lead-card JSON schema and route or view, with answers to the seven open questions | LC-1 |
| Suggest-reply route, request and response | SR-1 |
| Scoring writes (`score`, `temperature`, stage `qualified`) | SC-1 |
| `/h/:token` takeover link and the own-number mode consumer of `takeover_pref` | HD-1, TP-1 |
| Recheck, disconnect and connect routes; a real webhook-subscription check | WA-4, WA-2 |
| Website import route | WI-1 |

#### Dev 2 — Shaaz (backend, database, jobs) — only what blocks the frontend

| Needed | Item |
|---|---|
| Migration adding `leads` and `bookings` to the Realtime publication; confirm the hosted publication | RT-1, RT-2, RT-8 |
| Confirmed and cancelled booking times, and actor, readable under RLS | BT-1, BT-2 |
| Server-side counts by stage and temperature | PG-2 |
| Staff-template send in `notify.send` and the route | TM-1 |
| A plan entitlement members can read | TP-1, OW-1 |
| Confirm the alert-link parameter name (`conversation` or `chat`) | AL-1 |
| Booking routes and Google sync; tighter RLS for services and resources | CAL-1, RL-1 |
| Running API + database for an authorization check; hosted env values | WA-1, WA-6, DB-1 |

#### Raja and provider / shared-infrastructure dependencies

| Needed | Item |
|---|---|
| Wording for a number connected with an unverified webhook | WA-2 |
| Login method decision (WhatsApp OTP, SMS OTP or Google) | AU-1 |
| Google Cloud project and credentials; Google consent and token storage | CAL-1 |
| Meta Tech Provider / App Review (needs the two screen recordings the handover mentions); live test number | ST-1, live WhatsApp checks |
| Staging with Inngest and the embeddings provider | ST-1, DB-1 |

These are missing contracts or access, not blame. Nothing here says a teammate's code is wrong; most of it says the other side of an integration has not been built or has not been run.

---

## 8. Day 2, Day 3 and Day 4 exit-test status

The handover's exit tests are staging tests ("a milestone is done only when its exit test passes on staging"). Using that standard, **none of the three exits has passed**, because none was run. The table breaks each into the criteria that touch Dev 3's work. "Verified (mocked)" means unit or stubbed-browser tests pass.

Status key: **Verified (mocked/unit)** · **Failed** · **Blocked** · **Not tested**

### Day 2 (M1 exit: a customer's question gets a correct knowledge-base answer on WhatsApp within 10 s)

| Criterion | Status | Evidence |
|---|---|---|
| Staff can see the customer's message and the AI's reply in the inbox | Verified (mocked/unit) | `inbox.spec.ts`; **not** seen with a real WhatsApp message |
| Inbox updates live | Verified (mocked/unit) | Phoenix protocol emulated; never on a real server |
| AI / Needs human / Human tags | Verified (mocked/unit) | `inbox.spec.ts` |
| Staff can edit services, prices and FAQs | Verified (mocked/unit) | `knowledge.spec.ts` |
| A document becomes searchable and a reply uses it | Not tested | Needs Inngest, embeddings, a database, a live number |
| Answer in English and Tamil within 10 s | Not tested | Agent and provider; outside Dev 3 |
| Website import | Blocked | WI-1 |
| Tenant isolation / RLS | Not tested | pgTAP not run; E2E proves the screen's filter only |
| Real unread state | Blocked | Nothing stores it |

### Day 3 (M2 exit: qualifying questions, a score, three slots, a booking in Google Calendar and the dashboard)

| Criterion | Status | Evidence |
|---|---|---|
| Leads board by stage, with temperature and score filters | Verified (mocked/unit) | `leads.spec.ts`, `contract-shapes.test.ts` |
| Leads actually scored | Blocked | SC-1 (Dev 1) |
| Lead detail with answers and timeline | Verified (mocked/unit) | `leads.spec.ts` |
| Calendar day and week, right staff, business time zone | Verified (mocked/unit) | `calendar.spec.ts`, `booking-lifecycle.test.ts` |
| Booking confirmed / cancelled time displayed | Blocked | BT-1, BT-2 |
| Services and resources settings | Verified (mocked/unit) | `booking-setup.spec.ts` |
| Leads and calendar update live | Blocked | RT-1, RT-2 |
| More than 200 leads | Verified (mocked/unit); real PostgREST Not tested | PG-1 |
| Exact counts over the whole business | Blocked | PG-2 |
| Owner/admin-only writes enforced by the database | Blocked | RL-1 |
| A chat produces a score, slots, a booking, stage "Booked", a calendar block | Not tested | Agent does not score or book yet |
| Booking appears in Google Calendar | Blocked | CAL-1 |

### Day 4 (M3 exit: reminders arrive; "talk to a person" sends staff the lead card; both takeover options work)

| Criterion | Status | Evidence |
|---|---|---|
| Lead card panel pinned beside the chat | Verified (mocked/unit) for stored data | `inbox-lead-card.spec.ts`, `lead-card-panel.test.ts` |
| Lead card AI summary rows | Blocked | LC-1 |
| AI / human switch, Return to AI | Verified (mocked/unit) | `inbox.spec.ts`; backend `mode.test.ts`; real database and WhatsApp Not tested |
| Staff reply obeys the 24-hour window | Verified (mocked/unit) | `staff-reply.test.ts`, backend `staff-reply.test.ts`; real send Not tested |
| Staff alert opens the right chat | **Failed** | AL-1 (parameter mismatch found in code; no run was needed to see it) |
| Inbox takeover from the alert | Blocked | HD-1 |
| Own-number takeover | Blocked | HD-1, TP-1, OW-1 |
| Template picker outside the window | Blocked | TM-1 |
| AI-suggested reply | Blocked | SR-1 |
| Team alert number | Verified (mocked/unit) | `team.spec.ts`, `alert-number.test.ts` |
| Team takeover preference | Blocked | TP-1 |
| Connection status honest about the webhook | Failed in part | WA-2 |
| Recheck / disconnect | Blocked | WA-4 |
| Reminders at 24 h and 2 h | Not tested | Dev 2 jobs; outside Dev 3 |

---

## 9. Next-week execution plan

**Start immediately (no dependencies):** GIT-1 (PR split) → AL-1 → DOC-1 → FL-1 → WA-2 UI (with Raja's one-line wording decision) → LD-1 → server-side filters (P1-3).

**Waiting on Dev 1:** LC-1 (schema and route), SR-1, SC-1, WA-4, HD-1, WI-1, TP-1 consumer. When each contract lands: write the adapter or client first with tests that quote the contract, then enable the UI, then remove the "switched off" state.

**Waiting on Dev 2:** RT-1/RT-2 (migration) — on arrival, extend `PUBLISHED_TABLES` when `published-tables.test.ts` fails, then confirm on staging; BT-1/BT-2 (replace the four `it.todo`); PG-2; TM-1; entitlement for TP-1/OW-1; RL-1; the running API and database for WA-1 and DB-1.

**Waiting on external access or approval:** staging login for two businesses (DB-1, PG-1, ST-1); a connected test number; Inngest and the embeddings provider; Google Cloud project (CAL-1); Meta App Review recordings; Raja's decisions (WA-2 wording, AU-1 login method).

**Recommended order:**
1. Commit and open the PRs (protects the work).
2. AL-1 (smallest, user-visible).
3. WA-2 UI and DOC-1.
4. Agree contracts with Dev 1 and Dev 2 using the messages below.
5. As each contract arrives, wire it up in the order: RT → BT → LC → TM → SR → TP/OW.
6. One staging session with Dev 1 and Dev 2 to run the Day 2–4 table in section 8.

---

## 10. Handoff messages

**For Nitisha (Dev 1)**

> Hi Nitisha — frontend status for Day 2–4. The lead-card panel is built and tested against stored data (score, stage, answers, handover, booking). I also built an adapter against the `LeadCard` *proposal* in `docs/dashboard-screen-contracts.md`, but it is switched off in the app, because there is no schema or route yet. To wire it up I need: (1) the lead-card JSON in `packages/types` and a route or view (the open questions are listed at the top of `frontend/features/inbox/lead-card-provisional.ts`: null vs a number for an unscored lead, the temperature values, whether `answers` are strings, sentiment values, what `source` and `owner` hold); (2) the suggest-reply route and its request/response shape; (3) confirmation that score, temperature and stage `qualified` will be written — today every lead reads "Not scored"; (4) the `/h/:token` takeover route and who reads `memberships.takeover_pref`; (5) recheck, disconnect and connect routes, and a real check for `webhook_subscribed`. The dashboard WhatsApp panel currently shows "Connected" for a number whose webhook check is still `not_verified`; I'm adding the caveat on my side. Nothing here is urgent to me today beyond (1) and (3), which unlock the most UI.

**For Shaaz (Dev 2)**

> Hi Shaaz — frontend status for Day 2–4. Everything below is on your side of the contract; the UI is ready or ready to extend. (1) Realtime: no migration publishes `leads` or `bookings`, so the board and calendar say "Not updating live. Use Refresh." The frontend only subscribes to published tables and a test fails when the migrations and my list disagree. Could you add both tables to `supabase_realtime` and confirm what the hosted project publishes (`select * from pg_publication_tables where pubname='supabase_realtime'`)? (2) Bookings only have `created_at`; I need a confirmed time, a cancelled time and who cancelled, readable under RLS. (3) Server-side counts by stage and temperature (a view or RPC) so the board can show exact numbers beyond 200 leads. (4) Staff-template send through `notify.send`, so I can build the template picker. (5) A plan entitlement members can read, for the own-number option. (6) Please confirm the staff-alert link name: the backend sends `?conversation=<id>`, the inbox reads `?chat=<id>`; I'm changing the inbox to accept both unless you'd rather change the link. (7) RLS currently lets any member write services and resources; the UI hides it for staff, but the database should enforce owner/admin.

**For the shared team**

> Status, Day 0–4 (Dev 3). All screens are built and pass unit and mocked-browser tests (716 unit tests; 766 of 781 browser tests passed, 2 timing-related failures that passed on rerun, 13 conditional skips). **No workflow has been run against staging, a real database, real Realtime or a live WhatsApp number**, so none counts as verified. Open integration blockers: AL-1 (alert link parameter mismatch, I'm fixing it), live leads/bookings updates (Dev 2 migration), lead scoring and the lead-card schema (Dev 1), booking confirm/cancel times (Dev 2), template send and suggest-reply (Dev 2, Dev 1), recheck/disconnect and the takeover link (Dev 1). Raja: we need your call on the "Connected but webhook unverified" wording and the login method. Proposed next acceptance test, on staging with two businesses and one connected number: (1) a customer message appears in the inbox live; (2) Take over, reply inside the window, Return to AI; (3) a hot lead appears on the board and in the calendar after a booking; (4) the staff alert opens the right chat; (5) business A's member cannot see business B's chats, leads or bookings. I'd like to run this together once the migrations and contracts above are in.

---

## 11. Final status

**What I delivered:** a working, tested dashboard covering the Day 2 inbox and knowledge-base UI, the Day 3 leads, calendar and booking-setup screens, and the Day 4 takeover UI (switch, reply box, pinned lead card, alert number), plus the own-Meta-app connect flow and the two conversation routes. This week's uncommitted work adds the tenant header on WhatsApp calls, paged leads with Load more, Refresh controls, a safe Realtime guard, loading states, a provisional lead-card adapter and a stronger regression matrix. Current checks: TypeScript and ESLint pass, 716 unit tests pass (4 todo), 766 of 781 browser tests pass (2 intermittent failures that passed on rerun, 13 conditional skips).

**What remains:** AL-1 (broken), the commit and PR split, the WhatsApp status wording, stale documentation, and everything on the blocker matrix — most of which waits on a contract or a migration from Dev 1 or Dev 2, or on staging access.

**Why it remains:** the other side of several integrations does not exist yet (lead-card schema, suggest-reply, template send, entitlements, Realtime publication, booking timestamps, scoring, recheck/disconnect and takeover-link routes), and no real database, Realtime server, provider or staging environment has been available to run the proof.

**What must happen before anything is marked complete:**
1. This week's work is committed, reviewed and merged.
2. AL-1 is fixed and tested.
3. Dev 1 and Dev 2 deliver the contracts and migrations in section 7 (each with its test).
4. A staging run with two businesses and a connected test number passes the criteria in section 8, and the pgTAP RLS suite passes (`pnpm db:test`).
5. Until then, every status in this report stays at "mocked/unit" or "blocked", not "done".

---

## Evidence I could not collect

- Any result from staging, a real Supabase project, live Meta / WhatsApp, a real Realtime server, Inngest or the embeddings provider.
- pgTAP / RLS results (`pnpm db:test`) — not run.
- The hosted Realtime publication contents, and the hosted Vercel and Railway settings.
- Pull-request reviews and approvals (not visible from a local clone), so who reviewed #36, #78 and #79 is unknown.
- A day-by-day task document for Day 0 and Day 1; Day 2–4 responsibilities are reconstructed from the handover milestones and the Day 2/3/4 scopes in the audit brief.
- The origin of the previous report's Playwright count (388 passed, 6 skipped), and the cause of the two intermittent browser-test failures.
- The visual baseline (0 of 213 differ) was not re-run.
