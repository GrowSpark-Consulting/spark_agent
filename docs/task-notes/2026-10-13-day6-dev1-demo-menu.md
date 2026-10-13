# 13 Oct (Dev 1): the demo number's menu and replies, the trial-phone check, read receipts and delivery statuses for routed chats (PR 1b). What was built, and what touches Dev 2's and Dev 3's areas

Dev 1 files: `backend/src/channels/whatsapp/demo/` (`text.ts`, `route.ts`, `db.ts` and tests; `ports.ts` deleted), `backend/src/inngest/demo-reply.ts` (and test, one added import and entry in `inngest/functions.ts`), `inbound.ts`, `mark-read.ts` (and tests), `supabase/tests/routed_chat_send.test.sql`. No migration.

## 0. Two things that must happen before real visitors use the demo number

1. **The Tamil and Tanglish wording is a machine draft that no native speaker has read.** The menu, "invalid or expired code", daily-limit and used-trial messages are in `demo/text.ts` in English, Tamil and Tanglish. The English is the reference; the Tamil and Tanglish must be reviewed and corrected by a native speaker before real visitors see them. The file's header says so.
2. **The demo number must be connected (seeded) to a dedicated platform business.** A visitor who cannot be routed (no code and no route, an invalid code, over the daily limit, a used trial) has their message stored with the business that owns the demo number's connection row, which also answers on that row. If that business is a real business, those chats appear in its inbox. `pnpm seed:connection` takes `--tenant <id>`; the business it is given should be one that has no customers of its own.

## 1. What a visitor is told now

Before this PR a message that could not be routed was dropped. Now:

| Situation | Answer |
|---|---|
| No code, no route | The industry menu |
| A code that is unknown, expired, or of a business that is paused or cancelled | "Invalid or expired" and the menu |
| The message that crosses 30 a day | "Daily limit reached", once. Later messages that day get nothing and are not stored. |
| A TRIAL code from a phone that already used a free trial | A short refusal; no route starts |

1. The menu is built from data: the `route_codes` of kind `demo` that are not expired, ordered by code, at most nine, each business labelled with its pack's `label` (the business's own name when it has none). It is plain text: `1. <label>: <code>`. No business or industry is named in code.
2. A visitor with no route can send a number, or an entry's label, or its code without the prefix, instead of the code; that acts as sending the code (the assistant is greeted with `Hi`). With a route, a bare number is an answer to the assistant and is not read as a pick. No menu state is stored: a message of 40 characters or fewer with no route is checked against the menu, and nothing else is read for it.
3. The language of an answer: Tamil script gives Tamil; Roman letters with a whole word from a short Tanglish list (`enna`, `venum`, `irukku`, `vanakkam`, ...) give Tanglish; anything else, English. It is a guess from the words, not from a model.
4. The link in the limit and used-trial messages is the app's root (`NEXT_PUBLIC_APP_URL`).
5. A message that gets an answer is stored with the front desk (its connection row's business, on the number's own channel) and the `whatsapp/demo.reply` event is started with ids, the kind and the language. The assistant is not asked, and the webhook never waits on Meta. `demo-reply` sends one `system_notice` through `notify.send` (free text inside the 24 hours the visitor just opened, no template), with the key `demo_reply:<message>`, so a retry or a redelivery never sends it twice. A retryable failure is retried (3 times); an outcome nobody knows is not.
6. A visitor with no route who sends STOP (the fixed phrases in `consent/stop-words.ts`) is not answered and nothing is stored: there is no business whose pipeline would record the opt-out. A visitor on a route who sends STOP is handled by that business's pipeline as before.
7. A redelivered message (Meta repeats a webhook that was answered 500) is decided by where its first delivery put it: stored with a business, it is stored for that business again; stored with the front desk, it is answered again (the reply's event id is the message's, so a reply already sent is not repeated); not stored at all, it is decided as if new.
8. Logs: the webhook line gains `demo_replied=` with the other demo counts, only when one is non-zero. No phone, name, text, code or business id is logged.

## 2. The trial phone

For a `TRIAL-` code the routing now calls Dev 2's `claimTrialPhone(tenantId, sender)` (`billing/trial-phone.ts`, migration 0033) with the sender in E.164, before the message is counted. `claimed` and `other_sender`: routed as usual. `taken`: the message is counted and dropped, no route starts, and the sender is told a free trial was already used. An error is thrown so the webhook answers 500 and Meta retries. `demo/ports.ts`, the no-op port, is deleted. A demo code is never checked.

## 3. Routed chats

1. **Read receipts.** `mark-read.ts` finds the connection to mark a message read on the same way `notify_target` does (0032): the business's own active connection on the conversation's channel first, then the active `platform` connection on that channel. The adapter is given the connection's own business, since a platform row's token was encrypted for it.
2. **Delivery statuses.** A status on the demo number is applied for the business whose conversation on that connection's channel holds the message (looked up by the message id), not the business that owns the connection. A message nobody holds is not applied. A status on any other number is applied as before.

## 4. Does Dev 2's 0032 work with the routing

Checked in the database (`supabase/tests/routed_chat_send.test.sql`, new): `demo_admit` routes a valid code; `store_inbound_message` (0031) stores the chat under the routed business on the platform channel; `notify_target` and `notify_staff_target` (0032) pick the platform connection for that chat and for that business's staff; the front desk's own chat picks its own row; a business with no chat on the platform number has no connection for an alert (PA409); and a delivery status is applied for the routed business and not for the platform business. `loadSendConnection` (0032's partner) was read, not run against a database: it accepts a `platform` row of another business and decrypts its token with the row's own business.

## 5. What touches Dev 2's area (no file, table, function or route of Dev 2 changed)

1. Calls `claimTrialPhone` (`billing/trial-phone.ts`) and `notify.send` with kind `system_notice`. `notify/kinds.ts` documents `system_notice` for two uses (the STOP confirmation and the out-of-credits holding message); the demo answers are a third use.
2. Observed, not changed: `conversationTemplates` (`conversations/templates.ts`) finds a chat's connection through the business's own active connection on the chat's channel. A routed chat has none, so the inbox's template picker would list nothing for it. Free-text staff replies are not affected (they go through `notify_target`).

## 6. What touches Dev 3's area

Nothing changed. Chats of visitors who could not be routed appear in the front desk business's inbox (the business that owns the demo connection row).

## 7. Known limits

1. The menu holds nine entries at most, one per business (its first code), read from at most 200 demo codes. A label that two businesses share does not pick either (a number still does). The Tanglish word list and the language guess are small and have not been checked on real messages; a visitor whose message is only a code gets English.
2. A visitor over the limit who sends a TRIAL code has already been checked against the trial phone, so the phone can be claimed by a message that is then refused for the limit. Only a phone that has sent 30 messages that day can do this.
3. A visitor with no route who sends a short word that is not on the menu gets the menu again, and so on, up to the daily limit. Replies inside the 24 hours the visitor opened are free service messages. Every such message is a stored message, contact and conversation of the front desk; nothing caps the number of different phones.
4. A pick is read from the menu as it is when the pick arrives, not as it was when the visitor was sent it. If a demo code is added, removed, expires or its business is paused in between, the number can point at a different entry. A bare number from a visitor whose 24-hour route has run out is read as a pick, even if it was meant as an answer to the assistant.
5. A visitor who has a live route and sends an invalid code is shown the menu; a bare number they reply with is an answer to the assistant of the business they are on, not a pick, until the route ends or its business is paused.
6. Two messages from one phone handled at the same moment (for example a code and a pick) are decided independently; the later write wins the route.
7. A message that crosses the daily limit and is stored but whose reply could not be started is redelivered as the next message of the day, which has no notice: that visitor gets no limit notice. A pick whose first delivery died between counting and storing reaches the assistant as the plain number ("2"), not as the greeting.
8. Not verified against a real Meta account or the staging database; mocked answers and the local database only.
