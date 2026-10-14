# 14 Oct (Dev 1): one reply for a flood of messages, and a cleaned area in the staff reminder and the customer echo (Day 7, fix PR for PR C findings 1 and 2)

Dev 1 files only (`backend/src/agent/`, tests, chats, docs). No migration. Nothing of Dev 2's or Dev 3's touched; `notify.send` is not changed. The PR C branch (`test/prompt-injection-sweep`) holds the tests this PR flips; this branch is built on it.

## 1. Finding 1 (P0): more than ten messages from one customer could get more than one reply

- **Cause** (`agent/pipeline/process-message.ts`, the `batch` step): the run read the newest ten customer messages in the 15-second window (`store.ts` `BATCH_LIMIT`) and then added the event's own message back when it was "not among the newest ten, and not answered". A message that is not among the newest ten has more than ten newer ones, so it is never the newest; an event for it that ran after the turn answered the newest ten (a replayed or late event, a delivery the debounce did not collapse) sent a second reply. 20 stored messages with every event delivered gave 10 replies and 10 credits; 12 gave 2.
- **Fix**: the three lines that added it back are removed (a comment says why). A run whose batch is empty already returns `skipped / already_answered`.
- **Credits**: one reply and one credit per flood, as for any turn. `notify.send` and the credit functions are untouched.
- **What it costs**: a message older than the newest ten is left unanswered by its own event. This is the behaviour the code already had for the debounced case ("the latest are the ones to answer", `store.ts`); the older ones stay unanswered until the customer writes again.
- **Two narrow limits the independent review found** (both pinned in the code's comments, neither fixed): (1) the newest ten count every kind of message, so an older TEXT followed by more than ten newer photos or voice notes is not answered (the newest turn is all non-text and gets no reply, which is the existing rule for photos); before this fix its own event would have answered it. (2) `recentUnanswered` orders by `created_at` only, so more than ten messages with the same millisecond could drop the event's own message; another event covers the other ten, so there is still one reply.
- **Tests**: the pinned whole-turn test is flipped (20, 12, 11 and 10 messages with every event delivered give 1 reply, 1 row, 1 credit, and the newest ten answered); the unit test that said the event's own message is in the batch even when the newest ten do not include it now says it is not added back and the run is skipped.

## 2. Finding 2: a typed link or phone number reached the staff reminder and the customer echo

- **Cause**: the place the customer typed was cut to 40 characters (`coverage.ts`) and shown as typed, in the staff WhatsApp alert and in the fixed area lines.
- **Fix**: one strict cleaner, `agent/scoring/area-text.ts` `cleanAreaText`. Invisible characters (zero-width spaces and joiners, soft hyphens, direction marks) are removed first. Then it refuses: any character outside letters, marks, digits, spaces and `. , ' ’ - / ( ) & # +` (so a bracketed dot, a percent-encoding, an ideographic full stop, an emoji, braces and `$` are not shown); an `@`; a link (a scheme, `www.`, or a name with one of about 90 top-level domains); and a phone number (7 or more digits of any script with at most two other marks between neighbouring digits, so spaces, dots, dashes, commas and slashes do not hide one, and a six-digit pincode, `641 001` or `600-042` included, passes). What passes is on one line, cut to 40 characters, and looked at again after the cut. It is a defence in depth for a few words, not a link scanner: spelled-out forms ("evil dot com") and a space before the dot are not caught. A pincode followed by a house number (`600020, 12`) has 8 digits and is not shown (fixed words instead). The independent review's bypasses (zero-width and joiner characters, commas and slashes, uncommon domains, a full stop in another script, bracketed dots, percent-encoding) are each a test. Text that fails is not shown.
  - Where it is used: `coverage.ts` (the reading's `shown`), `fixed-texts.ts` `areaText` (so a place kept on an earlier turn, before the cleaner, is cleaned too), and `area-reminder.ts` `areaReminderMessage` (the area and the customer's profile name).
  - Staff reminder, text not shown: "an area outside your list". A profile name that fails shows "A customer".
  - Customer echo, text not shown: fixed words in the customer's language, "the area you mentioned" (English), "neenga sonna area" (Tanglish), and machine drafts in Tamil and Hindi that need a native speaker's check (`needsNativeCheck`).
  - `customerLabel` shows the masked number when a profile name fails the cleaner.
- **Not changed**: the pinned limit that a short area written like an order (`price 10 lakh approved`) is still echoed back to the customer who typed it (chat 88): it passes the cleaner, only they see it, and the line still says the business has no site there.
- **Tests**: `scoring/area-text.test.ts` (links, e-mail, an `@`, ten-digit and spaced, dashed, dotted, Tamil, Devanagari and full-width phone numbers, long text, control characters, real places and pincodes), `handoff/area-reminder-injection.test.ts` (flipped from the known-gap pins: the reminder text, the profile name, `areaText` in four languages), chats 87 (now the fixed words), 102 (Tanglish, a phone number in the area, then the second ask with one staff reminder) and 103 (a clean area with a pincode is still named).

## 3. Chats 100 and 101

Changed to assert what matters instead of the typed name: no phone number or other booking id in the reply, the calendar and the lead's own booking unchanged, no invented price, one reply. The model repeating a name the customer typed is not a leak (live run, PR C note section 5).

## 4. Not in this PR

Finding 3 (a cancel or move with no booking: the model says it will check with the team and no one is told) and Finding 4 (instruction wording in a customer reply, chat 84): both wait for a decision and, for Finding 4, its own PR. Chat 99 has still to be run live on its own. The live results of batches 1 to 3 are in the PR C note, section 5.

## 5. Checks

typecheck, lint, full tests, conversations and `packs:sync --check` run at the end; independent review; production check with file:line below.
