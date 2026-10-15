# 15 Oct (Dev 1): the failure handler reads notify.send's claim (notify_attempts), closing known limit 2b (Day 7)

Dev 1 files: `backend/src/agent/pipeline/store.ts` (one new read, `claimedMessageIds`), `reply-record.ts`, the fake store and the whole-turn world (test-support), and tests. No migration. Nothing of Dev 2's or Dev 3's edited. `notify_attempts` (0045) is read, never written.

## 1. The problem (limit 2b of 14 Oct, failure-handler-reply-check note, section 3)

A reply delivered with nothing of ours recording it (notify_record failed or never ran, the marker write failed, the audit down) and whose step then failed on every attempt was followed by the safe line: two messages. The retries no longer resend (0045 answers them "unknown"), but the handler could not see the claim.

## 2. The change

`createSentReplyRecorded` now reads two things for the reply's ids (`reply:<id>` and `reply:<id>#template`, as `keyedMessageId` gives them): the `messages` rows, as before, and the claims in `notify_attempts` with `status = 'sending'` for this tenant. Either one says the reply for that message may have gone out. The rule in `answerAfterFailure` is unchanged: the newest unanswered message must be covered, so a message that arrived after the replied one still gets the safe line. Either read failing throws and the handler fails open (the safe line goes out, one fixed log line).

| Situation | Result |
|---|---|
| The audit rows, the marker or the recorded row show it | `already_replied`, as before |
| Only the claim is left (`ok_unrecorded`, a crash after WhatsApp accepted) | `already_replied`, no safe line (new) |
| The claim was released (WhatsApp refused for certain, no credits) | not a signal: the safe line goes out |
| The claims cannot be read | fail open: the safe line goes out |

Price, the same one 0045 chose: a process that died after claiming and before WhatsApp got the message leaves the customer with no reply and no safe line (the handler cannot tell it from a delivered one). At most once, never twice.

## 3. Tests (written first, 10 failing, then green)

`store.test.ts` (`claimedMessageIds`: table, tenant filter, `status = 'sending'`, ids, empty, error, wrong shape). `reply-record.test.ts` (claim on the newest key, on the template key, claim plus row, a claim for another message, a read that fails, no messages). `whole-turn-protections.test.ts`: the pinned "KNOWN LIMIT 2b" test is flipped (one message, `giveUp: "already_replied"`); a crash after the provider accepted; a released claim still gets the safe line; unreadable claims fail open. The world's send fake exposes its claims (`claimedIds`) and calls `afterDelivered` for `crash_after_accept` too. Checked to be able to fail: claims left out of the union (5 red), `status = 'sending'` filter removed (1 red).

## 4. What touches Dev 2's area

- Nothing is changed. The check relies on `notify_attempts` keeping the columns `message_id`, `tenant_id`, `status` and the value `sending` (0045).
- **`backend/src/inngest/replay-coverage.test.ts` (Shaaz's) goes red.** Its `KNOWN_GAPS` entry points at the old test name ("but the handler, which cannot see the claim yet, adds one safe line"), and its comment says to remove the entry when the gap is closed. The fix is `const KNOWN_GAPS: Proof[] = [];` plus the comment. Removing the entry first is safe for main on its own, so his change can merge before this PR.
