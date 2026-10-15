# 15 Oct (Dev 1): interiors and salon, ten scripted chats each, the loader tests, and the known limits the chats found (Day 7, PR D)

Dev 1 files only: `tests/conversations/salon/` (10 new chats), `tests/conversations/interiors/` (2 new chats, 09 and 10), `backend/src/agent/packs/interiors-salon-loading.test.ts` (new, 15 tests). No production code, no pack file, no migration changed. Nothing of Dev 2's or Dev 3's edited.

## 1. What existed

Both packs (`packs/interiors.json`, `packs/salon.json`, version 1), the generic loader (`load.ts`, `overrides.ts`, `sync.ts`, `store.ts`, `field-schema.ts`), 14 pack-file tests each, the demo businesses and routes. Chats: interiors 01-08 (pincode and injection); salon none.

## 2. What was added

- **Salon, ten chats:** 01 price question (English), 02 price question (Tanglish), 03 details kept (an answer to a question the pack does not ask is dropped) and the next detail asked, 04 times offered and booked, 05 a time taken first, 06 cancel asked first, 07 complaint to a person, 08 STOP, 09 KNOWN LIMIT (unknown service, section 3.3), 10 owner-discount injection.
- **Interiors, two chats (now ten):** 09 KNOWN LIMIT (a hot lead is never offered a visit, section 3.1), 10 a price question answered from the knowledge base, and a price the text does not hold is not made up.
- **Loader tests per pack (interiors, salon):** loads by key and version 1 with no warnings and builds the lead schema; refuses another version and a path-like key; the sync stores it once as an active row and a second sync changes nothing, and the stored definition resolves without warnings; the sync's file reader finds it; a broken copy is a `PackError`. One test for both: no non-test source under `backend/src/agent` names either pack (industry specifics live in pack data only).

## 3. Known limits the chats found (pinned as they behave today, nothing changed; each chat and test says KNOWN LIMIT)

1. **DEFECT, `pipeline/understand.ts:317`: `field_visit` is not recognised, so interiors never offers or books a visit.** The line picks the booking kind with `bookingModes.find(m => m === "slot" || m === "site_visit")`. `packs/interiors.json` declares `["field_visit"]`, so the kind is `null`, and `plan-booking.ts:104` returns no plan. A hot interiors lead (75) in a served pincode, or one who asks to book, gets an ordinary reply and no time. The booking engine, `BOOKING_KINDS`, the migrations and the reminders all support `field_visit`. Pinned by `interiors/09-known-limit-visit-never-offered.yaml`. Fix: its own PR (plan below).
2. **Salon scoring cannot judge four of its five rules.** `scoring/score.ts` `judge()` reads only `within_<x>_band` and `in_<x>_area(s)`. Salon's `in_service_catalog` (40), `is_available_stylist` (10), `within_working_hours` (10) and `starts_within_days` (30) are unknown matchers: they earn nothing and are reported as unscored. The best possible salon lead scores 10 (party size) and is cold (warm is 30), so **salon leads cannot score above cold**. Because of that, a salon customer is offered times only when they ask to book (intent `book`), never on their own, as real estate and interiors are once warm. Pinned by `salon/04` (turn 1) and `interiors-salon-loading.test.ts`.
3. **The salon hard fail never fires.** `{ services, none_in_service_catalog }` is an unknown matcher, so a request for a service the salon does not offer stays cold with score 0 and is not disqualified, and the assistant carries on. Pinned by `salon/09-known-limit-unknown-service-is-not-disqualified.yaml` and the scoring test.
4. **`starts_within_days` is not judged in either pack.** Interiors loses 25 of 100 (best possible 75, still hot at 70); salon loses 30. Pinned by the scoring test.

When `judge()` learns these matchers (it also needs the business's services, stylists and working hours as references, which are Dev 2's and Dev 3's data), the pinned tests will fail on purpose and are to be changed to the disqualified and warm outcomes.

## 4. Not covered

Real models (`--live`, never in CI): the mock chats check the code around the models, not whether the real model reads salon or interiors messages well. Tamil and Tanglish tuning for these two packs is only the salon 02 chat. The reminders and the reminder templates for these packs are checked as data (`salon.test.ts`, `interiors.test.ts`), not run.
