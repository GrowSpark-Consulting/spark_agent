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
