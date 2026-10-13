# 13 Oct (Dev 1): the daily connection-health check and the token-expiry warning (PR 5). What was built, and what touches Dev 2's and Dev 3's areas

Dev 1 files: `backend/src/channels/whatsapp/connect/` (`health.ts`, `health-alert.ts`, `token-expiry.ts`, `run-checks.ts`, tests; `checks.ts` and `recheck.ts` edited), `backend/src/inngest/connection-health.ts`, `token-expiry.ts` (and tests), one added import and three added list entries in `inngest/functions.ts`. No migration.

## 0. Alerts about a dead number reach only a business with a second active number (until Dev 2's three items land)

The alert is sent through `notify.send` (kind `staff_alert`) from the business's own active connection, which is how `notify_staff_target` (0019) chooses it: the oldest connection with `status = 'active'`. A connection that has just failed is not active, and one with a dead token cannot send, so the alert about it **only reaches a business that has a second active number**. A business with one number does not get the message; it sees the failure in the dashboard (the connection's `status` and `last_check`, which `whatsapp_connections_public` already shows). The token-expiry warning comes before the failure, while the connection is still active, so it does reach a business with one number.

What Dev 2 would need to add, for an alert about a dead number to reach a business with one number:
1. In `notify_staff_target`: when the business has no active non-platform connection, fall back to the active `platform` connection, with the staff conversation on the platform channel under the business (the same arrangement as the demo routing, PR 1a / migration 0031).
2. Approved `staff_alert_vN` template rows (English and Tamil) on the platform connection, because a staff member will not have messaged our number within the last 24 hours.
3. Optionally an email path: `RESEND_API_KEY` is in `env.ts`, but `notify` has no email channel.

## 1. connection-health (daily, 01:30 UTC)

1. A sweep lists the connections with `status = 'active'` and `method = 'manual_byo'` (one constant, `HEALTH_METHODS`) whose stored `last_check.ran_at` is 20 hours old or missing, oldest first, at most 500, and starts one `whatsapp/connection.health_check` event each. The event id is `connection_health:<connection>:<India day>`, so a repeat sweep starts nothing twice. The checks run five at a time.
2. A check reads the connection (named by its business and id), decrypts its token and runs the same Graph checks as a recheck: `probeMeta` and `runGraphChecks`, now in `run-checks.ts` (recheck uses it too; `recheck.test.ts` is unchanged and passes). It does **not** put the number in `validating`, it does not run the test message check (the stored sixth check is kept), and it never asks Meta to subscribe the app (an account with no app subscribed is only a warning), so it cannot undo a disconnect that arrived while it ran.
3. It refreshes `last_check`, `quality_rating`, `display_phone`, `verified_name`, `messaging_limit` (one extra read of `messaging_limit_tier`, `readMessagingLimit`; a failure leaves the stored value) and `token_expires_at` (from `debug_token`'s `expires_at`; 0 clears it; absent leaves it).
4. The status becomes `failed` (so the AI neither hears nor answers on the number) at once only when Meta says in so many words that the token has expired or is no longer valid, or that it lacks a WhatsApp permission. Anything else that fails (Meta refusing the token without saying why, such as a rate limit; a saved token that cannot be decrypted, for example after a key was changed; a declined display name; a number not in the account) makes the connection `failed` only when the previous stored result also failed and is at least 12 hours older, so one bad night, or a retried step, cannot stop businesses' assistants. Only the five Graph checks decide. The write is a compare-and-set on the business, the connection, `status = 'active'` and the `updated_at` that was read: a recheck, connect or disconnect that came in meanwhile wins and the job writes nothing.
5. When Meta cannot be reached (5xx, 429, no answer) nothing is written, audited or sent; the next day tries again.
6. Audit rows, actor `system`: `whatsapp_connection.health_failed` (`from`, `to`, `reason` token or checks) and `whatsapp_connection.health_changed` (only the quality rating and messaging limit that changed). Nothing is audited when nothing changed.
7. A connection that has just failed is reported to the owners and admins who have an alert number, in a step of its own, as a `staff_alert` through `notify.send` with the failing check's own words (the existing `checks.ts` messages, including the "access token has expired or is no longer valid" one), the number masked (the job's stored step results hold only the masked number), and a link to `/dashboard/whatsapp`. The idempotency key is `connection_failed:<connection>:<time of the result it replaced>:<person>`. A switch that is off, a number that cannot send and a send that breaks are counted, not retried.

## 2. token-expiry (daily, 04:00 UTC)

Lists `status = 'active'`, `method = 'manual_byo'` connections whose `token_expires_at` is after now and before 7 days from now, soonest first, and warns each owner and admin with an alert number, one step per connection. The key `token_expiring:<connection>:<expiry date>:<person>` gives one warning per expiry date (a renewed token has a new date). There is no second reminder. An already expired token is not warned about: the daily check marks it failed and tells the owners (see 0). `token_expires_at` is filled by the daily check, so a connection's first warning can come the day after its first check.

## 3. What touches Dev 2's area (no file, table, function or route of Dev 2 changed)

1. Calls `send` from `notify/send.ts` with kind `staff_alert` and a payload of `staffUserId`, `text`, `templateParams` and `idempotencyKey`, the same payload `sendStaffAlert` builds. The text is Dev 1's own (`health-alert.ts`); `staff-alerts.ts` and its alert kinds are not changed and are not used for these alerts.
2. Calls `staffAlertRecipients(tenantId)` (owners and admins with a `whatsapp_phone`).
3. `notify.send` applies the `staff_alerts` switch and the plan; its `skipped` and `failed` outcomes are only counted.

## 4. What touches Dev 3's area

Nothing changed. The dashboard can now see a connection become `failed` with no action from a person, and `last_check` and `quality_rating` change daily without a request: a screen that reads `whatsapp_connections_public` sees it on its next read. The contract does not promise Realtime for `whatsapp_connections`. The alert text links to `/dashboard/whatsapp`.

## 5. Known limits

1. Every Graph call is UNVERIFIED against a live Meta account: `debug_token`'s `expires_at` (as `checkToken` already assumed), and `messaging_limit_tier` on the number (new).
2. Only manual connections are checked (`HEALTH_METHODS`). Embedded Signup and assisted connections are not, and are behind a flag.
3. A job that dies between writing `failed` and reporting it does not report it on a retry (the connection is no longer active), so that owner sees the failure only in the dashboard. A status step that finishes is not repeated.
4. Quality rating and messaging limit changes are audited, not announced; only a failure sends an alert.
5. A declined display name, or a number Meta no longer lists in the account, fails a connection after two days like any other non-token failure; a recheck does the same. Whether sending really stops in those cases is not known.
6. The daily sweep reads at most 1,000 active manual connections ordered by `updated_at` and starts at most 500: past that many connections some could wait; not expected at the current scale.
7. Environment: no new variable. The alert link uses `NEXT_PUBLIC_APP_URL`.
8. Tested with mocked Meta, database and `notify.send` answers only; nothing ran against staging or Meta.
