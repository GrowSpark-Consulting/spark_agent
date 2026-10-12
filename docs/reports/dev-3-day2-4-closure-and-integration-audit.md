# Dev 3: Day 2 to 4 closure and backend–frontend integration audit

> **Update 12 Oct 2026 (later):** D4-3b (the template picker) is no longer blocked: Dev 2 put `{ template }` on the route and the picker is built; see `dev-3-day5-audit.md`. Rows below that say BLOCKED for it are as of the earlier run.

**Date:** 12 Oct 2026. **Branch:** `feat/dev3-day2-4-closure`, created from `origin/main` at `76ec9fe` (local `main` is at `0ad32df`, one commit behind and untouched). **Nothing was committed, pushed, merged or deployed.** The backup branch `backup/dev3-wip-before-sync` (`432447b`), all 3 stashes, every other branch, and `docs/reports/` are untouched. The earlier task branches under `AgentX-branches/` are empty placeholders at `0ad32df` whose worktree folders no longer exist (git lists them as prunable); they were not pruned or used.
**No backend code, migration, RLS policy, shared contract, environment file or deployment setting was changed.**
This report builds on `dev-3-day3-day4-audit.md` (earlier today). Where the two differ, this one is newer.

**Evidence levels.** Unit and mocked E2E are frontend evidence (a mock Supabase; page.route stubs). "Contract-checked" means the frontend's parser was run against the backend's own schema or real code. Nothing here is a live check: no staging, real Supabase, Realtime, Meta, WhatsApp or Google run was made. Docker is off on this machine, so `pnpm db:test` and `scripts/db/*.sh` were not run.

## A. Day 2 to 4 task matrix

| Task ID | Acceptance criterion | Status | Files and tests | Owner | Remaining blocker |
|---|---|---|---|---|---|
| D2-1 | Inbox: realtime list and chat, AI / human badge, bubbles by sender | DONE | `features/inbox/*`; `inbox.spec`, `data.test` (52) | Dev 3 | Realtime never seen on a real server |
| D2-2 | Knowledge base editor: services and prices, FAQs, document upload, "questions the AI couldn't answer" | DONE | `features/knowledge/*`; `knowledge.spec`, `kb-*.test` | Dev 3 | Ingestion to a searchable answer is Dev 1 / staging |
| D2-3 | Website import | BLOCKED | No import route exists; the onboarding "Teach" step is simulated | Dev 1 | A route and contract |
| D3-1 | Services and resources settings (length, gap, notice, hours, pincodes) | DONE | `features/knowledge/{data,services-editor}`, `features/settings/*`; `booking-setup.spec`, `hours.test` | Dev 3 | Not seen on a real DB. RLS checks `is_member` only: any member, staff included, can write services, resources and `tenants` (RL-1) |
| D3-1d (BK-1) | Which service the assistant books | DONE (mocked) | `features/settings/booking-service*`; `booking-service.test` (14), `booking-service.spec` (5×3) | Dev 3 + Dev 1 | The `agent_settings` shape is still "To define" in `docs/contracts.md`. The save is read-then-write on one jsonb column (see E) |
| D3-1e (CAT-1) | The catalog the scorer reads has an editor | NOT STARTED | The dashboard never writes `catalog_items` | Dev 3 + product | A product decision on the screen and per-pack fields |
| D3-2 (PG-2) | Leads board: stage columns, temperature and score filters, pagination past 500, counts over the whole business, loading / error / refresh | DONE (mocked) | **New this run.** `features/leads/{data,paging,board-view,leads-board}`; `server-counts.test` (14), `board-view.test` (9), `paging.test` (+8), `leads-filters.spec` (8×3), `leads-paging.spec`, `leads.spec` | Dev 3 | Filters and counts unseen on a real PostgREST. Search and a stage filter are not in the contract. A source filter is blocked: no `source` column exists. No live updates (`leads` isn't published, RT-1) |
| D3-3 | Lead detail: answers, timeline, nullable score, right lead | DONE | `lead-detail.tsx` + Refresh (LD-1); `leads.spec`, `lead-detail-refresh.spec` (3×3) | Dev 3 | Confirmed/cancelled times need Dev 2 (BT-1, BT-2) |
| D3-4 | Calendar: Day / Week, staff, read-only, timezone, loading / error / refresh | DONE | `features/calendar/*`; `calendar.spec`, `calendar.test` | Dev 3 | `bookings` isn't published (RT-2) |
| D3-X1 to X6 | Slots, staff, concurrent holds, no-staff booking, "tomorrow evening", credits | UNVERIFIED | Backend unit tests and 11 scripted chats; DB script not run | Dev 1 / Dev 2 | Staging |
| D4-1 | Pinned lead card (real API, follows the chat, retry, nullable score, stale answers) | DONE | `lead-card-api.ts`, `lead-card-panel.tsx`; `inbox-lead-card.spec`. **Contract-checked:** 5 real backend cards (null score, null temperature, no trigger, angry, AI- and code-written) all parse | Dev 3 | Not called against a live route |
| D4-2 | AI / human switch and Return to AI with a system note | DONE | `conversation-mode.ts`; `inbox.spec` | Dev 3 | Own-number (`external`) chats can't return to the AI (XM-1) |
| D4-3a | Staff reply inside 24 h, 0 credits | DONE | `staff-reply.ts`, `reply-composer.tsx`; cost 0 in `credit-costs.ts` | Dev 3 | Live send unseen |
| D4-3b | Template picker outside the window | BLOCKED | `backend/src/conversations/staff-reply.ts:46` still throws `not_available` for `template`; `SendStaffReplyInput` has no template; `notify.send` already supports it (#87) | Dev 3 (route) + Dev 2 | A small backend change I was told not to make |
| D4-4a/c/d | Alert preferences, takeover preference, own-number option gated by plan | BLOCKED | No alert-preference column; `handoff_own_number` is evaluated only on the server (`features/is-enabled.ts`) | Dev 2 / Dev 1 | A readable entitlement and a storage contract |
| D4-4b | Staff WhatsApp phone | DONE | `features/team/*`; `team.spec` | Dev 3 | Alert delivery unseen |
| D4-5 | Suggested reply fills the draft, never sends | DONE | `suggest-reply.ts`, `reply-composer.tsx`; E2E counts sends: 0 | Dev 3 | Real model unseen |
| D4-6 | An alert or takeover link opens the right chat, even an old one | DONE | `initial-chat.ts`, `fetchConversation` (IB-1); `inbox-limits.spec` (6×3). Dev 2's #112 made the backend alert use `?chat=` too | Dev 3 | None on the frontend |
| D4-X1 | The alert carries the card and two signed buttons | BLOCKED | `staff-alerts.ts` still sends `headline` + a plain link; `createHandoffLinks` has no non-test caller (AH-1) | Dev 2 + Dev 1 | Wire links and buttons |
| D4-X2 to X6 | 0-credit replies, Return to AI, token rejection, own-number gate, jobs | UNVERIFIED | Backend unit tests pass; nothing on staging | Dev 1 / Dev 2 | Staging |
| FL-1 | `knowledge.spec.ts:587` stable | PARTIAL | Poll back-off shortened; see C | Dev 3 | Still load-sensitive; see C |
| RESP-1 | Template and test-message forms don't show success on a bad 2xx body | DONE (new) | `lib/whatsapp/results.ts`; `results.test` (5), `messaging.spec` (+2×3) | Dev 3 | None |

## B. Backend–frontend integration inventory

**Method.** Every route comes from `backend/src/server/routes.ts`, the only place an endpoint is registered (checked: nothing else calls `createServer` or matches `/api/`). Every frontend call was found by searching `app`, `components`, `features` and `lib` for the shared client (`lib/api/client.ts`), direct `fetch`, server actions (only `lib/auth/actions.ts`, which talks to Supabase Auth) and route handlers (only `app/auth/callback/route.ts`). 29 method+path routes exist across 25 paths. `OPTIONS` preflights are generated for browser routes and are not endpoints.

**Status key** (the numbers are the brief's): CONNECTED_AND_VERIFIED means the caller was traced, the contract was checked against the backend's own schema or real route code, and the UI states have tests; not live. CONNECTED_BUT_UNVERIFIED means traced and compared by reading, tested only against stubs. EXTERNAL means another service or a followed link calls it.

| # | Method | Backend route | Frontend caller | UI entry point | Status | Contract match | Auth / tenant | Tests | Next action |
|---|---|---|---|---|---|---|---|---|---|
| 1 | POST | `/api/templates` | `components/dashboard/create-template-form.tsx` | Templates → New → Submit for review | CONNECTED_BUT_UNVERIFIED | Request uses the shared `CreateTemplateInput`; response now checked by `readTemplateResult` (new) | Bearer + `X-Pakka-Tenant`; owner / admin (UI hides it from staff) | `messaging.spec` (stubs), `results.test` | Staging with a real WABA |
| 2 | POST | `/api/messages/test` | `components/dashboard/send-test-message-form.tsx` | Messages → Send a test message | CONNECTED_BUT_UNVERIFIED | Shared `SendTestMessageInput`; response now checked | As above | `messaging.spec` (stubs), `results.test` | Staging |
| 3 | POST | `/api/onboarding/trial` | `lib/onboarding/trial.ts` | Onboarding → Business step | **CONNECTED_AND_VERIFIED** | Shared `StartTrialResult`, parsed; real route exercised | Bearer only (no business yet, correctly no tenant header) | `trial-signup.spec` (real local API, mock DB), backend tests | None |
| 4 | POST | `/api/conversations/:id/messages` | `features/inbox/staff-reply.ts` | Inbox → reply box | CONNECTED_BUT_UNVERIFIED | `{ body }` matches `SendStaffReplyInput`; response parsed by zod. A `template` field is refused by the route | Bearer + tenant; owner / admin / staff; refused while the AI has the chat | `staff-reply.test`, `inbox.spec` (stub) | Template support is D4-3b |
| 5 | POST | `/api/conversations/:id/mode` | `features/inbox/conversation-mode.ts` | Inbox → AI / Human switch | CONNECTED_BUT_UNVERIFIED | `{ mode }` matches the strict shared input; response parsed | As above | `conversation-mode.test`, `inbox.spec` (stub) | `external` can't be switched (XM-1) |
| 6 | GET | `/api/conversations/:id/lead-card` | `features/inbox/lead-card-api.ts` | Inbox → lead card panel | **CONNECTED_AND_VERIFIED** | 5 real backend cards run through the frontend parser; the full phone never survives it | Bearer + tenant; any member | `lead-card-api.test`, `lead-card-panel.test`, `inbox-lead-card.spec` | A live call |
| 7 | POST | `/api/conversations/:id/suggest` | `features/inbox/suggest-reply.ts` | Inbox → Suggest reply | CONNECTED_BUT_UNVERIFIED | `{ reply, language, reason }` matches the backend `Suggestion` type by reading; parsed by zod | As above | `suggest-reply.test`, `inbox.spec` (stub) | A live call |
| 8 | POST | `/api/kb/documents` | `features/knowledge/kb-content.ts` | Knowledge → Upload | CONNECTED_BUT_UNVERIFIED | multipart; 5 MB and file types match; 202 body matches | Bearer + tenant; owner / admin | `kb-api.test`, `knowledge.spec` (stub) | Staging with Inngest |
| 9 | DELETE | `/api/kb/documents/:id` | same | Knowledge → delete a document | CONNECTED_BUT_UNVERIFIED | 204 | As above | same | Staging |
| 10 | POST | `/api/kb/faqs` | same | Knowledge → Add FAQ | CONNECTED_BUT_UNVERIFIED | `{ q, a }` limits 300 / 2000 match the backend's | As above | same | Staging |
| 11 | PATCH | `/api/kb/faqs/:id` | same | Knowledge → edit FAQ | CONNECTED_BUT_UNVERIFIED | only changed fields sent | As above | same | Staging |
| 12 | DELETE | `/api/kb/faqs/:id` | same | Knowledge → delete FAQ | CONNECTED_BUT_UNVERIFIED | 204 | As above | same | Staging |
| 13 | GET | `/api/kb/gaps` | same | Knowledge → questions the AI couldn't answer | CONNECTED_BUT_UNVERIFIED | array shape matches | Bearer + tenant; owner / admin / staff | same | Staging |
| 14 | POST | `/api/kb/gaps/:id/answer` | same | Knowledge → answer a gap | CONNECTED_BUT_UNVERIFIED | `{ a }` → `{ faq }` | As above | same | Staging |
| 15 | POST | `/api/kb/gaps/:id/dismiss` | same | Knowledge → dismiss a gap | CONNECTED_BUT_UNVERIFIED | no body, 204 | As above | same | Staging |
| 16 | GET | `/api/whatsapp/webhook-config` | `lib/whatsapp/manual-connect.ts` | Onboarding → Use my own Meta app | CONNECTED_BUT_UNVERIFIED | `{ webhookUrl, verifyToken, partnerBusinessId }` matches | Bearer + tenant; owner / admin | `manual-connect.test`, `onboarding.spec` (stub) | Staging |
| 17 | POST | `/api/whatsapp/manual` | same | Onboarding → connect form | CONNECTED_BUT_UNVERIFIED | body fields match `ManualConnectInput` minus `tenantId`; response is the shared `WhatsAppConnectionPublic` | As above; the tenant in the body is overwritten server-side | same | Staging with a real number |
| 18 | POST | `/api/whatsapp/connections/:id/recheck` | `lib/whatsapp/connection-actions.ts` | WhatsApp page → Recheck | CONNECTED_BUT_UNVERIFIED | no body; the response is ignored and the page re-reads the connection view | owner / admin (UI the same); another business's id → `not_found` | `connection-actions.test`, `whatsapp.spec` (stub) | Staging |
| 19 | POST | `/api/whatsapp/connections/:id/disconnect` | same | WhatsApp page → Disconnect | CONNECTED_BUT_UNVERIFIED | as above | UI is owner-only; the API allows owner and admin (a documented UI choice) | same | Staging |
| 20 | GET | `/api/calendar/google/connect` | `features/settings/google-calendar.ts` | Booking setup → Connect Google Calendar | CONNECTED_BUT_UNVERIFIED | `{ url }` must start with `https://accounts.google.com/`; real route reached only for "not switched on" | owner / admin | `google-calendar.test`, `booking-setup.spec` | A Google Cloud project (Raja) |
| 21 | POST | `/api/admin/whatsapp/manual` | none | none | BACKEND_ONLY_NO_FRONTEND_CALLER | n/a | Platform admin only (`platform_admins`) | backend tests | Intentional: a Spark-team tool. No admin screen is specified in any Dev 3 task doc. Product to decide whether one is wanted |
| 22 | GET | `/h/:token` | none (staff browsers follow it from WhatsApp) | the alert's buttons | EXTERNAL | It redirects to `/dashboard/inbox?chat=<id>`, which the inbox opens | Signed, staff-bound, 24 h, single-use token; no login | backend `token.test`, `takeover.test` | Nothing sends it yet (AH-1) |
| 23 | GET | `/api/calendar/google/callback` | none (Google redirects here) | after consent | EXTERNAL | It redirects to Booking setup with `?google_calendar=`, which the page reads | Signed state | backend tests | None |
| 24 | GET | `/api/webhooks/whatsapp` | none (Meta) | none | EXTERNAL | verification handshake | per-business verify token | backend tests | None |
| 25 | POST | `/api/webhooks/whatsapp` | none (Meta) | none | EXTERNAL | messages and statuses | HMAC signature | backend tests | None |
| 26 | GET | `/api/inngest` | none (Inngest) | none | EXTERNAL | introspection | Inngest | backend tests | None |
| 27 | POST | `/api/inngest` | none (Inngest) | none | EXTERNAL | runs a function | Inngest | backend tests | None |
| 28 | PUT | `/api/inngest` | none (Inngest) | none | EXTERNAL | syncs functions | Inngest | backend tests | None |

**Listed separately (infrastructure):** `GET /api/health` has no frontend caller by design (Railway's liveness check).

### Coverage summary (derived from the table above and the route table)

| Count | |
|---|---|
| Method+path routes discovered | **29** (25 distinct paths) |
| Feature routes (excluding the health check) | **28** |
| CONNECTED_AND_VERIFIED | **2** (`POST /api/onboarding/trial`, `GET /api/conversations/:id/lead-card`) |
| CONNECTED_BUT_UNVERIFIED | **18** |
| BACKEND_ONLY_NO_FRONTEND_CALLER | **1** (`POST /api/admin/whatsapp/manual`, intentional) |
| EXTERNAL_WEBHOOK_OR_SERVICE_ONLY | **7** (`/h/:token`, Google callback, WhatsApp webhook GET and POST, Inngest GET, POST, PUT) |
| FRONTEND_CALLS_MISSING_OR_INCORRECT_ROUTE | **0** |
| FRONTEND_CALLS_BUT_CONTRACT_MISMATCH | **0** found (two were unvalidated, now fixed: see D) |
| MOCK_ONLY_NO_REAL_INTEGRATION | **0** (every connected call goes to a real route; only the tests stub it) |
| BLOCKED_BY_DEPENDENCY | **0** as routes. The template picker (route rejects the field) and alert buttons (alert doesn't use the links) are blocked features, listed in D |
| Total | 2 + 18 + 1 + 7 = **28** feature routes, plus health = 29 |

**Drift is now guarded.** `frontend/lib/api/backend-routes.test.ts` reads `routes.ts` and fails if the frontend calls a method or path the API doesn't register, if a new frontend file starts calling the API unlisted, or if a new backend route appears that is neither called nor classified with a reason. It was mutation-tested (a wrong method and a removed classification were both caught). It does not check request or response shapes.

**Also not through the API.** These screens read and write Supabase directly under RLS: inbox, leads, calendar, booking setup, knowledge services / FAQ / document lists, the team phone number, WhatsApp connection status. Their contract is the database, and their isolation is the `tenant_id` filter plus RLS.

### Genuine missing integrations, in priority order

1. **Staff alert buttons (AH-1):** the backend has the signed links and `/h/:token`; the alert doesn't use them. Backend wiring (Dev 2 + Dev 1). The frontend side is done.
2. **Template picker (D4-3b):** `notify.send` supports it; the route rejects it. Backend, then a frontend picker.
3. **Own-number chats back to the AI (XM-1):** a product decision and a route change.
4. **Plan entitlement for the Team screen (D4-4d):** no browser-readable contract.
5. **Frontend references to routes that don't exist** (not calls): `POST /api/onboarding/import-site`, `POST /api/onboarding/whatsapp/embedded-signup`, `PATCH /api/leads/:id`, `GET /api/leads/:id/timeline`. They appear only in comments; building UI for them would be speculation.

## C. Newly completed work (all uncommitted, on `feat/dev3-day2-4-closure`)

| Id | What | Files | Tests |
|---|---|---|---|
| PG-2 | The leads filters and every count are worked out by the database for the whole business. The first page asks for the exact matching total; six head-only counts feed the chips and heading (All is their sum, so no seventh request); nine per-stage counts are read **only** when the list is cut short; Refresh with a filter replaces the list so a lead that stopped matching goes | `features/leads/{data,paging,board-view,leads-board}`, mock + `day3.ts` | 14 + 9 + 8 unit; `leads-filters.spec` 8×3, `leads-paging.spec`, `leads.spec`, `loading-and-refresh.spec`: **97 passed** |
| RESP-1 | The template and test-message forms validate the API's answer instead of casting it | `lib/whatsapp/results.ts`, two forms | 5 unit; 2×3 E2E |
| DRIFT | Route drift guard | `lib/api/backend-routes.test.ts` | 6 unit, mutation-tested |
| IB-1, LD-1, BK-1, FL-1 | Carried over from the backup branch (earlier today) | see `dev-3-day3-day4-audit.md` | see below |
| DOC | Regression matrix merged with upstream's AL-1 row | `tests/e2e/regression-matrix.md` | none |

**The seven HEAD requests, answered.** They are not needed. The six that are needed exist because nothing groups leads for a browser: PostgREST aggregates aren't assumed enabled, and a view or function would be a Dev 2 migration. "All" equals the sum of the five exclusive temperature buckets (the column allows four values or none), so it needs no request. Per-stage counts add nine more, but only when the list is cut short; a business with 200 leads or fewer makes six head requests plus the page read (E2E asserts exactly 6, and 15 for a 450-lead business). They are tiny head-only requests with no body, and run in parallel. A single SQL view or function from Dev 2 would replace all of them with one call.

**FL-1, honestly.** The raw control-versus-fix logs from earlier today are no longer on disk (the temp folder was cleared); the numbers survive in `dev-3-day3-day4-audit.md` and the matrix: before, 20.3 and 22.5 s passing and 39.0 and 44.6 s failing against the 30 s default; after the poll back-off change, 8.7 to 17.2 s across 9 of 9 repeats. Cause: 100 rounds each paying `expect.poll`'s 100 ms back-off. The assertions and rounds are unchanged. **A baseline of an unmodified checkout was not made.** This run's full-suite result for that test is in the results below.

## D. Remaining work

**Independent Dev 3:** the catalog editor (needs a product decision first); a search box and a stage filter on the board (not in the contract; trivial now that filters are server-side, if wanted); the template picker, once the route accepts a template; splitting and committing this work into small PRs; refreshing `docs/frontend-architecture-map.md` (DOC-1).
**Dev 1:** the `agent_settings` shape and the `bookingServiceId` key's home; the own-number return decision (XM-1); live checks of lead-card and suggest; the `no-industry-branching.test.ts` 5 s limit (it timed out once in a loaded backend run and passed 30/30 alone); website import route.
**Dev 2:** the alert using `createHandoffLinks` and two buttons (AH-1); `staff-reply.ts` accepting `template` (D4-3b, with Dev 3 as route owner); a readable `handoff_own_number` entitlement; an alert-preferences column or contract; publishing `leads` and `bookings` to Realtime; confirmed / cancelled booking times; role-aware RLS (RL-1); an atomic `agent_settings` update; optionally one SQL view for lead counts.
**Product / Raja:** whether a platform-admin screen is wanted; the catalog screen's shape; wording and consent items; the Google Cloud project; template submission.
**External:** staging, a real WhatsApp number, Inngest, embeddings, Google, Docker for `pnpm db:test`.

## E. Security and reliability findings

1. **RLS checks membership, not role.** `services`, `resources`, `leads` (stage, owner, outcome, fields) and `tenants` (name, timezone, hours, **`agent_settings`**) accept writes from any member of the business, staff included (`0002`: `is_member(...)`). The dashboard hides controls from staff; the database doesn't enforce it. BK-1 inherits this: a staff member calling the API directly can change which service the assistant books, its persona, or its tone. **Owner: Dev 2 (decision and migration). Not changed.**
2. **`agent_settings` read-then-write race.** PostgREST can't merge jsonb, so a save reads, changes one key, and writes. Two people saving at the same instant can lose one. The save refuses non-object settings rather than overwriting them. A fix needs an atomic function (Dev 2).
3. **Tenant isolation held in every route and read checked.** The tenant comes from the verified session; `X-Pakka-Tenant` only picks among the caller's own memberships; reads also filter by `tenant_id`. The count requests carry `tenant_id` too (asserted by E2E); a head count returns no rows, so it relies on that filter plus RLS and can't re-check ids.
4. **Misleading success states, fixed:** the template and test-message forms treated any 2xx body as success. They now validate, and say "couldn't confirm" without a one-click retry (the message may have gone). Everything else already parsed responses with zod.
5. **Misleading success states remaining:** none found in the connected callers. Recheck and disconnect ignore the response by design and re-read the connection view.
6. **Duplicate submissions:** staff reply, suggest, mode switch, recheck / disconnect and Load more each guard against a second request in flight (refs or disabled buttons, tested). Template and test-message forms disable the button while sending.
7. **CORS** allows `authorization, content-type, x-pakka-tenant` and exactly the methods each route registers; multipart and PATCH / DELETE are covered. Not checked against a real browser on the deployed origins.
8. **Contract differences noted, not defects:** the UI allows Disconnect for owners only while the API allows owner and admin (documented); the alert link parameter is now `?chat=` on both sides (#112), and the page still accepts `?conversation=`.
9. **Concurrency in tests, not code:** a full Playwright run at four workers on this 15.9 GB machine crashed browsers (`insufficient memory`) in an earlier run; use three or fewer workers.

## F. Git state

See the end of this file for the final status after the last run.

## G. Next priorities

1. **Sync, split and commit.** All of this work is uncommitted on one branch. Split by task (PG-2; lead detail refresh; booking service; inbox older chats; form validation; drift guard; poll fix) using the file lists above, onto the task branches you created. Reason: unmerged work is the largest risk.
2. **Unblock the Day 4 exit tests:** ask Dev 2 and Dev 1 for AH-1 (alert uses the links), D4-3b (route accepts a template), and a decision on XM-1. Reason: exit tests 2 to 4 cannot run through a real alert until then.
3. **A role-aware RLS decision with Dev 2** (RL-1) before the settings screens go to real customers, and an atomic `agent_settings` update. Reason: the only authorization gap found.
4. **A staging run** of the connected routes (the 18 unverified ones) with two businesses and a test number. Reason: every number in this report is mocked.
5. **The catalog editor decision** so the assistant's budget and area scoring has real input. Reason: without catalog rows the best staging score is warm.
