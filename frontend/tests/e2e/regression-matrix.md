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
| **Refresh** reads the newest leads again without clearing the board (merged by id, pages already read stay, a gap from a burst starts over from the first page); says plainly the board isn't updating live; a failed refresh keeps the board and says so | ✅ | E2E `app/leads-paging.spec.ts` ("Leads board · Refresh"); Unit `paging.test.ts`, `components/shared/refresh-control.test.ts` |
| The board updating by itself when a lead changes (Realtime) | ⛔ | `leads` is not in the `supabase_realtime` publication (Dev 2 migration). The subscription code exists and is tested against a fake client, but is switched off by design until the publication lists the table (`lib/realtime/published-tables.ts`, section N) |

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
| Refresh and live updates on the lead detail | ➖ | not built: Refresh and Realtime were added to the board and the calendar only |

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
| Booking changes arriving by themselves (Realtime) | ⛔ | `bookings` is not in the `supabase_realtime` publication (Dev 2 migration); the subscription is switched off by design until it is (section N) |
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
| BT-1 | D3–D4 · Dev 2 (data), Dev 3 (screen) | Confirmed time in the lead timeline and calendar details | `features/leads/data.ts` (`bookingEntry`), `features/calendar/bookings.ts` (`BOOKING_COLUMNS`). **No contract:** `bookings` has only `created_at` (0001, 0015); the 0015 functions write no audit rows | A confirmed booking reads "Confirmed <time>", in business-local time, in its true place in the timeline | `features/calendar/booking-lifecycle.test.ts` (`it.todo`) · `vitest run features/calendar/booking-lifecycle.test.ts` | **blocked** | A status-change time readable under RLS (column or audit rows) · **Dev 2** | Every line is placed at `created_at` today (tested). Ask Dev 2: the field's name and type, null while held, and a separate one for cancelled. Then replace the `it.todo` with real tests |
| BT-2 | D3–D4 · Dev 2, Dev 3 | Cancelled time, and by whom | same | A cancelled booking reads "Cancelled <time>" with the reason | same (`it.todo`) | **blocked** | same · **Dev 2** | `details.cancel_reason` is shown today; no time and no actor exist |
| BT-3 | D3 · Dev 3 | Null, missing and malformed optional values | `features/calendar/bookings.ts` (`toBooking`), `features/leads/data.ts` | No staff, no service, no contact, no or odd `details`, unknown status or kind all render without error or an invented time | `booking-lifecycle.test.ts` ("missing or odd optional metadata", "what the database doesn't provide") · same | **verified** (logic) | none | Real rows from a real database are not claimed |
| BT-4 | D3 · Dev 3 | Ordering and business-local time zone display | `features/calendar/time.ts`, `features/leads/data.ts` (`buildTimeline`) | Business zone, never the viewer's; stable order | `booking-lifecycle.test.ts`, `calendar.test.ts`, `data.test.ts`; E2E `app/calendar.spec.ts` (viewer in New York) | **verified** (logic), **mocked** (E2E) | none | Real data unverified |

### Realtime and refresh

| ID | Day · Owner | Requirement | Frontend component · API contract | Expected behaviour | Test · command | Status | Dependency · blocking owner | Evidence · next action |
|---|---|---|---|---|---|---|---|---|
| RT-1 | D3–D4 · Dev 2 (publication), Dev 3 | Lead updates and score changes arrive by themselves | `lib/realtime/use-table-refresh.ts` → `features/leads/leads-board.tsx`. Contract: `leads` listed in `supabase_realtime` | The board reads again within about half a second of a change to this business's leads | `lib/realtime/table-changes.test.ts`, `published-tables.test.ts` · `vitest run lib/realtime` | **blocked** | A migration adding `leads` to the publication · **Dev 2** | The code is ready and switched off: only published tables are subscribed to, so the board says "Not updating live" and Refresh is the way to update. When the migration lands, `published-tables.test.ts` fails and names the list to extend; then confirm on staging |
| RT-2 | D3–D4 · Dev 2, Dev 3 | Booking created, confirmed, rescheduled, cancelled reach the calendar | same → `features/calendar/calendar-screen.tsx` (`bookings`) | Same, for the shown range | same | **blocked** | `bookings` in the publication · **Dev 2** | As RT-1 |
| RT-3 | D3 · Dev 3 | Tenant isolation | `lib/realtime/table-changes.ts` | The channel filters on `tenant_id=eq.<id>`; a change naming another business is ignored | `table-changes.test.ts` | **mocked** | Realtime applying the member's RLS · **Dev 2** | Fake client only. Real isolation needs two businesses on staging |
| RT-4 | D3 · Dev 3 | Subscription cleanup on leaving, on changing business, on changing tables | same | Channel removed, pending read dropped, late events ignored, nothing created if stopped early | `table-changes.test.ts` | **mocked** | none | A real WebSocket was not exercised |
| RT-5 | D3 · Dev 3 | Loading, error and stale data | `leads-board.tsx`, `calendar-screen.tsx`, `features/leads/paging.ts` | Refresh keeps what is on screen; a failed refresh says so; an answer for an earlier business, try or range is dropped | Unit `features/leads/paging.test.ts`; E2E `app/leads-paging.spec.ts`, `app/loading-and-refresh.spec.ts` | **mocked** | none | Passes against the mock Supabase |
| RT-6a | D3 · Dev 3 | Repeated or bursty events do not duplicate data or flood reads | `createCoalescer` in `lib/realtime/table-changes.ts`; merge by id in `paging.ts` | A burst becomes one read; the same answer twice changes nothing | `table-changes.test.ts`, `paging.test.ts` | **verified** (logic) | none | Pure logic with fixed clocks |
| RT-6b | D3 · Dev 3 | The manual refresh fallback works | `components/shared/refresh-control.tsx` | Refresh reads again, disabled while it runs, never clears the screen | `refresh-control.test.ts`; E2E `leads-paging.spec.ts`, `loading-and-refresh.spec.ts` | **mocked** | none | Mock Supabase |
| RT-7 | D2 · Dev 3 | The Inbox's own Realtime (already built) | `features/inbox/use-inbox-realtime.ts` | Live inserts and updates, resync after a drop | E2E `app/inbox.spec.ts` (Phoenix protocol emulated with `routeWebSocket`) | **mocked** | none | Not seen on a real Realtime server |
| RT-8 | D3 · Dev 2 | What the hosted database really publishes | n/a | `leads` and `bookings` listed (when intended) | none | **not started** | Run `select * from pg_publication_tables where pubname = 'supabase_realtime'` on staging · **Dev 2** | Migration files only are checked (`published-tables.test.ts`) |

### WhatsApp connection

| ID | Day · Owner | Requirement | Frontend component · API contract | Expected behaviour | Test · command | Status | Dependency · blocking owner | Evidence · next action |
|---|---|---|---|---|---|---|---|---|
| WA-1 | D2–D4 · Dev 3 (client), Dev 1 (route) | `X-Pakka-Tenant` on the WhatsApp calls | `lib/whatsapp/manual-connect.ts`, `lib/api/tenant.ts`, `components/onboarding/step-whatsapp.tsx`, `own-app-connect.tsx`. Backend: `requireTenant` in `backend/src/server/auth.ts` resolves the business from the header against the caller's memberships | `webhook-config` and `manual` both send the signed-in member's business and bearer token; neither is sent without one clear business | Unit `lib/whatsapp/manual-connect.test.ts`, `tenant-header.test.ts`, `lib/api/tenant.test.ts`; E2E `onboarding/onboarding.spec.ts` | **partial** | The real API accepting the header for a member and refusing a non-member needs a running API and database · **Dev 1 / Dev 2** | The header leaves the browser (checked with the real API client and in a real browser against stubs). The backend's side is unverified |
| WA-2 | D2–D4 · Dev 1 (backend), Dev 3 (screen) | Connection status versus webhook verification | `components/dashboard/whatsapp-connection-panel.tsx` shows `status`; `own-app-connect.tsx` shows `last_check.checks`. Backend `connect/manual.ts` saves `active` unless a check fails; `webhook_subscribed` stays `not_verified` | The dashboard does not say a number is plainly "Connected" when its webhook is unverified | E2E `app/whatsapp.spec.ts` (statuses), `onboarding/onboarding.spec.ts` (checks shown in onboarding) | **partial** | Wording decision · **Raja**; the subscription call and a real webhook check · **Dev 1** | Onboarding shows the check as "Waiting"; the dashboard panel does not show checks. Not changed in this work |
| WA-3 | D2–D4 · Dev 3 | Request failures: 401, 403, offline, no business | `lib/whatsapp/manual-connect.ts` | A safe message, retry only when retrying can help, secrets never in a message | `manual-connect.test.ts`, `tenant-header.test.ts`; E2E `onboarding.spec.ts` | **mocked** | none | Stubbed API |
| WA-4 | D4 · Dev 1 | Reconnection: recheck, disconnect, connect routes | `lib/whatsapp/connection-actions.ts` (services are `null`) | Buttons work | `app/whatsapp.spec.ts` (shown switched off) | **blocked** | The routes · **Dev 1** | None exist in `backend/src/server/routes.ts` |
| WA-5 | D2–D4 · Dev 3 | Several businesses, or none: no request | `lib/api/tenant.ts`, `manual-connect.ts` (`resolveWhatsAppTenant`) | No request; a message that says why and points to the dashboard's chooser | `lib/api/tenant.test.ts`, `manual-connect.test.ts` | **verified** (logic) | none | An account with a business never sees onboarding, so this guards a rare path |
| WA-6 | D2–D4 · Ops / Dev 2 | Deployment settings the connect flow needs | `lib/env.ts` (`NEXT_PUBLIC_API_URL`); backend `API_PUBLIC_URL`, `ENCRYPTION_KEY`, `META_*` | The flow starts | none | **not started** | Check the hosted Vercel and Railway settings (names only) · **Dev 2 / ops** | Not checkable from the repository |

### Other open contracts

| ID | Day · Owner | Requirement | Frontend component · API contract | Expected behaviour | Test · command | Status | Dependency · blocking owner | Evidence · next action |
|---|---|---|---|---|---|---|---|---|
| PG-1 | D3 · Dev 3 | Leads board beyond one page | `features/leads/data.ts` (`fetchLeadsPage`), `paging.ts`, `leads-board.tsx`. Plain PostgREST under RLS: order by `updated_at`, `id`; keyset `or` filter; `limit` | 200 at a time, **Load more**, nothing lost or repeated | Unit `paging.test.ts`; E2E `app/leads-paging.spec.ts` | **partial** | A real read with more than 200 leads against real PostgREST · staging | Logic verified; UI mocked; the `or` filter on a real `timestamptz` is unseen |
| PG-2 | D3 · Dev 2 with Dev 1 | Exact counts and filters over the whole business | none (filters run over loaded leads; counts say "200+") | Counts per temperature and stage over every lead | none | **blocked** | A SQL view or RPC under RLS · **Dev 2** | No contract exists |
| LC-1 | D4 · Dev 1 | Lead-card JSON | `features/inbox/lead-card-panel.tsx`, `lead-card-provisional.ts`. Only a **proposal** exists (`docs/dashboard-screen-contracts.md`, `LeadCard`); route marked PROPOSED | The AI-written rows appear beside the stored ones, for the right chat only | `features/inbox/lead-card-panel.test.ts` · `vitest run features/inbox` | **blocked** | The schema and route (or view) · **Dev 1** | Panel and adapter ready against a provisional sample; nothing supplies it in the app. Open questions are listed in `lead-card-provisional.ts` |
| TP-1 | D4 · Dev 2 (entitlement), Dev 1 (consumer) | Takeover preference | `memberships.takeover_pref` ('inbox', 'own_number', 'ask'; members update their own row: 0002, `docs/contracts.md`). `features/team/` | A member picks how they take over chats | none | **blocked** | A plan entitlement readable from the browser (the repo's own note: "no server-computed entitlement is readable from the browser yet") · **Dev 2**; nothing reads the value yet · **Dev 1** | Not built: with only "inbox" selectable it would store a value nothing uses |
| OW-1 | D4 · Dev 2, Dev 1 | Own-number option only on a plan that includes it | none | Shown only when eligible | none | **blocked** | `handoff_own_number` eligibility contract · **Dev 2**; own-number mode · **Dev 1** | Stays hidden. Plan names are not hardcoded in the UI |
| TM-1 | D4 · Dev 2 | Template picker outside the 24-hour window | `features/inbox/staff-reply.ts`. `notify.send` now accepts `template: { name, language, params }` for `staff_reply` (#87, `docs/contracts.md`), but the inbox route (`backend/src/conversations/staff-reply.ts`) still answers `not_available` to a `template`; the contract says its body "would be" `{ "template": { "name", "language", "params" } }` | Staff pick an approved template and send it | none | **blocked** | The route accepting that body, and approved templates readable by the picker · **Dev 2** | Re-checked against `origin/main` at `0bea8e2` after this work was written. The send layer is done; the route is the remaining step. A picker without a working route would mislead, so it is not built |
| SR-1 | D4 · Dev 1 | AI-suggested reply | none. `POST /api/conversations/:id/suggest` is named in the docs only | A button that fills the reply box | none | **blocked** | The route, request and response shape · **Dev 1** | No route, no types. Not built, and nothing here pretends to generate a reply |
| AL-1 | D4 · Dev 2 (link), Dev 3 (page) | A staff alert opens the right chat | `backend/src/notify/staff-alerts.ts` links to `/dashboard/inbox?conversation=<id>`; `app/(dashboard)/dashboard/(app)/inbox/page.tsx` reads only `?chat=<id>` | The tapped alert opens the conversation | none | **broken** | Agree one parameter name · **Dev 2 and Dev 3** | Found in the audit; not changed in this work. Next: accept both on the page once Dev 2 confirms |

### Files added or changed by this work (uncommitted)

New: `lib/api/tenant.ts`, `lib/realtime/{published-tables,table-changes,use-table-refresh}.ts`, `components/shared/refresh-control.tsx`, `features/leads/paging.ts`, `features/inbox/lead-card-provisional.ts`, `fixtures/inbox/provisional-lead-card.ts`, and their tests, plus `tests/e2e/app/{leads-paging,loading-and-refresh}.spec.ts`.
Changed: `lib/whatsapp/manual-connect.ts`, `components/onboarding/{step-whatsapp,own-app-connect}.tsx`, `features/leads/{data,leads-board}.tsx|ts`, `features/calendar/calendar-screen.tsx`, `features/inbox/lead-card-panel.tsx`, and test support `tests/e2e/support/{mock-supabase.mjs,day3.ts}`.

## Known flakes

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
