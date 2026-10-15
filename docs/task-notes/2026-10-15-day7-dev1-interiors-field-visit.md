# 15 Oct (Dev 1): interiors books field visits, and only with someone who works in the customer's pincode (Day 7, PR E)

Closes known limit 1 of `2026-10-15-day7-dev1-interiors-salon-chats.md`. Dev 1 files only: `pipeline/understand.ts`, `pipeline/reply.ts`, `pipeline/plan.ts` (one type field), `scheduling/act.ts`, the chat runner (`conversation-tests/calendar.ts`, `schema.ts`, `run-chat.ts`), test-support, tests, chats and the chat README. No migration, no pack file. Nothing of Dev 2's or Dev 3's edited: Dev 2's `findSlots` is called with a field it already takes (`pincode`).

## 1. The defect

`understand.ts` chose the booking kind with `bookingModes.find(m => m === "slot" || m === "site_visit")`. `packs/interiors.json` books through `["field_visit"]`, so the kind was `null` and `plan-booking.ts` returned no plan: interiors never offered or booked a visit, even for a hot lead in a served pincode. The booking engine, `BOOKING_KINDS`, the migrations and the reminders already supported `field_visit`.

## 2. The change

- **The kind:** `understand.ts` accepts `slot`, `site_visit` and `field_visit` (the first of the pack's modes the agent can book; `callback`, `date_range` and `reservation` still offer no times). `BookingKind` in `act.ts` gains `field_visit`; the booking engine holds it as such.
- **The pincode:** Dev 2's `findSlots` takes an optional six-digit `pincode` and keeps only resources whose service area lists it (a resource with no area serves all). The agent never passed one, so a visit would have been offered with someone who does not work there. Now, for a field visit, the qualify step returns `visitAreaField` (the NAME of the lead's detail that holds where the customer is: the pack's own coverage rule, `scoring/coverage.ts` `coverageRule`, no field name in code). The reply step reads that detail from the lead (tenant-filtered `getLead`), turns it into six digits (`600 042` and `600-042` count; a place name or a short number does not), and `act` passes it to every `findSlots` look: the first offer, the re-offer after a time was taken, and the offer for moving a booking.
- **Never kept:** the pincode is looked up in the reply step each time and is not in a step result, the offer, the act result or the plan row (a test checks the message's agent meta). `visitAreaField` is a detail's name only.
- **Nothing for the pincode:** `findSlots` returns no times, so the existing `no_slots` path runs: the customer is told a person will follow up and the chat goes to a person (`stuck`, normal priority).

## 3. Tests (written first and seen failing: 9, then green)

`understand-qualify.test.ts` (the kind for slot, site visit, field visit, a pack with none of the three, the first usable mode, `visitAreaField` as a name only and absent without an area rule or for the other kinds); `act.test.ts` (the pincode on every look, absent when not given, kept on the re-offer after `slot_taken` and when moving); `reply-booking-visit.test.ts` (new: read from the lead as digits, not sent for a place name or short number or for a booking that is not at the customer's address, never kept on the message, no time for a pincode nobody works in, booked as `field_visit`); the chat calendar (`workPincodes`); chats `interiors/09` (flipped from the KNOWN LIMIT to offer and book) and `interiors/11` (a pincode the business serves in its catalog but its technician does not: no time, a person takes over).

## 4. What is left, unchanged

- **A customer who has not given a pincode** (it is an optional detail in the pack) gets times of any technician: `findSlots` filters only when asked. The pack could make it required, or the agent could ask for it before offering; that is a product decision.
- `hold_slot` does not check the pincode (Dev 2's SQL); the filter at `findSlots` is the only guard, which is enough because a customer can only pick a time that was offered.
- The scoring limits of the PR D note (salon cannot score above cold; `starts_within_days` and the salon matchers are not judged) are unchanged.
- Real models (`--live`) are not run.
