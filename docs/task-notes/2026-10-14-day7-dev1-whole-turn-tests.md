# 14 Oct (Dev 1): the whole-turn "one reply" tests (Day 7, PR A). What was built, what it proves, and what it does not

Dev 1 files, all new and all tests: `backend/src/test-support/whole-turn-world.ts` (the harness), `backend/src/agent/pipeline/whole-turn.test.ts` (clean turn, drift guard), `whole-turn-matrix.test.ts` (the failure matrix), `whole-turn-protections.test.ts` (the checks the first matrix did not reach). **No production file changed.** No migration. Nothing of Dev 2's or Dev 3's touched; Dev 2's `notify.send` is not called (see section 2).

## 1. What runs

A customer message goes in through the real inbound webhook handler (`handleWhatsAppWebhook`, signed fixture-shaped payloads, a fake `storeInboundMessage` that is idempotent on the provider's message id), becomes a `whatsapp/message.received` event (a fake queue that drops a repeated event id, as Inngest does, or delivers both when a test says so), and runs through `runTurn`, the STOP check, `understandTurn` together with `markReadStep`, and `replyTurn`, on an emulator that behaves like Inngest: a failing step makes the function body replay, finished steps return their JSON result, 3 retries per step (4 attempts), a step still running is awaited by a replay, and a run that gives up calls `answerAfterFailure`. The model is scripted, the store is `fakePipelineStore`, notify.send is `FakeNotify`.

## 2. FakeNotify is a fake

It is not `notify/send.ts`. It copies only what the pipeline relies on: a recorded send under an idempotency key returns the first outcome and sends nothing; credits are spent by reference before the send and refunded by reference when it fails (as #163 made them); an unknown outcome refunds and is never resent (contracts decision 16); an opted-out contact is refused. Delivery by the provider and the row `notify_record` writes are counted separately. Where it is more forgiving than the real one (listed at the top of the harness, from the review): a `notify_record` failure (modelled by the script `ok_unrecorded`), an error reading the earlier send of a key, the template fallback key `<key>#template` and its cost, the 24-hour window and the feature check, spend and refund that can throw, unexpected sender errors, credits locked in a transaction, tenant scoping of the dedupe. "Balance never negative" is enforced by the fake itself; what the tests show is that credits spent minus refunded is 0 or 1 for a turn.

## 3. The invariant, per turn (a batch of messages answered together)

1. At most one AI reply reaches the customer per turn, and exactly one unless a test says why not. 2. At most one reply row recorded. 3. Credits spent minus refunded: 1 when a reply was recorded, otherwise 0 (an unknown outcome refunds, so a delivered message can be uncharged: decision 16). 4. Every inbound message answered, or left for staff. 5. Two separate turns give one reply each.

## 4. What is covered (110 tests, stable over repeated runs)

1. **Model timeout** (extraction, reply, both, with the event and webhook replayed): one safe line. **Bad JSON twice** (garbage, wrong shape, a good answer second, the reply failing the post-check twice, an unknown field key): one clarifying question or safe line.
2. **Retryable send error**: 1, 2 or 3 failures then success: one delivery, one credit, the step retried. All 4 attempts fail: the run gives up and the failure handler sends the safe line once. A send that failed for good: not retried. **Unknown outcome**, delivered or not: never resent, even with the event and webhook replayed.
3. **A step fails once, before and after it runs, at every step of the path**, for the clean turn (13 steps, read from a clean run and pinned exactly), STOP, STOP in a chat a person has, a voice note, out of credits, a chat a person has, and a model timeout. A reply step that dies after a recorded send (before the marker and rows): the retry sends under the same key and gets the first send.
4. **Replayed event** (a second run, a queue that delivers twice) and **replayed webhook** (Inngest drops it; Inngest delivers both; Meta retries long after): one stored message, one reply.
5. **Combinations**, **a burst of three** (one reply; also with three runs and with interleaved turns), **two separate turns** (one each, different keys).
6. **Endings**: opted-out contact, chat taken over, STOP (one confirmation however often replayed), STOP then a new message, out of credits (no AI reply, one holding line, one handover, balance 0, also with the sending step replayed), voice note (one line, one staff event id, a second voice note not answered), assistant switched off (also STOP then).
7. **The failure handler keeps every check of the run**: a STOP turn, a chat a person has, an opted-out contact (the attempt, not the fake's refusal, is what is counted).
8. **The checks right before the send** (STOP, a takeover, another run answering, all while the reply model is thinking): nothing is sent, the fake is never asked.
9. **The drift guard**: `inngest/process-message.ts` is read as text; the test fails if the order of `started`, `runTurn`, `stopCheckAfterGate`, `stopCheck`, `understandTurn`, `markReadStep`, `replyTurn` changes, if a step other than `started` and `external-notice` appears, if the `Promise.all`, the gated-off condition, the retries, the failure handler or the concurrency key change.

## 5. Checked that the tests can fail

Production code was broken temporarily and restored each time: the reply sent without its idempotency key (2 tests fail); no marker and no answered rows (1 fails; with the key also removed, dozens fail); no re-read of mode and opt-out before the send (2 fail); the failure handler without its STOP, mode and opt-out checks (4 fail); a change in `process-message.ts` (the drift guard fails).

## 6. Pinned outcomes and the two known gaps (nothing was fixed)

1. **PINNED, existing behaviour**: when even the safe line cannot be sent, the customer hears nothing, nothing is charged, and the message stays unanswered until the customer writes again (a later message collects it). A send that failed for good opens no handover and leaves the message unanswered. An unknown outcome that did not reach the customer is not resent: the customer hears nothing and the message counts as answered.
2. **KNOWN GAP 1** (Day 6 reply-key note, section 3.1; inside `notify.send`): a crash after WhatsApp accepted the reply and before `notify.send` records the key sends the reply twice (2 deliveries, 2 credits). The test passes while the gap exists; its comment says to change 2 to 1 when it is closed.
3. **KNOWN LIMIT 2** (the same note, section 3.2; found again by the review's item 7): the reply went out, its audit rows and marker were lost, and the step then fails on every attempt. The failure handler cannot tell the reply went out, finds the message unanswered and sends the safe line under its own key: **two messages**. It needs two failures in a row (the audit unavailable and the step failing on all four attempts). Pinned the same way; fixing it is a change in `reply.ts` or `give-up.ts` and is not part of this PR.

## 7. Out of scope here (the review's list)

The `external-notice` step for a chat handled from the staff member's own number (it needs the database; it has its own tests), booking and the `act` steps, `runtime.ts`'s real dependencies (the real LLM client with its backoff and timeouts, the real audit, `areaReminder`, scheduling), the real `isEnabled` and its cache, the real SQL (`recordOptOut`, `findOrCreateOpenLead`, `store_inbound_message`), the real read receipt (always "late" in the harness), real Inngest debounce and concurrency timing, a message arriving mid-run, and the 25-second hard stop. The emulator rethrows an error thrown outside any step as a test failure (Inngest would retry it, then run the failure handler).

## 8. What touches Dev 2's and Dev 3's areas

Nothing is changed or called. For Dev 2, two statements about their `notify.send`, for the record: the known gap in section 6.2 is inside it, and a real `notify.send` against the local database (true row counts, the real refund) is not covered by this PR; the staging replay and forced-timeout runs of the exit test still need Dev 2's failure-injection hooks.
