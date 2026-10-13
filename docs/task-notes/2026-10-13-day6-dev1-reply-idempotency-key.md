# 13 Oct (Dev 1): an idempotency key on the AI reply

Dev 1 files: `backend/src/agent/pipeline/reply.ts` (about 20 lines) and its tests (`reply.test.ts`, `reply-booking.test.ts`, `reply-voice.test.ts`, `step8-audit.test.ts`). No file, table, function or route of Dev 2 or Dev 3 changed. No migration.

## 0. The refund_credits hazard this PR depended on is fixed (Dev 2, #163, migration 0034)

`notify.send` derives the message id from the idempotency key (`keyedMessageId`) and uses that id as the credit ref: it calls `spend_credits(..., ref)` before the send and `refund_credits(ref)` if the send fails. `spend_credits` writes new ledger rows on every call, but `refund_credits` (migration 0008) refunds a ref **only once**: a second refund for the same ref returns 0. Today the AI reply is sent without a key, so every attempt gets a random id and every failed attempt is refunded. With a stable key, every attempt of a turn spends under the same ref, so only the first failed attempt is refunded.

Reproduced on the local database (rolled back; the same ref on three attempts of spend, failed send, refund):

| Attempt | spent | refunded | balance |
|---|---|---|---|
| start | | | 10 |
| 1 | yes | 1 | 10 |
| 2 | yes | **0** | **9** |
| 3 | yes | **0** | **8** |

That was the behaviour before #163. So a reply whose send keeps failing in a way waiting can fix (the step is tried again, up to 3 retries) would leave up to 3 credits spent for a message that never went out; the buttons followed by the plain-text line (the same key) add at most one more. Every sender that already uses a key (booking reminders, follow-up nudges, the external-notice line, the demo replies, the staff alerts) has the same property.

**Dev 2 fixed it in #163 (migration 0034, `refund_credits` gives back the net unrefunded spend of the ref per bucket, so a retried keyed send gets every failed attempt's credits back). It is on main and merged into this branch.** Re-running the same reproduction on the local database with 0034 applied: balance 10, then 10, 10, 10 (every failed attempt refunded 1). Nothing in Dev 2's files is changed here. The credit behaviour is Dev 2's and is tested by his migration's tests; the tests in this PR prove the retry behaviour at the sender level only (a fake sender that dedupes on the key, as `notify.send` does).

## 1. What changes

1. The reply is sent with `idempotencyKey: reply:<id of the turn's last customer message>`. One reply per turn, and a turn is its newest customer message, so that message names it. `notify.send` returns the first send's outcome for a repeat of the key without sending again, so a run that died after WhatsApp accepted the reply and before its marker and answered rows were written, and is retried by Inngest, no longer sends a second message.
2. The exit question goes as two reply buttons, and if WhatsApp refuses them the same question is sent once as plain text. The two are forms of one reply and only one is ever recorded (a refused send is not), so **they share the key**: a replay that starts with the buttons again finds the text that went out and sends nothing. (A separate key for the text would not be found by the replay's buttons, which could send both.)
3. The safe line after a run gave up (`answerAfterFailure`) has **a key of its own**, `gave_up:<id of the message that started the run>`, so the failure handler running twice sends the line once. It does not share a reply's key: the run's reply is named by the newest answerable message it took, which the handler cannot tell (a photo may be newer, a message may have arrived after the run began, or more than ten may be waiting), and a shared name could return the safe line in place of a real answer.
4. Nothing else changed: the text, the order of the steps, the marker, the answered rows and the retry rules are as they were. The key is part of the payload to `notify.send`.

## 2. Tests

Written first and run against the old code (12 failed), then against the change; after the review the key design for the text line and the safe line was revised and the tests adjusted. New: the key names the last message and is a legal key (1 to 200 characters); a different turn has a different key; every attempt of a retry uses the same key; a replay of a run whose marker and answered rows were lost delivers once (a fake sender that dedupes on the key, like `notify.send`); the buttons refused and the text delivered, then a replay that lost its records, delivers once; the give-up line has its own key whatever else is waiting and is sent once if the handler runs twice. The audit's first gap (`step8-audit.test.ts`, was `it.fails`) is an ordinary test now. Existing tests that assert the exact payload gained the key.

## 3. What this does not close

1. A crash after WhatsApp accepted the message and before `notify.send` records it (inside `notify.send`): the key is not recorded yet, so a retry would send again. Meta offers no idempotency of its own. Related, in `notify.send`: if `notify_record` fails after a successful send, the failure is logged and the send is reported as sent, so a retry would send again under the same ref.
2. A run whose reply went out and whose record was lost, and which then gives up: the safe line is sent after the reply (its own key cannot know about the reply's). That is what happened before this PR, and it needs two failures in a row.

## 4. What touches Dev 2's area

Nothing is changed. `notify.send`'s existing `idempotencyKey` is used, as `external-notice.ts`, `lead-nudges.ts` and others do. The refund behaviour above was Dev 2's and is fixed in #163.
