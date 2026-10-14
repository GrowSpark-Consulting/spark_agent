# 14 Oct (Dev 1): a cancel or move from a customer with no booking tells the staff, and the reply says only what is true (Day 7, Finding 3 of the injection sweep)

Dev 1 files only (`backend/src/agent/`, `backend/src/conversation-tests/`, `backend/src/test-support/fake-pipeline-store.ts`, chats, docs). No migration. Nothing of Dev 2's or Dev 3's is changed: `notify.send`, `staffAlertRecipients` and `writeAudit` are only called. No prompt file changed.

## 1. The defect (live run, chat 101, 14 Oct)

A customer with no booking on record asked to cancel one. `plan-booking.ts` returned nothing for a cancel or a move without a booking and `plan.ts` has no row for it, so the turn was read as "details to ask for" and the model said it would check with the team. No handover, alert or gap existed behind it: nobody was told.

## 2. What happens now

- **Trigger** (`plan-booking.ts`, case `no_booking_to_change`): the lead has NO active booking (`activeBooking` is null) and the customer asks to cancel (confidence at least 0.8, the existing threshold) or to move one (any confidence, as the move row always was). A time that is only held counts as a booking (`hasBooking`), so it is not this case.
- **Staff alert** (`agent/handoff/booking-change-reminder.ts`): one `staff_alert` through `notify.send` to each owner and admin (`sendToAdmins`, the way the area reminder and the connection alerts go), free, behind the `staff_alerts` switch, our own text: "{cleaned name} asked to cancel / move a booking, but none is on record for them in this chat. It may have been made by phone or by your team. Please check." plus the link to the chat. The name goes through the strict cleaner (`scoring/area-text.ts`): a profile name with a link, a phone number or an `@` shows as "A customer", and a contact with no usable name shows the masked number. Nothing the customer typed is in the message, and none of it is passed to the reminder (ids and the kind only).
- **No handover, no mode change.** The assistant stays in charge, the lead stays open, and no hot-lead alert comes of it. "Cancel that, I'll think" read as a confident cancel gets one low-priority note and a reply that asks what they meant.
- **The reminder runs BEFORE the reply** (a new step `booking-reminder` in `reply.ts`, only when the plan flags it), so the reply can say "the team has been told" only when that is true:
  - the result (`sent` or `failed`) is kept on the message (`meta.agent.bookingReminder`) and read back when the reply is written;
  - sent: the reply is told "no booking is on record in this chat; the team has been told and will check; if they meant something else, ask what they meant";
  - failed (a refusal, the switch off, nobody to tell, an error, a timeout): the reply is told "nobody has been told; do not promise that anyone will follow up; say you cannot see a booking under this chat and that, if it was made with the team, they should contact the team directly". No promise is made.
- **Time limit**: `BOOKING_REMINDER_TIMEOUT_MS` = 3000. A timeout counts as failed and the turn carries on; the step never throws for a send problem and never blocks the reply. If the send later completes after the timeout, the notify key keeps it from going twice and the next message finds it.
- **Credits**: the alert is free; the reply is one reply, one credit, as for any reply.

## 3. One reminder per lead, and a retry after a failure (checked against Dev 2's `notify.send` and migration 0045, read only; no change needed on their side)

The send's key is `no_booking_change:{leadId}:{memberId}`. `notify.send` claims a keyed message before WhatsApp is asked and:
- **a send WhatsApp refuses for certain releases its claim**, so a later message can try again; a switch that is off or no recipient returns before any claim, so a later message can try again;
- **a send that went out is recorded**, so any later attempt is answered "sent" and nothing is sent twice;
- **an unknown outcome (WhatsApp never answered) keeps its claim**, so nothing is ever resent; it counts as not sent, so the customer is not told anyone knows;
- **a send whose record was lost** keeps its claim too (in doubt): never twice.
After a success the reply step writes an audit row (`lead.booking_change_reminder`, new constant in `events.ts`, read back by the new `store.hasBookingChangeReminder`), so a LATER message neither sends again nor loses the fact that the team was told (without it, `notify.send` would answer the repeat "in doubt" and the reply would stop saying so). A lost audit row only means a later message asks again, and the key stops a second send.

Proved by `booking-change-reminder-notify.test.ts`, which runs the REAL `notify.send` with an in-memory stand-in for `claim_notify_attempt`, `release_notify_attempt`, `notify_record` and the messages table, written from the migration's SQL: a refused send then a retry that sends then any number of later messages that send nothing; three refusals then a send; a switch off or nobody to tell then a send; a success then five repeats; an unknown outcome never resent; a lost record never resent; two members with one refused; another lead is its own. What it does not prove is the SQL itself (Dev 2's `supabase/tests`).

## 4. Limits

- **Booking switched off, or no usable service, is not covered**: there is no scheduling input, `planBooking` returns nothing and the turn is read as before.
- **Outside the 24-hour window a staff alert needs the approved template `staff_alert_v1`, which is not approved on staging yet**: there the send fails, the reminder counts as failed, the reply says nobody has been told, and a later message tries again. Nothing breaks.
- A cancel read below 0.8 gets the ordinary reply and no note. A lead with a held-only time is not this case.
- One note per lead (the first success); a later change of mind sends none.
- A send that completes after the 3-second limit is not counted as sent for that reply (the reply says nobody was told, which understates); the next message finds it. The same happens when one owner or admin was told and a slower one made the whole reminder miss the limit (members are sent one after another): the reply says nobody was told, no audit row is written, and the next message finds the earlier send. It never over-claims.
- A question the knowledge base can answer is answered first ("cancel my visit, and what is the 2BHK price?" gets the price; the note to the staff waits for the next message), as in the cancel and offer rows. A question the knowledge base cannot answer does not stop the note.
- If a person has taken the chat, or the customer has opted out, by the time the step runs, nobody is alerted (no reply would go out).
- The reminder's call is started inside a promise and its timer only afterwards, so a dependency that throws at once leaves no timer behind.

## 5. Files

New: `agent/handoff/booking-change-reminder.ts`. Edited: `agent/pipeline/plan-booking.ts` (the row), `plan.ts` (`Plan.bookingChangeReminder`, `PlanInput.bookingReminderSent`), `reply.ts` (the step, `ReplyDeps.bookingChangeReminder` and `bookingReminderTimeoutMs`, `ReplyOutcome.bookingReminder`), `runtime.ts` (the real reminder), `events.ts`, `store.ts` (`hasBookingChangeReminder`), `handoff/area-reminder.ts` (`customerLabel` exported, nothing else), `test-support/fake-pipeline-store.ts`, `conversation-tests/run-chat.ts` and `schema.ts` (an expectation `bookingChangeReminder` and a mock `bookingReminder: fails`), `tests/conversations/README.md`.

## 6. Tests (written first; seen failing: the plan tests and three missing modules, then the three review fixes' tests before their code)

- `plan-no-booking.test.ts` (23): the cancel threshold (0.8 counts, 0.79 does not), a move at any confidence, "cancel that, I'll think" keeps the AI on, the fact when the reminder went out and when it did not (no promise of a follow-up), the kind named, no amount, date, time or customer word in the facts, the language, a confirmed booking unchanged, a held-only time, no scheduling input, other intents, a person asked for, a complaint, a discount and an opt-out keep their rows, a lead that is not a fit.
- `booking-change-reminder.test.ts` (12): the text, the cleaned name (links, numbers, `@`, tags, braces, blank), the key, sending, and every failure counted and never thrown.
- `booking-change-reminder-notify.test.ts` (8): section 3.
- `reply-no-booking.test.ts` (16): the reminder runs before the model and the send, the reply says the team has been told only when it was, one reply, no handover, mode ai, the audit row; failed, nobody to tell and throws all say nobody was told; a reminder that never answers is cut off at the limit (a timeout counts as failed) and the reply goes out; the default limit is 3 seconds; no reminder wired; below the threshold and other intents send none; no customer word reaches the reminder; a failure is tried again by the next message and then goes out; a timeout is tried again; after a success a later message sends nothing and the reply still says the team has been told; a replayed step sends once; a dependency that throws at once leaves no timer; a chat taken by a person or an opted-out customer alerts nobody.
- Chats 101 (updated: a reminder, mode ai, no handover), 109 (a move), 110 ("cancel that, I'll think": one note, then none, then a price question answered), 111 (a failed reminder, tried again, then none). The chat runner has the expectation and mock above, with three tests in `run-chat.test.ts`. The chats fail when the plan row is switched off (checked).
