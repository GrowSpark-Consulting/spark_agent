# Frontend regression matrix

What the frontend tests check for the real dashboard, onboarding and sign-in, and what they can't check
yet. Update this file when you add, move or retire a test. Last reviewed 9 Oct 2026 against `main` at `072cf8c`;
files added after that are Dev 3's uncommitted work in this checkout, listed in section N.

## Evidence levels

A ✅ in this file is always one of the first two levels. **Nothing here is evidence at the third.**

| Level | What it is | What it can't show |
|---|---|---|
| **Unit** | Vitest (`pnpm --filter @pakka/frontend test`). Node only, fixed clocks, no network, no DOM, no Supabase. Paths relative to `frontend/`. | Browser layout, real data, RLS |
| **Mocked E2E** | Playwright (`pnpm test:e2e`) at desktop (1440), tablet (820) and mobile (390), through the projects in `playwright.config.ts`. Data comes from `support/mock-supabase.mjs`, a stand-in that speaks the Supabase Auth and PostgREST protocols but runs no Postgres and evaluates no RLS, plus `page.route` stand-ins for API routes (`support/kb-api.ts`, the inbox reply and mode routes). Paths relative to `frontend/tests/e2e/`. | That the real database, its RLS, Realtime, or the real API behaves the same. A test that says "another business's lead isn't shown" proves the screen's own `tenant_id` filter, not RLS. |
| **Real staging or database** | A deployed staging app on a real Supabase (RLS, Realtime, SQL functions) with live WhatsApp. | Section M lists what this still needs. |

In sections A to G every ✅ is mocked E2E unless the Where column says unit. From section H on, the Where
column starts with **E2E** (mocked) or **Unit**.

Status: ✅ covered at the level named · ⛔ blocked on another team (don't fake it) · ➖ not covered yet

## A. Sign-in and navigation

| Behaviour | Status | Where |
|---|---|---|
| Signed-out visits to dashboard pages go to sign-in, then back | ✅ | `app/auth.spec.ts` (home, messages, templates, WhatsApp, preview); `app/navigation.spec.ts` (inbox, knowledge) |
| Sign-in: field errors, wrong password, safe `next` | ✅ | `app/auth.spec.ts` |
| Sign-up, email confirmation, existing address | ✅ | `app/signup.spec.ts` |
| Google sign-in, cancel, failed exchange | ✅ | `app/google.spec.ts` |
| Password reset | ✅ | `app/password-reset.spec.ts` |
| New account goes to onboarding until it has a business | ✅ | `app/signup.spec.ts`, `app/trial-signup.spec.ts` |
| Nav offers exactly the existing sections; each opens at its own address, no redirect | ✅ | `app/navigation.spec.ts` |
| Business name on every screen; current section marked | ✅ | `app/auth.spec.ts`, `app/navigation.spec.ts` |
| Back / Forward between sections | ✅ | `app/navigation.spec.ts` |
| Session survives reload and new tab; log out | ✅ | `app/auth.spec.ts` |
| No business / several businesses / forged tenant cookie | ✅ | `app/auth.spec.ts`, `app/no-business.spec.ts` |

## B. Inbox (`/dashboard/inbox`)

| Behaviour | Status | Where |
|---|---|---|
| List newest first, AI / Needs human / Human tags, masked numbers | ✅ | `app/inbox.spec.ts` |
| Open a chat: bubbles, senders, handoff strip, 24-hour window | ✅ | `app/inbox.spec.ts` |
| Filters and search | ✅ | `app/inbox.spec.ts` |
| Unread filter switched off (nothing stores read state) | ✅ | `app/inbox.spec.ts` |
| Staff reply: sends the trimmed text as the member, Enter / Shift+Enter, refusal keeps the draft, unknown outcome never resends, closed window offers no box (`POST /api/conversations/:id/messages` stood in with `page.route`) | ✅ | `app/inbox.spec.ts` ("Inbox · staff reply") |
| Who replies: Take over, Return to AI, one request per switch, refusal changes nothing, own-number chats can't be switched, a change elsewhere arrives through Realtime (`POST /api/conversations/:id/mode` stood in) | ✅ | `app/inbox.spec.ts` ("Inbox · who replies") |
| Lead card beside or over the chat: score, stage, labelled answers, handover, booking, link; unscored lead; no lead; failed read; never the previous chat's lead; other business's leads never shown | ✅ | `app/inbox-lead-card.spec.ts` |
| Realtime: one subscription per member, live inserts and updates, not connected | ✅ | `app/inbox.spec.ts` |
| Empty and error states | ✅ | `app/inbox.spec.ts` |
| Phone: one column at a time with Back; wide: side by side | ✅ | `app/inbox.spec.ts` |
| Loading state: says it is loading chats, is not mistaken for an empty inbox, then lists them (the chats read is held with `page.route`) | ✅ | `app/inbox.spec.ts` ("says it is loading chats while they are read, then lists them") |
| The list holds the newest 200 chats and says so; a link to an older chat (`?conversation=` from a staff alert, `?chat=` from the takeover link) still opens it, selected beside the 200; an unknown id, or another business's, opens the list with no error | ✅ | E2E `app/inbox-limits.spec.ts`; Unit `features/inbox/data.test.ts` (`fetchConversation`) |
| Marking a chat read | ➖ | nothing stores read state (the Unread filter stays off) |
| Real replies and takeover: a reply reaching WhatsApp, Return to AI closing the chat's handoffs, Realtime from a real database | ➖ | the routes exist in `backend/src/server/routes.ts` and have backend tests, but the frontend tests above stand them in. Needs staging (section M) |

## C. Services (Knowledge base › Services & prices)

| Behaviour | Status | Where |
|---|---|---|
| Table, empty state with Add | ✅ | `app/knowledge.spec.ts` |
| Add, edit, delete with confirmation (Keep it keeps it) | ✅ | `app/knowledge.spec.ts` |
| Validation before saving; nothing sent until valid | ✅ | `app/knowledge.spec.ts` |
| Failed save or delete reported, never shown as done | ✅ | `app/knowledge.spec.ts` |
| Reads and writes scoped to the session's business | ✅ | `app/knowledge.spec.ts` |
| Read error with Try again; dialogs fit the screen | ✅ | `app/knowledge.spec.ts` |
| A service's length, gap between bookings and minimum notice (the fields the slot engine reads) | ✅ | `app/booking-setup.spec.ts` ("sets a service's gap between bookings and minimum notice": validation, saved values, length) |

## D. Knowledge and documents

The knowledge routes (`/api/kb/documents`, `/api/kb/faqs`, `/api/kb/gaps`) are on `main`. The tests stand them
in with `page.route` (`support/kb-api.ts`, which mirrors `docs/contracts.md` section 9) and read rows from the
mock Supabase, so these check the screen against the contract, not the real backend, embeddings or Inngest.

| Behaviour | Status | Where |
|---|---|---|
| Documents newest first, labels, dates, status; scoped reads; empty and error states (rest of page still works) | ✅ | `app/knowledge.spec.ts` ("Knowledge base · documents", "failed reads") |
| Upload: Uploading, Processing, Ready on Realtime; polling when Realtime is off, then stops and offers Check again | ✅ | `app/knowledge.spec.ts` |
| Upload refusals: over 5 MB or wrong type before sending, title over 200 characters, the API's file and title errors, upstream failure, the 100-document limit | ✅ | `app/knowledge.spec.ts` |
| Failed document shows the server's reason with Upload again and Delete; delete after confirming | ✅ | `app/knowledge.spec.ts` |
| FAQs: list, add, edit (sends only what changed), delete after confirming, validation, duplicate question, refused save never shown as done | ✅ | `app/knowledge.spec.ts` ("Knowledge base · FAQs") |
| A FAQ the AI can't use yet is retried by saving it again | ✅ | `app/knowledge.spec.ts` |
| Questions the AI couldn't answer: most asked first, answer adds a FAQ, dismiss, failures keep the question, answer stored but not prepared for the AI | ✅ | `app/knowledge.spec.ts` ("questions the AI couldn't answer") |
| Roles: admin can change everything; staff can answer questions and read the rest; staff are told an owner or admin must retry | ✅ | `app/knowledge.spec.ts` ("who can change it") |
| Routes missing from an older API: "isn't available yet", nothing changes, rest of page works | ✅ | `app/knowledge.spec.ts` ("routes not deployed yet") |
| A document really becoming searchable (upload, extract, embed, ready) and a reply using it | ➖ | needs Inngest, the embeddings provider and a real database (staging, section M) |

## E. WhatsApp (`/dashboard/whatsapp`, home card)

| Behaviour | Status | Where |
|---|---|---|
| No number, Connecting, Checking, Connected, Needs attention, Disconnected | ✅ | `app/whatsapp.spec.ts` |
| Loading, unavailable (view missing), load error | ✅ | `app/whatsapp.spec.ts` |
| Only public fields rendered (no token or secret) | ✅ | `app/whatsapp.spec.ts` |
| Recheck: owner and admin, switched off with the reason | ✅ | `app/whatsapp.spec.ts` |
| Disconnect: owner only; dialog, confirm switched off, Escape / Keep it close it | ✅ | `app/whatsapp.spec.ts` |
| Disconnect sends no request and claims nothing | ✅ | `app/whatsapp.spec.ts` |
| Staff see the status only; home card has no actions or ids | ✅ | `app/whatsapp.spec.ts` |
| Dialog fits at every width | ✅ | `app/whatsapp.spec.ts` |
| Test message refused without an active number (server side) | ✅ | `app/whatsapp.spec.ts`, `app/messaging.spec.ts` |
| Recheck and Disconnect actually working; Connect WhatsApp | ⛔ | no recheck, disconnect or connect routes in `backend/src/server/routes.ts` at `072cf8c` (only `webhook-config`, `manual` and the admin `manual`); handover module 10, Dev 1 |

## F. Onboarding (`/onboarding`)

| Behaviour | Status | Where |
|---|---|---|
| Every step, Back, no overflow; completing is a full load to `/dashboard` | ✅ | `onboarding/onboarding.spec.ts` |
| Business step creates exactly one trial | ✅ | `app/trial-signup.spec.ts` |
| WhatsApp step labelled as a preview; ends "isn't connected yet" | ✅ | `onboarding/onboarding.spec.ts` |
| Live step never shows the number as live | ✅ | `onboarding/onboarding.spec.ts` |
| No token or app-secret fields; no made-up portfolio id, webhook URL or verify token | ✅ | `onboarding/onboarding.spec.ts` |
| No test-send, template-count or Meta-status claims | ✅ | `onboarding/onboarding.spec.ts` |
| Real Embedded Signup popup | ⛔ | needs the code-exchange endpoint (Dev 1); parsing is unit-tested in `lib/whatsapp/embedded-signup.test.ts` |
| The webhook details and the connect call both name the signed-in owner's business (`X-Pakka-Tenant`) next to the user's own token, and nothing is sent when there is no single business | ✅ | E2E `onboarding/onboarding.spec.ts` ("webhook details and connect both name the signed-in owner's business…"); Unit `lib/whatsapp/manual-connect.test.ts`, `lib/whatsapp/tenant-header.test.ts` (real API client, fake `fetch`), `lib/api/tenant.test.ts` |

## G. Prototype (`/dashboard/preview`, sample data)

Covered by `dashboard/*.spec.ts` (screens, dialogs, navigation per width). It is sample data and says
so; it is not evidence that a real feature works.

## H. Leads board (`/dashboard/leads`)

Data: `support/day3.ts` seeds a business per test into the mock Supabase (five leads across stages and temperatures).

| Behaviour | Status | Where |
|---|---|---|
| A column per stage in pipeline order, cards with name, score badge and the first answers; a stage the screen doesn't know gets its own column | ✅ | E2E `app/leads.spec.ts` ("shows a column for every stage…"); Unit `features/leads/data.test.ts`, `features/leads/contract-shapes.test.ts` |
| Filters hot / warm / cold / disqualified / not scored, and a minimum score, exactly as stored (a score is never banded by the screen) | ✅ | E2E `app/leads.spec.ts` ("filters by hot, warm and cold…"); Unit `data.test.ts`, `contract-shapes.test.ts` |
| Score badge words and colours for every temperature, a score with no temperature, zero, nothing | ✅ | Unit `features/leads/score-badge.test.ts` (static markup, no browser) |
| `qualified` and `booked` stages; unknown, missing or wrong-typed stage, score and temperature | ✅ | Unit `contract-shapes.test.ts` (an unknown temperature shows as not scored; a missing stage or non-numeric score refuses the read) |
| Frontend lists match the database constraints (stages, temperatures, booking statuses and kinds) | ✅ | Unit `contract-shapes.test.ts` reads migrations 0001, 0002 and 0015 and fails if they drift |
| Answers as text: `range_inr` as a number (rupees, Indian grouping), as a string (shown verbatim), as `{min, max}`; blank, null, zero, false, lists, nested objects | ✅ | Unit `contract-shapes.test.ts`. **Units are an open question for Dev 1:** nothing converts lakh to rupees. The backend stores only a string or a number for `range_inr` (`backend/src/agent/packs/field-schema.ts`), so `{min, max}` is something the screen can read but the backend can't write today |
| Board scrolls inside itself; the page never scrolls sideways | ✅ | E2E `app/leads.spec.ts` |
| Empty business; failed read with Try again | ✅ | E2E `app/leads.spec.ts` |
| Loading state: says it is loading, shows no board or Refresh meanwhile, then the board | ✅ | E2E `app/leads-paging.spec.ts` ("Leads board · loading"; the leads read is held with `page.route`) |
| More than one page: 200 leads first and a notice, **Load more leads** reads the next pages, 450 leads browsed with none lost or repeated, the button disappears at the end, the read is by value (keyset) not by position | ✅ E2E (mock), ✅ Unit (logic) | E2E `app/leads-paging.spec.ts` ("more than one page"); Unit `features/leads/paging.test.ts` (1,234 leads through the real `fetchLeadsPage`, ties, leads updated or created mid-browse), `features/leads/data.test.ts` |
| The same filters apply to every page, and counts read "200+" while older leads are unread, then exact | ✅ | E2E `app/leads-paging.spec.ts`; Unit `paging.test.ts` (filters across pages equal one read of everything) |
| Loading more is shown on the button, once; a failed page keeps the leads already read and can be tried again; a stale answer (another business, an earlier try) is dropped | ✅ | E2E `app/leads-paging.spec.ts`; Unit `paging.test.ts` (generation and cursor guards) |
| Whether a real PostgREST accepts the paging filter (`or=(updated_at.lt.…,and(updated_at.eq.…,id.lt.…))`) on a real `timestamptz` | ➖ | only a read against a real Supabase can show it; none was run (section M) |
| Exact counts and filters over the whole business (not just the loaded leads) | ⛔ | needs server-side counts per temperature and stage (a SQL view or RPC under RLS). No such contract exists; owner Dev 2 with Dev 1 (section N, PG-2) |
| Leads actually scored by the engine (`score`, `temperature`, stage `qualified`) | ⛔ | nothing in `backend/src` writes them at `072cf8c` (Dev 1). Every real lead reads "Not scored" |
| **Refresh** reads the newest leads again without clearing the board (merged by id, pages already read stay, a gap from a burst starts over from the first page); says whether the board is updating live ("Updating live." or "Not updating live. Use Refresh."); a failed refresh keeps the board and says so | ✅ | E2E `app/leads-paging.spec.ts` ("Leads board · Refresh"); Unit `paging.test.ts`, `components/shared/refresh-control.test.ts` |
| The board updating by itself when a lead changes (Realtime) | ✅ against a stand-in socket | `leads` is in the `supabase_realtime` publication (0026). The board subscribes for this business only, a pushed change (or a burst) is one more read, a change naming another business is ignored, a refused join says "Not updating live". E2E `app/realtime-refresh.spec.ts` (Phoenix protocol emulated, `support/realtime.ts`); Unit `lib/realtime/table-changes.test.ts`. **Real Realtime, RLS on events and the hosted publication are unseen (staging, RT-8)** |

## I. Lead detail (`/dashboard/leads/<id>`)

| Behaviour | Status | Where |
|---|---|---|
| Identity, stage, score, the answers collected, and what is still missing | ✅ | E2E `app/leads.spec.ts` ("shows identity, stage, score, the answers collected and what's missing") |
| Timeline: lead, chat, handovers and bookings, oldest first | ✅ | E2E `app/leads.spec.ts` ("shows the timeline…"); Unit `features/leads/data.test.ts` |
| A lapsed hold and a replaced booking never read as appointments | ✅ | E2E `app/leads.spec.ts`; Unit `features/calendar/booking-lifecycle.test.ts` |
| Another business's lead, or a broken link, isn't shown | ✅ | E2E `app/leads.spec.ts`. Mocked: this proves the screen's own `tenant_id` filter, **not RLS** |
| When a booking was confirmed or cancelled, and by whom | ⛔ | `bookings` has only `created_at`, and the 0015 functions write no audit rows (Dev 2). See section L |
| When a handover was opened | ⛔ | `handoffs` stores no opened time; only picked and resolved appear (`features/leads/data.ts`) |
| Changing stage or owner from the screen | ➖ | not built; the screen is read-only |
| Loading: the lead says it is loading (with the way back to All leads in place), and the timeline loads on its own and says so | ✅ | E2E `app/loading-and-refresh.spec.ts` ("Lead detail") |
| Refresh on the lead detail: says it isn't updating live (`leads` and `bookings` aren't published), reads the lead and its bookings again without clearing the page, shows a change made since it was opened, and a failed refresh (either read) leaves the page as it was and says so | ✅ | E2E `app/lead-detail-refresh.spec.ts`. Live updates themselves: ⛔ until Dev 2 publishes `leads` and `bookings` (see RT-1, RT-2) |

## J. Calendar (`/dashboard/calendar`)

| Behaviour | Status | Where |
|---|---|---|
| Day view: a column per staff member, bookings at their local time, callbacks with no one assigned in their own column | ✅ | E2E `app/calendar.spec.ts` ("day view…"); Unit `features/calendar/calendar.test.ts`, `booking-lifecycle.test.ts` |
| Week view: Monday to Sunday, each booking on its local day | ✅ | E2E `app/calendar.spec.ts` ("week view…"); Unit `calendar.test.ts`, `booking-lifecycle.test.ts` |
| Times in the business's zone, not the viewer's (browser set to New York) | ✅ | E2E `app/calendar.spec.ts` ("shows times in the business's zone…"); Unit `calendar.test.ts`, `booking-lifecycle.test.ts` |
| Booking details read-only, with a link to the lead | ✅ | E2E `app/calendar.spec.ts` |
| Cancelled, moved and expired bookings only when asked for, struck through | ✅ | E2E `app/calendar.spec.ts`; Unit `calendar.test.ts`, `booking-lifecycle.test.ts` |
| Filter by staff member, and by bookings with no one assigned | ✅ | E2E `app/calendar.spec.ts`; Unit `calendar.test.ts`, `booking-lifecycle.test.ts` |
| Previous, next, Today; the address keeps the view; no staff points to Booking setup; failed read with Try again | ✅ | E2E `app/calendar.spec.ts` |
| Creating, moving or cancelling a booking from the calendar | ⛔ | not built (read-only); no booking route exists in `backend/src/server/routes.ts` (Dev 2) |
| Loading: says it is loading bookings, no empty or error message meanwhile | ✅ | E2E `app/loading-and-refresh.spec.ts` ("Calendar: says it is loading bookings…") |
| **Refresh** reads the shown day or week again without clearing it; a refresh that fails keeps the day and says so; moving to another day while a refresh runs shows the new day, never the old answer | ✅ | E2E `app/loading-and-refresh.spec.ts` ("Calendar · Refresh") |
| Booking changes arriving by themselves (Realtime) | ✅ against a stand-in socket | `bookings` is published (0026); the calendar subscribes for this business only; a pushed change or burst is one read of the shown range; another business's change is ignored; a refused join says it isn't live. E2E `app/realtime-refresh.spec.ts`. Unseen on a real server (RT-8) |
| Google Calendar events on the grid | ⛔ | Google sync is not built (Day 4) |

## K. Booking setup (`/dashboard/settings/booking`)

| Behaviour | Status | Where |
|---|---|---|
| Business hours, staff and resources, services with their booking rules | ✅ | E2E `app/booking-setup.spec.ts`; Unit `features/settings/hours.test.ts`, `resources-data.test.ts` |
| Edit hours with a split shift and a closed day; refuse hours that end early or overlap | ✅ | E2E `app/booking-setup.spec.ts` |
| Add a staff member with their own hours and service-area pincodes; validation; back to business hours; a resource with bookings can't be deleted | ✅ | E2E `app/booking-setup.spec.ts` |
| A service's length, gap between bookings and minimum notice | ✅ | E2E `app/booking-setup.spec.ts` |
| Staff see the setup read-only; an empty business is told what to add first; failed read with Try again | ✅ | E2E `app/booking-setup.spec.ts` |
| Loading: staff and resources say they are loading, then show | ✅ | E2E `app/loading-and-refresh.spec.ts` ("Booking setup") |
| Google Calendar per staff member: status shown without ever reading the token, "not switched on", redirect to Google's consent, the outcome after the callback | ✅ | E2E `app/booking-setup.spec.ts` ("Google Calendar per staff member"), Unit `features/settings/google-calendar.test.ts`. The Google side is stood in; no real consent flow was run |
| Service the assistant books (`tenants.agent_settings.bookingServiceId`): a choice when several services are active, saved without touching the other settings, cleared by removing only that key, a refused save says so and changes nothing, a choice that is no longer active is called out, staff read it only | ✅ | E2E `app/booking-service.spec.ts`; Unit `features/settings/booking-service.test.ts`. Whether the real assistant then books that service is the agent's reading of the key: unseen (BK-1) |
| Owner or admin only, enforced by the database | ⛔ | the page hides edits from staff, but RLS lets any member write services and resources (`0002_packs_and_bookings.sql`; the code says so). Tightening it is Dev 2 |
| Real Google OAuth and token storage | ⛔ | needs the Google Cloud project and credentials (Raja); event sync is Day 4 |

## L. Booking lifecycle rendering (unit)

All in Unit `features/calendar/booking-lifecycle.test.ts`: rows shaped like the 0015 functions leave them, run
through parsing, the calendar layers and the lead timeline. The screens' own markup is covered only by E2E (J, I).

| Behaviour | Status | Where |
|---|---|---|
| Held: live hold shown and counted as waiting; expired the moment `hold_expires_at` passes, before the job runs; no stored expiry never expires | ✅ | "held" |
| Confirmed: solid, service and staff labels, customer name with a masked number, business-local time and length, the right local day (1:30 am Tuesday in Chennai is not Monday), per-staff column | ✅ | "confirmed" |
| Cancelled: hidden by default, struck through, reason in the timeline, "replaced" explained, no reason when absent or not text | ✅ | "cancelled" |
| Rescheduled: old row "Moved", new row linked by `rescheduled_from`, only the new one drawn by default, each on its own day, follows a move to another staff member | ✅ | "rescheduled" |
| Missing or odd metadata: no staff, no service, unreadable contact, malformed details, unknown status or kind, a staff member not in the list | ✅ | "missing or odd optional metadata" |
| The status tables cover every status the database allows | ✅ | "the status tables" |
| Showing when a booking was confirmed or cancelled | ⛔ | `bookings` has only `created_at`; every timeline line is placed there (Dev 2). `it.todo` in the file |
| Showing a moved booking's previous time | ⛔ | the new row names the old one by id only (Dev 2). `it.todo` |
| The lead's stage after a cancellation | ⛔ | `cancel_booking` leaves `leads.stage` alone, so a lead can read "Booked" with only a cancelled booking (Dev 1 and Dev 2). `it.todo` |

## M. Real staging or database verification: not done

Nothing below has been run. None of the ✅ above is evidence for any of it.

| Needs a real database or staging | Status | How it would be checked |
|---|---|---|
| RLS: a member reads and writes only their own business's leads, bookings, resources, services, conversations | ➖ | `pnpm db:test` (pgTAP, needs Docker) and a staging login as two businesses |
| Roles: staff refused when writing services, resources and hours directly | ➖ | needs the RLS change first (Dev 2) |
| Realtime reaching the Inbox from a real database; leads and calendar updating | ➖ | needs a real project; leads and calendar have no live updates yet |
| Lead to booking to calendar: a chat produces a score, three slots, a confirmed booking, stage "Booked" and a calendar block for the right staff member | ⛔ | the agent does not score or book yet (Dev 1) |
| Live WhatsApp: replies, takeover, Return to AI, list and button messages | ➖ | staging with a connected test number |
| Real knowledge base ingestion and an answer from it | ➖ | staging with Inngest and the embeddings provider |
| Google Calendar consent and token storage | ⛔ | Google Cloud project (Raja) |
| Which tables the hosted database really publishes to Realtime (`select * from pg_publication_tables where pubname = 'supabase_realtime'`) | ➖ | the migration files are checked by `lib/realtime/published-tables.test.ts`; whether the hosted project applied them is only visible on staging |
| The paging filter against a real PostgREST and `timestamptz` (section H) | ➖ | a real read on staging with more than 200 leads |
| The WhatsApp calls with the business header accepted by the real API for a member, refused for a non-member | ➖ | needs a running API and database (section N, WA-1) |

## N. Integration dependency tracker

One row per thing that depends on another team, on the database, or on a provider. Unlike sections A to M this is about
**what is still open**, so it uses its own status words. A mocked test passing never moves a row to **verified**.

| Status | Means |
|---|---|
| **verified** | The behaviour is fully decided by code in this repo and its tests pass (pure logic, fixed clocks). Real data and real infrastructure are not claimed. |
| **partial** | The frontend side is done and tested; the other side is unbuilt or unseen. |
| **mocked** | Works and passes against a stand-in (fake client, mock Supabase, `page.route`). Says nothing about the real thing. |
| **blocked** | Cannot be finished or switched on until the named owner delivers the named thing. |
| **not started** | Nothing built or checked yet. |
| **broken** | Built, and wrong. |

Commands run from the repository root. Unit: `pnpm --filter @pakka/frontend exec vitest run <path>`. E2E: `pnpm --filter @pakka/frontend exec playwright test <path>` (builds the app; run one suite at a time).

### Booking timestamps

| ID | Day · Owner | Requirement | Frontend component · API contract | Expected behaviour | Test · command | Status | Dependency · blocking owner | Evidence · next action |
|---|---|---|---|---|---|---|---|---|
| BT-1 | D3–D4 · Dev 2 (data), Dev 3 (screen) | Confirmed time in the lead timeline and calendar details | `features/leads/data.ts` (`bookingEntry`), `features/calendar/bookings.ts` (`BOOKING_COLUMNS`). **No contract:** `bookings` has only `created_at` (0001, 0015); the 0015 functions write no audit rows | A confirmed booking reads "Confirmed <time>", in business-local time, in its true place in the timeline | `features/calendar/booking-lifecycle.test.ts` (`it.todo`) · `vitest run features/calendar/booking-lifecycle.test.ts` | **unblocked** | Dev 2 (0026, 12 Oct): `bookings.status_changed_at` (when the status last changed, a trigger; equals `created_at` before any change), audit rows `booking.completed`, `booking.no_show`, `booking.cancelled`, `booking.rescheduled` from the calendar actions. The screen part is **Dev 3** | Every line is placed at `created_at` today (tested). Ask Dev 2: the field's name and type, null while held, and a separate one for cancelled. Then replace the `it.todo` with real tests |
| BT-2 | D3–D4 · Dev 2, Dev 3 | Cancelled time, and by whom | same | A cancelled booking reads "Cancelled <time>" with the reason | same (`it.todo`) | **unblocked** | Dev 2 (0026): `status_changed_at` for the time; `details.cancelled_by` (the member) when cancelled from the calendar, `details.cancel_reason` always (the chat writes "Cancelled by the customer in the chat"). The screen part is **Dev 3** | `details.cancel_reason` is shown today; no time and no actor exist |
| BT-3 | D3 · Dev 3 | Null, missing and malformed optional values | `features/calendar/bookings.ts` (`toBooking`), `features/leads/data.ts` | No staff, no service, no contact, no or odd `details`, unknown status or kind all render without error or an invented time | `booking-lifecycle.test.ts` ("missing or odd optional metadata", "what the database doesn't provide") · same | **verified** (logic) | none | Real rows from a real database are not claimed |
| BT-4 | D3 · Dev 3 | Ordering and business-local time zone display | `features/calendar/time.ts`, `features/leads/data.ts` (`buildTimeline`) | Business zone, never the viewer's; stable order | `booking-lifecycle.test.ts`, `calendar.test.ts`, `data.test.ts`; E2E `app/calendar.spec.ts` (viewer in New York) | **verified** (logic), **mocked** (E2E) | none | Real data unverified |

### Realtime and refresh

| ID | Day · Owner | Requirement | Frontend component · API contract | Expected behaviour | Test · command | Status | Dependency · blocking owner | Evidence · next action |
|---|---|---|---|---|---|---|---|---|
| RT-1 | D3–D4 · Dev 2 (publication, done in 0026), Dev 3 | Lead updates and score changes arrive by themselves | `lib/realtime/use-table-refresh.ts` → `features/leads/leads-board.tsx`; `leads` is in `PUBLISHED_TABLES` | The board reads again within about half a second of a change to this business's leads | Unit `lib/realtime/table-changes.test.ts`, `published-tables.test.ts`; E2E `app/realtime-refresh.spec.ts` | **mocked** | A real Realtime server on staging · **Dev 2 / ops** | 13 Oct: found and fixed a browser-only bug that made every refresh throw `Illegal invocation` once `leads` was published (`createCoalescer`'s default timers were called as methods). The E2E suite had been red on `main` since 0026 because the mock had no socket; `support/app.ts` now answers one for every test |
| RT-2 | D3–D4 · Dev 2 (done in 0026), Dev 3 | Booking created, confirmed, rescheduled, cancelled reach the calendar | same → `features/calendar/calendar-screen.tsx` (`bookings`) | Same, for the shown range | same | **mocked** | As RT-1 | As RT-1 |
| RT-3 | D3 · Dev 3 | Tenant isolation | `lib/realtime/table-changes.ts` | The channel filters on `tenant_id=eq.<id>`; a change naming another business is ignored | `table-changes.test.ts` | **mocked** | Realtime applying the member's RLS · **Dev 2** | Fake client only. Real isolation needs two businesses on staging |
| RT-4 | D3 · Dev 3 | Subscription cleanup on leaving, on changing business, on changing tables | same | Channel removed, pending read dropped, late events ignored, nothing created if stopped early | `table-changes.test.ts` | **mocked** | none | A real WebSocket was not exercised |
| RT-5 | D3 · Dev 3 | Loading, error and stale data | `leads-board.tsx`, `calendar-screen.tsx`, `features/leads/paging.ts` | Refresh keeps what is on screen; a failed refresh says so; an answer for an earlier business, try or range is dropped | Unit `features/leads/paging.test.ts`; E2E `app/leads-paging.spec.ts`, `app/loading-and-refresh.spec.ts` | **mocked** | none | Passes against the mock Supabase |
| RT-6a | D3 · Dev 3 | Repeated or bursty events do not duplicate data or flood reads | `createCoalescer` in `lib/realtime/table-changes.ts`; merge by id in `paging.ts` | A burst becomes one read; the same answer twice changes nothing | `table-changes.test.ts`, `paging.test.ts` | **verified** (logic) | none | Pure logic with fixed clocks |
| RT-6b | D3 · Dev 3 | The manual refresh fallback works | `components/shared/refresh-control.tsx` | Refresh reads again, disabled while it runs, never clears the screen | `refresh-control.test.ts`; E2E `leads-paging.spec.ts`, `loading-and-refresh.spec.ts` | **mocked** | none | Mock Supabase |
| RT-7 | D2 · Dev 3 | The Inbox's own Realtime (already built) | `features/inbox/use-inbox-realtime.ts` | Live inserts and updates, resync after a drop | E2E `app/inbox.spec.ts` (Phoenix protocol emulated with `routeWebSocket`) | **mocked** | none | Not seen on a real Realtime server |
| RT-8 | D3 · Dev 2 | What the hosted database really publishes | n/a | `leads` and `bookings` listed (when intended) | none | **not started** (migration 0026 on `main` publishes `leads` and `bookings`; the hosted database is unchecked) | Run `select * from pg_publication_tables where pubname = 'supabase_realtime'` on staging · **Dev 2** | Migration files only are checked (`published-tables.test.ts`) |

### WhatsApp connection

| ID | Day · Owner | Requirement | Frontend component · API contract | Expected behaviour | Test · command | Status | Dependency · blocking owner | Evidence · next action |
|---|---|---|---|---|---|---|---|---|
| WA-1 | D2–D4 · Dev 3 (client), Dev 1 (route) | `X-Pakka-Tenant` on the WhatsApp calls | `lib/whatsapp/manual-connect.ts`, `lib/api/tenant.ts`, `components/onboarding/step-whatsapp.tsx`, `own-app-connect.tsx`. Backend: `requireTenant` in `backend/src/server/auth.ts` resolves the business from the header against the caller's memberships | `webhook-config` and `manual` both send the signed-in member's business and bearer token; neither is sent without one clear business | Unit `lib/whatsapp/manual-connect.test.ts`, `tenant-header.test.ts`, `lib/api/tenant.test.ts`; E2E `onboarding/onboarding.spec.ts` | **partial** | The real API accepting the header for a member and refusing a non-member needs a running API and database · **Dev 1 / Dev 2** | The header leaves the browser (checked with the real API client and in a real browser against stubs). The backend's side is unverified |
| WA-2 | D2–D4 · Dev 1 (backend), Dev 3 (screen) | Connection status versus webhook verification | `components/dashboard/whatsapp-connection-panel.tsx` (label from `status` and `last_check`), `whatsapp-connection-checks.tsx`, `lib/whatsapp/last-check.ts`. Backend `connect/{manual,checks,recheck}.ts`: `active` unless a check fails; `webhook_subscribed` stays `not_verified` until a signed webhook from the business's own app arrives | An active number whose stored checks don't show a passed webhook reads "Connected, webhook not confirmed" (not plain "Connected"); plain "Connected" and "All 6 checks passed." only when `last_check` proves them; `{}` (never checked) and an unreadable result claim nothing extra | Unit `lib/whatsapp/last-check.test.ts`; E2E `app/whatsapp.spec.ts` › WhatsApp connection checks | **mocked** | The wording is provisional · **Raja**; the Graph calls behind the checks are unverified against a live Meta account · **Dev 1** | Built against the contract in `docs/whatsapp-connection-contract.md` (`last_check`). Not seen against a real Meta account |
| WA-3 | D2–D4 · Dev 3 | Request failures: 401, 403, offline, no business | `lib/whatsapp/manual-connect.ts` | A safe message, retry only when retrying can help, secrets never in a message | `manual-connect.test.ts`, `tenant-header.test.ts`; E2E `onboarding.spec.ts` | **mocked** | none | Stubbed API |
| WA-4 | D5 · Dev 1 | Recheck and disconnect | `lib/whatsapp/connection-actions.ts` (`CONNECTION_SERVICES` → `POST /api/whatsapp/connections/:id/recheck` and `/disconnect`, no body, `X-Pakka-Tenant`), `components/dashboard/whatsapp-connection-actions.tsx` | Recheck shows it is working and then the new checks; Disconnect asks first; neither can be sent twice; a stale answer (`conflict`, `not_found`, `forbidden`) re-reads the page; a failure says so and changes nothing | Unit `lib/whatsapp/connection-actions.test.ts`; E2E `app/whatsapp.spec.ts` (the two POST routes are stood in for: they need Meta and the service-role database) | **mocked** | The routes exist (`routes.ts`, #109); a recheck against real Meta and a real disconnect are not yet seen · **Dev 1** / staging | The API allows owner and admin for both; the screen offers disconnect to the owner only (its own stricter choice) |
| WA-5 | D2–D4 · Dev 3 | Several businesses, or none: no request | `lib/api/tenant.ts`, `manual-connect.ts` (`resolveWhatsAppTenant`) | No request; a message that says why and points to the dashboard's chooser | `lib/api/tenant.test.ts`, `manual-connect.test.ts` | **verified** (logic) | none | An account with a business never sees onboarding, so this guards a rare path |
| WA-6 | D2–D4 · Ops / Dev 2 | Deployment settings the connect flow needs | `lib/env.ts` (`NEXT_PUBLIC_API_URL`); backend `API_PUBLIC_URL`, `ENCRYPTION_KEY`, `META_*` | The flow starts | none | **not started** | Check the hosted Vercel and Railway settings (names only) · **Dev 2 / ops** | Not checkable from the repository |

### Other open contracts

| ID | Day · Owner | Requirement | Frontend component · API contract | Expected behaviour | Test · command | Status | Dependency · blocking owner | Evidence · next action |
|---|---|---|---|---|---|---|---|---|
| PG-1 | D3 · Dev 3 | Leads board beyond one page | `features/leads/data.ts` (`fetchLeadsPage`), `paging.ts`, `leads-board.tsx`. Plain PostgREST under RLS: order by `updated_at`, `id`; keyset `or` filter; `limit` | 200 at a time, **Load more**, nothing lost or repeated | Unit `paging.test.ts`; E2E `app/leads-paging.spec.ts` | **partial** | A real read with more than 200 leads against real PostgREST · staging | Logic verified; UI mocked; the `or` filter on a real `timestamptz` is unseen |
| PG-2 | D3 · Dev 2 with Dev 1 | Exact counts and filters over the whole business | none (filters run over loaded leads; counts say "200+") | Counts per temperature and stage over every lead | none | **blocked** | A SQL view or RPC under RLS · **Dev 2** | No contract exists |
| LC-1 | D4 · Dev 1 | Lead-card JSON | `features/inbox/lead-card-api.ts` (`GET /api/conversations/:id/lead-card`, contract `backend/src/agent/leadcard/card.ts`), `lead-card-panel.tsx`, `inbox-screen.tsx`. The provisional adapter and sample are deleted | The AI rows (need, summary, next step, discount, sentiment, language, source, suggested reply, hot and priority flags) appear beside the stored lead, for the right chat only; `score: null` is handled; a failure stays inside the card | Unit `features/inbox/lead-card-api.test.ts`, `lead-card-panel.test.ts`; E2E `app/inbox-lead-card.spec.ts` (the route is stood in for: it needs the model) | **mocked** | The route against the real model and database is unseen · **Dev 1** / staging | Only read for a customer who is a lead. The stored score, answers and booking stay the database's; the route's copies and the customer's full number are not drawn |
| TP-1 | D4 · Dev 2 (entitlement), Dev 1 (consumer) | Takeover preference | `memberships.takeover_pref` ('inbox', 'own_number', 'ask'; members update their own row: 0002, `docs/contracts.md`). `features/team/` | A member picks how they take over chats | none | **blocked** | The entitlement is `isEnabled(tenantId, "handoff_own_number")` (`backend/src/features/is-enabled.ts`: tenant live, plan includes it, toggle on). Nothing readable from the browser computes it; copying that rule into the UI would invent a contract · **Dev 2** | Dev 1's takeover link now reads the value (`inbox` blocks it; `own_number`, `ask` and unset allow it) and needs `whatsapp_phone`, which the Team screen already sets. The one-time "I agree" consent has no contract. Not built |
| OW-1 | D4 · Dev 2, Dev 1 | Own-number option only on a plan that includes it | none | Shown only when eligible | none | **blocked** | `handoff_own_number` eligibility contract · **Dev 2**; own-number mode · **Dev 1** | Stays hidden. Plan names are not hardcoded in the UI |
| TM-1 | D4 · Dev 3 (screen), Dev 2 (route, done) | Template picker outside the 24-hour window | `features/inbox/{template-reply,template-reply-panel,staff-reply}`, `chat-view.tsx`. `POST /api/conversations/:id/messages` `{ template: { name, language, params } }` (`SendStaffTemplateInput`, `backend/src/conversations/staff-reply.ts`); approved templates read from `whatsapp_templates` under RLS | Staff pick an approved template, fill its {{n}} values, see a preview and send; success only after the API accepts; refusals (`not_found`, `validation_failed`) shown with the choice kept; an unknown outcome says check the chat | Unit `template-reply.test`, `staff-reply.test`; E2E `app/inbox-template-reply.spec.ts` (templates read and route stood in) | **mocked** | The table does not say which number a chat is on; with several numbers a template approved elsewhere is listed and the API answers not_found · **Dev 2** (a connection id on conversations, if wanted). Real send needs staging | 12 Oct: built after checking the route and `notify.send` in code |
| SR-1 | D5 · Dev 1 | AI-suggested reply | `features/inbox/suggest-reply.ts`, `reply-composer.tsx` (`POST /api/conversations/:id/suggest`, no body) | A button fills the reply box; nothing is sent; a typed draft is never replaced without asking; `reply: null` is "No suggestion this time"; failures are safe; a late answer is dropped | Unit `features/inbox/suggest-reply.test.ts`; E2E `app/inbox.spec.ts` › Inbox · suggested reply (route stood in for) | **mocked** | The real model's suggestions are unseen · **Dev 1** / staging | Nothing is sent by the button; the E2E counts the send route and finds none |
| AL-1 | D4 · Dev 2 (link), Dev 3 (page) | A staff alert opens the right chat | `backend/src/notify/staff-alerts.ts` now links to `/dashboard/inbox?chat=<id>`, the parameter `app/(dashboard)/dashboard/(app)/inbox/page.tsx` reads (and since #116 the page also opens `?conversation=<id>`) | The tapped alert opens the conversation | none | **fixed** | none | Found in the audit. Dev 2 changed the alert links to `?chat=` (12 Oct), the same parameter as Dev 1's takeover link; Dev 3's #116 accepts both |
| CAT-1 | D3 · Dev 3 | Scoring reads the business's catalog: `catalog_items.price_from`, `attributes.price_to`, `attributes.area` or `attributes.areas` | none. The dashboard never reads or writes `catalog_items`; the Knowledge → Services editor writes the `services` table (`features/knowledge/data.ts`). Backend reader: `backend/src/agent/scoring/{catalog-db,references}.ts` (`CATALOG_ATTRIBUTES`) | Budget and area rules earn points; a budget far below the cheapest home disqualifies | none | **blocked** | A catalog editor does not exist (`docs/handover.md` lists a "dashboard editor with media upload" for the catalog engine) · Dev 3 with the product owner, once its screen and per-pack fields are decided | The two tables do not overlap: `services` has `price_min`/`price_max`, scoring reads `catalog_items`. There is no write path to map, so nothing is renamed; a new editor must save exactly the backend's three names. On staging the seed has no catalog rows: the best score is warm |
| IB-1 | D4 · Dev 3 | A staff alert or takeover link opens a chat older than the newest 200; the page limits are stated | `features/inbox/data.ts` (`fetchConversation`), `inbox-screen.tsx` (`loadList` reads the linked chat by id when it isn't in the newest page), `conversation-list.tsx` (notice), `chat-view.tsx` (notice at 300 messages) | The linked chat opens whatever its age; a full page says older chats exist; a foreign or unknown id opens the list | Unit `data.test.ts`; E2E `app/inbox-limits.spec.ts` | **mocked** | none | Found in the 12 Oct audit: before, a link to a chat outside the newest 200 selected nothing and nothing said the list was cut. `mock-supabase.mjs` now honours `order` and `limit` for conversation reads, as PostgREST does |
| BK-1 | D3 · Dev 3 with Dev 1 | Which service the assistant books when a business has several | `features/settings/booking-service.ts`, `booking-service-section.tsx` on `/dashboard/settings/booking`; writes `tenants.agent_settings.bookingServiceId` (members may update `agent_settings`: 0002); read by `backend/src/agent/pipeline/{persona,reply}.ts` | One active service is booked on its own; with several, the chosen one; no choice hands the chat to a person. A save keeps every other key, and never overwrites settings that aren't a plain object | Unit `booking-service.test.ts`; E2E `app/booking-service.spec.ts` | **mocked** | The `agent_settings` shape is still "To define: Dev 1 + Dev 3" (`docs/contracts.md`, open decision 8), so the key's home is Dev 1's call · **Dev 1** + staging to see the assistant honour it | Replaces the by-hand SQL in the Day 3 handoff note (section 7). The save is read-then-write on one jsonb column: two people saving at the same instant could lose one; only this screen writes the key |
| XM-1 | D4 · Dev 3 (mode route) with Dev 1 | An own-number (`external`) chat can go back to the AI | `backend/src/conversations/mode.ts:48` answers `conflict` to any change from `external`; `features/inbox/chat-view.tsx` disables the switch for it. Dev 1's Day 4 note says only "Return to AI" returns such a chat | Staff can hand an own-number chat back | none | **blocked** | A product decision, then a change to `conversations/mode.ts` (backend, outside this frontend work) · Dev 3 as route owner with Dev 1 | Today nothing returns an own-number chat to the AI: not the 24-hour return (that is for `human` chats after a phone reply) and not the inbox. The frontend is right to follow the route; fix the route first |
| AH-1 | D4 · Dev 1 + Dev 2 | The staff alert carries the lead card and two signed URL buttons | `backend/src/notify/staff-alerts.ts:101` sends `headline` and a plain `/dashboard/inbox?conversation=<id>` link; `createHandoffLinks` (`agent/handoff/token.ts`) has no caller outside its tests, so `/h/:token` is never sent | Alert with the card text and an inbox button (and an own-number button on a plan that has `handoff_own_number`) | none | **blocked** | Wiring `createHandoffLinks` into the alert, and the two-button message · **Dev 2** (alert) with **Dev 1** (links) | Until then Day 4 exit tests 2 to 4 (card, plan-gated buttons, expired / reused / wrong-staff token) cannot be run through a real alert. The frontend side (the inbox opens either link's chat) is done |

### Files added or changed by this work (uncommitted)

New: `lib/api/tenant.ts`, `lib/realtime/{published-tables,table-changes,use-table-refresh}.ts`, `components/shared/refresh-control.tsx`, `features/leads/paging.ts`, `features/inbox/lead-card-provisional.ts` and `fixtures/inbox/provisional-lead-card.ts` (both since deleted, see the 12 Oct list below), and their tests, plus `tests/e2e/app/{leads-paging,loading-and-refresh}.spec.ts`.
Changed: `lib/whatsapp/manual-connect.ts`, `components/onboarding/{step-whatsapp,own-app-connect}.tsx`, `features/leads/{data,leads-board}.tsx|ts`, `features/calendar/calendar-screen.tsx`, `features/inbox/lead-card-panel.tsx`, and test support `tests/e2e/support/{mock-supabase.mjs,day3.ts}`.

**12 Oct 2026 (on `main` at `602e26e`, uncommitted).** New: `features/inbox/{initial-chat,lead-card-api,suggest-reply}.ts`, `lib/whatsapp/last-check.ts`, `components/dashboard/whatsapp-connection-checks.tsx`, `fixtures/inbox/lead-card-response.ts`, `tests/e2e/support/lead-card-api.ts`, and their tests. Changed: `app/(dashboard)/dashboard/(app)/inbox/page.tsx`, `features/inbox/{inbox-screen,lead-card-panel,reply-composer}.tsx`, `lib/api/client.ts` (`getJson`), `lib/whatsapp/connection-actions.ts`, `components/dashboard/whatsapp-connection-{panel,actions}.tsx`, `tests/e2e/app/{inbox,inbox-lead-card,whatsapp}.spec.ts`, `tests/e2e/support/mock-supabase.mjs` (a per-test WhatsApp account). Deleted: `features/inbox/lead-card-provisional.ts`, `fixtures/inbox/provisional-lead-card.ts`.

**12 Oct 2026, audit run (uncommitted, on top of the list above).** New: `features/settings/booking-service{,-section}` (`.ts`, `.tsx`) and `booking-service.test.ts`, `tests/e2e/app/{inbox-limits,lead-detail-refresh,booking-service}.spec.ts`. Changed: `features/inbox/{data,data.test,inbox-screen,conversation-list,chat-view}`, `features/leads/lead-detail.tsx`, `features/settings/booking-setup-screen.tsx`, `tests/e2e/app/knowledge.spec.ts` (poll back-off only), `tests/e2e/support/{mock-supabase.mjs,day3.ts}`, this file.

## Known flakes

**12 Oct 2026, `knowledge.spec.ts:587` "stops polling after the polling window and offers Check again": cause found, partly fixed.**
Reported earlier as one timeout on tablet that passed alone. Evidence from this run:

- It is intermittent on all three widths: it timed out on desktop in a full run (39.0 s) and on tablet in a rerun of the three files
  that had failures (44.6 s), and passed on desktop (22.5 s) and mobile (20.3 s) in that same rerun. The limit is Playwright's
  default 30 s (`playwright.config.ts` sets no `timeout`), so even a passing run used about 70% of it.
- Cause: the test makes 100 rounds, each one `page.clock.runFor(3_000)` then an `expect.poll` for the round's own read. The read has
  not landed when the poll first looks, so every round paid `expect.poll`'s default 100 ms back-off before the second look. That is
  most of the 20 s; any slowdown of about 1.5x (four workers, a busy machine) crosses 30 s.
- Change: the poll's `intervals` are now `[20, 50, 100, 250]`. The 100 rounds and the exact-count assertion are unchanged. Nine
  runs (3 per width, four in parallel) passed in 8.7 to 17.2 s, against 20.3 to 22.5 s for the passes before. The load sensitivity is
  reduced, not removed: if it still fails on a busy machine, the next step is `test.slow()` on this test, not fewer rounds.
- Not the cause: the feature code. `knowledge.spec.ts`, `features/knowledge/` and `support/kb-api.ts` are unchanged by the
  uncommitted work, and the failure was reported before the 12 Oct changes. A baseline run of an unmodified checkout was not made (it
  needs a second install and build), so "no regression from the uncommitted work" rests on that and not on a comparison.

**12 Oct 2026, eight mobile failures in one full run: the machine ran out of memory, not the tests.** One full run
(931 tests: 909 passed, 9 failed, 13 skipped, 18.8 min, against 10.7 min earlier) had 9 failures: the one above on desktop, and 8 on mobile (4 in `inbox.spec.ts`,
4 in `navigation.spec.ts`). The mobile errors were `Target crashed`, `insufficient memory`, `browserContext.newPage` and
`page.evaluate: Target page, context or browser has been closed`, with Chromium's `GPU process launch failed` lines and truncated
trace zips ("End of central directory record signature not found"). The machine had 15.9 GB of memory with other applications open.
All 8 passed when their files were rerun (184 tests, 5.5 min): none is an assertion failure. Run one suite at a time, close other
applications, and use `--workers=2` if it happens again.


**7 Oct 2026, not reproduced.** One full run (430 tests, 7.0 min) had 7 failures: password reset, three
signup tests and three prototype `?screen=` checks. All 7 passed when rerun on their own. Investigation:

- Two clean full-suite runs on an idle machine passed 420/420 with the usual 10 skips (5.4 and 4.8
  min). Affected specs together also passed: password reset + signup (28), signup + prototype
  navigation (67), all three (76).
- Not a regression, and no shared-state cause found: the failing tests each use their own
  `uniqueEmail()` account, signing up as an existing address changes nothing in the mock, and logout
  revokes only the token it is given, so the shared owner session survives other tests logging out.
- The error text from the failing run was lost (local retries are 0, and `test-results/` was emptied by
  a later run), so the exact failing assertion is unknown. The failing run was about 30% slower than
  the clean ones, which points to load on the machine at the time.
- No fix was made: none is justified without a reproduction. No test was skipped, disabled, retried or
  given a longer timeout to hide it. A later 8-worker stress run is not evidence: the working tree
  changed while it ran.

If these fail again, keep the run's `test-results/` (or run with `--output` to a folder of your own)
and record the error, worker and duration before rerunning. Two sessions sharing this checkout also
share the E2E ports, `.next/` and `test-results/`: run one suite at a time.

## Not testable from the frontend yet

- Anything behind a missing API: WhatsApp connect / recheck / disconnect, creating, moving or cancelling a
  booking from the dashboard, a dashboard summary.
- Anything the backend does not write yet: lead score and temperature, the `qualified` stage, when a booking
  was confirmed or cancelled, when a handover opened (sections H, I, L).
- Database rules (RLS, functions): `pnpm db:test` needs Docker and local Supabase; see section M.
- Assistant replies: `fixtures/regression/tanglish-queries.ts` holds 15 representative questions for when
  the reply pipeline exists. It has no answers by design.
