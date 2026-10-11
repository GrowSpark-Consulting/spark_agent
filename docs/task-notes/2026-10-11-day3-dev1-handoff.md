# Day 3 (Dev 1): the assistant qualifies and books. What was built, and what Dev 2 and Dev 3 should know

Audience: Dev 2 (Shaaz) and Dev 3 (Dhatri). The next person to touch the agent can read it too.

Nothing here changes a file, a table, a migration, an endpoint or an event of yours. Everything of Dev 1's is in `backend/src/agent/`
(plus tests, the conversation tests, one ESLint rule and this note). Dev 2's booking functions are only **called**, and Dev 3's tables are only **read**.
Sections 4 and 5 are the parts about Dev 3's and Dev 2's areas.

## 1. What it does, in plain words

A customer writes on WhatsApp. The assistant now:

1. **Asks the missing details casually**, two at a time at most, in the pack's order (budget, area, timeline for real estate).
2. **Scores the lead with plain code** (hot, warm, cold, or disqualified) from the pack's rules and the business's own catalog. The AI never decides the score.
3. **Offers three real free times in an ordinary sentence**, not a list or buttons (the product owner's call: it should read like a person). The times come from `findSlots`.
4. **Reads the customer's answer in words** ("the second one", "3pm", "Monday", "any is fine", "none of these") and books it: `holdSlot` then `confirmBooking`.
5. If someone took the time first, **says so and offers the others**. If nothing is free, or the business has no service to book, **a person takes over**.
6. A customer with a booking can **move it** (`rescheduleBooking`) or **cancel it** (`cancelBooking`). A cancellation is always asked about first and only a clear yes cancels.
7. **Every AI reply goes through `notify.send`**, so it costs the credit Dev 2's code charges. At zero credits the customer gets the one free holding message, the chat goes to a person and the owner is alerted. That path was already in place; a scripted chat now covers it.

## 2. What was merged today

| PR | What |
|---|---|
| #93 | Scoring engine (`agent/scoring/`): reads the pack's rules, hard fails and the merged overrides. |
| #94 | Qualifying: a "qualify" step scores the lead against the business's catalog, keeps `leads.score` and `leads.temperature`, and asks the next missing details. |
| #95 | Reading "tomorrow evening" in the business's own time zone, matching a reply to an offered time, and the offer's facts (`agent/scheduling/`). |
| #96 | The booking step: offers times and books the pick. New reply prompt `reply_v2` (natural sentences). |
| #97 | CI: `pnpm lint` fails if backend code branches on an industry (`vertical === "x"`, or a pack's key). |
| #98 | Move and cancel a booking. |
| #99 | 11 scripted booking chats (50 to 60), a small fake calendar for them, and `booking-timezone.test.ts` (exit test 5). |
| this PR | A setting to name the service the assistant books (`agent_settings.bookingServiceId`), and this note. |

## 3. How a booking turn runs (so the next person can read the code)

`process-message` (Inngest) runs: understand (extraction, save details, **qualify**, knowledge-base search) then reply (**plan**, then, only if booking is
involved, **act** and **plan-act**, then **reply**, then **handoff**). The booking decisions are a table at the top of `pipeline/plan-booking.ts`.

- `scheduling/act.ts` is the only code that calls the calendar, through a small port. `scheduling/port-db.ts` wires the port to **Dev 2's functions**.
- What waits for the customer's answer (an offer of times, "times for moving booking X", or "shall I cancel booking X?") is kept on the chat's own
  message, in `messages.meta.agent.offer` (and `meta.agent.act` for the turn's own result), like the count of knowledge-base misses. **No new table, no migration.**
  It is forgotten after a day. The step results Inngest keeps hold small facts only, never the customer's words.
- Switches: all of it runs only when the business has the **`booking`** and **`lead_qualification`** features (`isEnabled`), and only for a pack whose
  `bookingModes` include `slot` or `site_visit`. Otherwise a turn runs exactly as it did on Day 2.

## 4. For Dev 3: what Dev 1's work reads or writes in your area

1. **Catalog editor attribute names.** To score, the assistant reads each active `catalog_items` row: `price_from` (the lowest price, a column) and, inside
   `attributes`, **`price_to`** (the highest price) and **`area`** (or `areas`, a list). If the editor saves other names, the budget and area rules earn nothing
   and a budget far below the cheapest home never disqualifies. The names are one constant in `agent/scoring/references.ts` (`CATALOG_ATTRIBUTES`); whichever side changes them, the other has to match.
2. **Which service the assistant books.** The assistant books on its own only when the business has **exactly one active service**, or one it was told to use.
   The seeded demo real-estate business has two ("Site visit" and "Video walkthrough"), so on staging it would hand every booking to a person.
   The setting is `tenants.agent_settings.bookingServiceId` (the id of an active service). There is no field for it on the Agent settings screen today, so until there is one it is set by hand (see section 7).
3. **The leads board and lead detail** read `leads.score` and `leads.temperature`. The assistant now writes both (only while the lead is open: new, engaged, qualified or nurture).
   `temperature` can be `hot`, `warm`, `cold` or `disqualified` (the column already allowed it). The assistant does **not** change `leads.stage`; the only stage change
   is `booked`, which Dev 2's `confirm_booking` makes.
4. **The calendar** shows bookings the assistant made like any other: kind `site_visit` (or `slot`), with the resource the engine picked. They look like any other booking.
5. **The lint rule is backend-only.** Your exported prototype screens compare industries (for example `K==='hotel'` in `features/settings/pakka-settings.tsx`). The rule is not
   applied to `frontend/` for that reason. The rule can be extended to `frontend/` once those screens stop comparing industries.

## 5. For Dev 2: what Dev 1's work calls and assumes

The functions used, exactly as called (all through `scheduling/port-db.ts`, all with the default dependencies):

| Function | How it is used | What the assistant assumes |
|---|---|---|
| `findSlots(tenant, { serviceId, from, to })` | up to 3 times, in the window the customer asked for, then wider | returns free times with a label in the business's time zone (`slotLabel`) |
| `holdSlot(tenant, { start, end, resourceId, serviceId }, leadId, { kind })` | kind is `site_visit` or `slot`, from the pack | a lead holds one time at a time; a taken time is `slot_taken` (`AppError`) |
| `confirmBooking(tenant, bookingId)` | right after the hold, in the same step | moves the lead to `booked`, emits `booking.confirmed` |
| `rescheduleBooking(tenant, bookingId, { start, end, resourceId })` | only for a **confirmed** booking | a taken time is `slot_taken` |
| `cancelBooking(tenant, bookingId, reason)` | only after the customer said yes | safe to repeat; the reason is "Cancelled by the customer in the chat" |

Also read (read only): `services` (active ones, ids), `tenants.timezone`, and `bookings` (the lead's next held or confirmed booking that has not ended).

Where it meets your area:

1. **No second confirmation message.** The assistant sends the booking confirmation itself, as the reply to the customer's pick (one `ai_reply`, one credit).
   Today `booking.confirmed` only drives the reminders, the calendar sync and the post-visit job, so nothing doubles up. If a "booking confirmed" template is
   planned on that event (`booking_confirmed_v1` is in the pack's template list), the customer would get two. Which of the two stays is Dev 2's call.
2. **One credit entry per reply (exit test 4).** The assistant sends exactly one `ai_reply` per answered turn (the scripted chats assert it for every turn). That each of those
   creates exactly **one** `credit_ledger` row is `notify.send` and `spend_credits`, which are yours. Dev 1 has not looked at the ledger on staging.
3. **Two people, one slot (exit test 3).** The assistant relies on the database refusing the second hold (`slot_taken`). The concurrency test is yours
   (`scripts/db/hold-slot-concurrency.sh`); the chats only cover how the assistant behaves when the engine says "taken".
4. **A rescheduled booking gets a new id.** `rescheduleBooking` confirms a new booking and marks the old one `rescheduled`; the assistant reads the lead's current booking from
   `bookings` each time, so it follows. Your reminder jobs already handle this (a new `booking.confirmed`).
5. **Not supported yet:** field visits (they need a pincode for `findSlots`), and `callback`, `date_range` and `reservation` bookings. A pack whose booking modes do not include
   `slot` or `site_visit` simply never offers times.

## 6. Decisions made along the way (change any of them if wrong)

- **Times are offered as plain sentences, never a list or buttons.** `sendInteractive` (the list and button sender) is built and tested but not used for times.
  The Day 3 exit test wording "as a WhatsApp list" and "taps a slot" no longer matches: the tester now answers in words.
- **When is a time offered on its own?** When every required detail is in and the score is warm or better (at or above the pack's warm threshold), and no question is waiting.
  A customer who asks to book gets times whatever the score.
- **A cancellation is never done on a first message.** The assistant asks "shall I cancel it?", and only a clear yes cancels. A reading the model is less than 0.8 sure of is not even asked about.
- **A time that is only held (10 minutes, not confirmed) cannot be moved or cancelled by chat.**
- **A lead that does not fit** (a budget below the cheapest price, judged only when the code is certain) is told kindly once, with no times offered. It can still move or cancel a booking it already has.
- **Scoring overrides** (a business's own weights and thresholds) apply only with the `custom_scoring` feature. Hard fails and required questions can never be overridden.
- **A named service or exactly one service**; otherwise a person takes over (`stuck` handoff). The assistant never guesses.
- **Held offers expire after a day.**

## 7. Staging checklist for the exit test

Before the tester chats, the business used must have:

- the features `booking` and `lead_qualification` on (the trial plan has both);
- an **active resource** with working hours (the seed has these) and **one active service**, or a named one:

  ```sql
  update tenants
     set agent_settings = coalesce(agent_settings, '{}'::jsonb) || '{"bookingServiceId": "d6000000-0000-0000-0000-000000000011"}'
   where id = 'd0000000-0000-0000-0000-000000000001';   -- the seeded real-estate business, service "Site visit"
  ```
- **catalog items** with `price_from` and, in `attributes`, `price_to` and `area`. The seed has **none**, so on a fresh staging the budget and area rules earn nothing: the best
  possible score is warm (not hot), and no budget disqualifies. Add two or three items before judging the score.

Then the exit test: chat about a 2BHK in an area from the catalog, give a budget and a timeline in normal sentences, receive three times in one message, answer in words, and
check the booking in the calendar and the lead at `booked`.

## 8. Known gaps and what is not verified

- **Real models were not used.** All of this was tested with scripted models and fakes (3,200+ backend tests, 11 booking chats). `pnpm test:conversations -- --live --only booking`
  runs the same chats with the real models (only `expect` is checked) and is worth doing once on staging with a key.
- **Not run on staging or against the real database from the agent's code path.** The booking SQL is Dev 2's and unchanged.
- **Labels are English** ("Sun 11 Oct, 10:00 am"); the model writes the reply in the customer's language around them. The English and Tamil wording for the confirmation,
  reminders, feedback and staff alert is the templates' job (Dev 2's catalogue), not this step's.
- **The `hot_lead` trigger** was not wired on Day 3. On Day 4 it became an event (`lead.hot`), not a handoff row; see the Day 4 note.
- **Several services without a named one**, field visits, callbacks and multi-day bookings are the next steps (Day 4).
- The reply says what the facts say. If a business's catalog or services are wrong, the assistant is exactly as wrong.

## 9. Tests and how to run them

```
pnpm typecheck && pnpm lint && pnpm test          # everything (CI runs this)
pnpm test:conversations                            # the scripted chats, mock models
pnpm test:conversations -- --only booking          # just the booking chats (50 to 60)
pnpm test:conversations -- --live --only booking   # the same with the real models (needs ANTHROPIC_API_KEY; never in CI)
```

Where things are: decisions `agent/pipeline/plan-booking.ts`; calendar calls `agent/scheduling/act.ts` and `port-db.ts`; reading the customer's time and pick
`agent/scheduling/preferred-time.ts` and `slot-choice.ts`; scoring `agent/scoring/`; chats `tests/conversations/real-estate/50-` to `60-`, described in `tests/conversations/README.md`.
