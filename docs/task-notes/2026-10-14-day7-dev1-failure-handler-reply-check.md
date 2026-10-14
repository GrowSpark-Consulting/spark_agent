# 14 Oct (Dev 1): the failure handler no longer follows a delivered reply with the safe line (Day 7). What changed, what it cannot know, and what touches Dev 2's area

Dev 1 files: `backend/src/agent/pipeline/reply.ts` (`answerAfterFailure`, a helper `replyReach`), `reply-record.ts` (new), `store.ts` (one new read), `runtime.ts` (one dependency), `give-up.ts` (the return type only), the fake store and the whole-turn harness, and tests. No migration. Nothing of Dev 2's or Dev 3's changed; `keyedMessageId` (Dev 2's exported function in `notify/send.ts`) is called, `notify.send` is not changed.

## 1. The problem (known limit 2 of the Day 6 reply-key note, section 3.2, pinned in the whole-turn tests)

The failure handler (`answerAfterFailure`, run when a run gave up its retries) read "still unanswered" from the audit rows only. A reply that was delivered but whose audit rows were lost (and whose step then failed on every attempt) was followed by the safe line: two messages.

## 2. The change

Before the safe line, the handler looks at two signals, in this order, over the unanswered messages (oldest first):
1. **The marker** `meta.agent.reply` that the reply step writes after a send that came back `sent` or `unknown_outcome` (`reply.ts` lines 523 and 534). It is written even when the send's record failed.
2. **The row notify.send recorded for the reply** (`reply-record.ts`): the reply goes out under the key `reply:<last message id>`, `notify.send` gives it the message id `keyedMessageId(business, "ai_reply", key)` (or, for a send that fell back to the template, the id of `<key>#template`), and the row is a message of the chat. One tenant- and chat-filtered read (`store.recordedMessageIds`).

A reply answers the turn's last message and every unanswered message before it, so the check finds the **newest** message the signals cover. Only if that is the newest unanswered message does the handler return `already_replied`: no safe line, and the messages are marked answered (best effort, so a later run does not collect them again). A message that arrived after the replied one is not covered: the safe line still goes out for it (an independent review found that a marker on an older message could otherwise mark a newer message answered with no reply; tested).

Kept as they were: opted-out, STOP and chat mode are decided first (a marker does not turn them into `already_replied`). **A check that cannot be read fails open**: the safe line goes out and one fixed line is logged (`[pipeline] could not check whether a reply already went out; sending the safe line`: no ids, no words), because a customer left in silence is worse than one extra line.

## 3. What the handler can and cannot know

| Situation | Known? | Result |
|---|---|---|
| The audit rows are there | yes | as before |
| The audit rows are lost, the marker is there | yes (signal 1) | no safe line, messages healed |
| The audit rows and the marker are lost, `notify_record` wrote the reply's row | yes (signal 2) | no safe line, messages healed |
| The audit rows, the marker and the recorded row are all missing (WhatsApp accepted the reply and nothing of ours recorded it: a crash before `notify_record`, or `notify_record` failing) | **no**; Meta cannot be asked | the safe line may follow a delivered reply |
| The records cannot be read | no | fail open: the safe line goes out |

The last remaining case is the `notify.send` gap (Day 6 note, section 3.1): the key was never recorded, so the reply step's own retries have already resent the reply before the handler runs; the handler adds at most one more line. It needs a crash or a `notify_record` failure, the marker write failing and the audit down, and then four failed attempts. It is pinned and labelled as KNOWN LIMIT 2b in `whole-turn-protections.test.ts`. Closing it needs a signal from `notify.send` itself (a pending record written before the provider call); that is Dev 2's file and is not part of this change.

## 4. Tests (written first and seen failing, then green)

`reply-record.test.ts` (new): pins the key derivation the check relies on (`reply:<id>`, and the exact ids `keyedMessageId` gives it and its `#template` key, so a change in Dev 2's derivation fails here, not silently in production). `reply.test.ts`: the marker, an `unknown_outcome` marker, a null marker, the recorded row, the marker looked at first, neither (the safe line, as before), no dependency, opted-out / STOP / chat mode first, fail open for both reads (with the log line carrying no id or word), healing that fails, a second call, and the "reach" cases: a marker on the newest message covers all; a marker on an older message or an earlier turn does not cover a newer one; the same for a recorded reply; nothing is marked answered when the safe line cannot be sent. `store.test.ts`: `recordedMessageIds`. `whole-turn-protections.test.ts`: the pinned limit 2 test is flipped (one message, `giveUp: "already_replied"`); a new case where the marker is lost too (every marker write fails) and the recorded row proves it; the fail-open case; KNOWN LIMIT 2b. Production code was broken temporarily to check that the tests fail (the reach rule, the recorded-row signal, the key derivation) and restored each time.

## 5. What touches Dev 2's area

Nothing is changed. Called: `keyedMessageId` (exported, pure). One fact for the record: the check depends on `notify.send` giving a keyed send the id `keyedMessageId(tenant, kind, key)`; `reply-record.test.ts` pins it.
