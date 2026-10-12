# 12 Oct (Dev 1): hardening the manual WhatsApp connection. What was built, and what touches Dev 2's and Dev 3's areas

Everything of Dev 1's is in `backend/src/channels/whatsapp/connect/` (plus tests and the contract doc `docs/whatsapp-connection-contract.md`, two appended lines). No file, table,
migration or endpoint of Dev 2 or Dev 3 changed.

## 1. App secret of Spark Agent's own app (PR 1)

1. `connectManual` refuses an app secret equal to `META_APP_SECRET` with `validation_failed` and `fields.appSecret`, before Meta is asked and before anything is saved. Both connect
   routes (`POST /api/whatsapp/manual`, `POST /api/admin/whatsapp/manual`) share it. The reason: the platform app's webhooks are signed with `META_APP_SECRET`, and `inbound.ts`
   trusts a `manual_byo` connection only on its own secret, so such a connection would have every message dropped. Spark Agent's own numbers are connected by the team.
2. A token that Meta reports as expired or no longer valid (OAuth error 190 or HTTP 401) on connect or recheck makes `token_permissions` a `fail` with "The access token has
   expired or is no longer valid. Create a new one in Meta and connect the number again." and the connection `failed`. No new status value (the constraint in
   migration 0003 is unchanged). Any other rejection keeps the general message. Error 190 also covers a revoked token, so the words say "or is no longer valid".

For Dev 3: the new message arrives as `last_check.checks[0].message`, and the refusal as `fields.appSecret` on the form. Nothing in the shapes changed.
For Dev 2: nothing. The send path (`meta-errors.ts`) already mapped 190 to `whatsapp_not_connected` and is unchanged.

## 2. Subscribing the app to the account's webhooks (PR 2)

1. On connect and on every recheck the webhook check reads the account's subscriptions. Only when none is subscribed, the number is in the account and the token check passed (both WhatsApp permissions), it sends `POST {waba}/subscribed_apps` with the connection's own token (`subscribeApp` in `connect/checks.ts`, best effort) and reads again. An account that already has an app is never posted to, so a repeat cannot reset a subscription's callback. A refusal, no answer or a thrown error never stops the connection; Meta must answer `success: true` to count.
2. `webhook_subscribed` with nothing subscribed afterwards is now `warn` (before: `fail`), so it can no longer make a connection `failed` and the number stays `active`. When the attempt itself failed the message says the app could not be subscribed automatically and where to do it in Meta; otherwise it says the app is not subscribed yet.
3. The audit rows `whatsapp_connection.connected` and `whatsapp_connection.rechecked` carry `subscribed` in `diff`: `true` an app is subscribed afterwards, `false` none is, `null` Meta was not asked (token not accepted) or did not say.
4. The Graph call is unverified against a real Meta account.
5. Known limit: a recheck that is running when the owner disconnects can still send its POST after the disconnect's unsubscribe; the recheck then fails to save and the number stays disconnected, but Meta keeps the subscription until the next disconnect or a manual change.

For Dev 3: the `last_check` shape is unchanged; a missing subscription now arrives as `status: "warn"` on `webhook_subscribed`, and the connection stays `active`. For Dev 2: nothing.

## 3. The first signed webhook clears the waiting note (PR 3)

1. When a webhook signed with a `manual_byo` connection's own app secret names it, `connect/webhook-seen.ts` (already writing the one `webhook_seen` audit row per connection) also turns the stored `webhook_subscribed` check of that connection into `pass` when it is `not_verified` (waiting for that webhook), with the message "Your app is subscribed, and a signed webhook from it has arrived.", and works `overall` out again (`withWebhookConfirmed` and `withCheck` in `checks.ts`). The owner no longer has to press Recheck. A `warn` (Meta's list showed nothing subscribed) is left for a recheck, so the stored result does not contradict Meta's own answer.
2. The status is never changed. Only an `active` manual_byo connection of that business is touched. A repeat writes nothing. `ran_at` stays as it was. The update is guarded by the row's `updated_at` as it was read (a trigger moves it on every write), so nothing saved in between, a recheck or the sixth check of a connect, is overwritten with an older copy; a guard that misses is looked at again by a later webhook.
3. The test message of a connect or recheck can itself bring the first signed webhook (its delivery statuses come from the business's own app). So both save the sixth check after reading the webhook proof again (only when the first read did not already find it), so that write does not put the waiting note back.
4. It never blocks or delays the webhook's answer (the call was never awaited by `inbound.ts`) and a failure changes nothing. A connection that is not ready (not active, nothing stored yet), a database error, or a guard that missed is looked at again by a later webhook, at most once a minute per connection; a connection that is done is remembered until the server restarts.
5. A number that is `failed`, `validating` or `pending` is not touched; a recheck reads the `webhook_seen` row itself and passes the check.
6. Not verified against the real database: the `updated_at` guard is exercised only through the test fake. A recheck's own write that lands in the few milliseconds between its proof read and its save can still put the waiting note back; the next Recheck clears it.
7. The stored result is checked only for the fields the update needs, and everything else is passed through, so a check this code does not know yet does not stop the clearing.

For Dev 3: the stored `last_check` can now change without a call from the dashboard (the webhook check going from `not_verified` to `pass`, `overall` from `warn` to `pass`). The shape is unchanged. For Dev 2: nothing.

## 4. Live run of the conversation chats, 12 Oct

1. Chats 51, 55, 61, 63, 06 and 20 were run with the real models (`pnpm test:conversations -- --live`, one chat per command, fake sender and knowledge base, nothing on staging): 17 model calls in all, 5 of 6 passed.
2. Chat 51 failed on wording only: the model wrote "10 am" and "3 pm" where the chat asked for "10:00 am" and "3:00 pm". The times, the booking and the calendar were right. Chat 51 now asserts the times with patterns in both modes (`matches`) and keeps the exact words under `mockOnly`; a live re-run of 51 passed (4 calls).
3. Chat 63: the real model gave "the second one" an intent confidence of only 0.4. The booking was still right, because the code picks the slot, not the extraction.
4. English only: nothing in this run says how the models handle Tamil or Tanglish.
