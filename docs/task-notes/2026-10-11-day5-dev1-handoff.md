# Day 5 (Dev 1): connecting and checking a WhatsApp number, and the suggested reply. What was built, and what Dev 2 and Dev 3 should know

Audience: Dev 2 (Shaaz) and Dev 3 (Dhatri). The next person to touch the agent can read it too.

Nothing here changes a file, a table, a migration or an endpoint of yours. Everything of Dev 1's is in `backend/src/channels/whatsapp/` and `backend/src/agent/leadcard/`
(plus tests and this note). The only shared files touched are `server/routes.ts` (three added routes) and the contract docs `docs/whatsapp-connection-contract.md` and
`docs/dashboard-screen-contracts.md` (one paragraph and one line). Sections 3 and 4 are the parts about Dev 3's and Dev 2's areas.

## 1. What it does, in plain words

1. **Six checks on a connected number.** When a business connects its own number (`manual_byo`), and every time someone presses Recheck, the system asks Meta six questions: does the token carry both WhatsApp permissions, is the number in the account and on the Cloud API, is the app subscribed to the account's webhooks (and has a webhook from the business's own app arrived), is the display name approved, is there a payment method, and does a test message reach the owner's number. Each answer is a short sentence in plain words, written for the screen.
2. **Recheck.** Runs the six again and updates the status.
3. **Disconnect.** Marks the number disconnected. From that moment the AI neither hears nor answers on it.
4. **Suggested reply.** Staff can ask for a reply they can send as it is.

## 2. What was merged

| PR | What |
|---|---|
| #109 | The six checks, `POST /api/whatsapp/connections/:id/recheck` and `/disconnect`, connect now runs all six. |
| #110 | `POST /api/conversations/:id/suggest`. |

`POST /api/admin/whatsapp/manual` and `POST /api/whatsapp/manual` already existed; they now return a `last_check` with all six checks.

## 3. For Dev 3: what Dev 1's work adds in your area

1. **Recheck and disconnect.** `POST /api/whatsapp/connections/:id/recheck` and `.../disconnect`, no body, `X-Pakka-Tenant` as for the other routes. Both return the connection in the usual public shape (`WhatsAppConnectionPublic`) with the new `status` and `last_check`. Allowed for the owner and admin of the business that owns the connection. Staff get `forbidden`; another business's connection and an unknown id get `not_found`; one of Spark Agent's own numbers (`method: platform`) gets `forbidden`.
   - Recheck on a `disconnected` number is `conflict` ("connect it again with the connection form"). Recheck while another check runs is `conflict`. If Meta cannot be reached the answer is `upstream_failed` and the status is what it was before.
   - Disconnect is safe to repeat: the second answer is the same connection, unchanged.
   - Today the frontend allows recheck for owner and admin and disconnect for the owner only (`connection-actions.ts`); the API allows both for owner and admin. The stricter rule is Dev 3's UI choice.
2. **The statuses.** `pending`, `validating` (only while a recheck runs, a few seconds), `active`, `failed`, `disconnected`. A failed connection is one where any check is `fail`.
3. **`last_check`.** `{ ran_at, overall: "pass" | "warn" | "fail", checks: [{ key, status, message, checked_at }] }`, the six keys in this order: `token_permissions`, `number_registered`, `webhook_subscribed`, `display_name_approved`, `payment_method`, `test_message_delivered`. A check's `status` is `pass`, `warn`, `fail`, `not_verified` or `skipped`. The `message` is written to be shown as it is: no token, no secret and nothing Meta said.
   - `not_verified` means Meta did not say, or the check is waiting. Two are normal on a new number: `webhook_subscribed` waits until a webhook from the business's own app arrives (a message to the number, or Meta's Test button), and `test_message_delivered` waits until the owner has messaged the number in the last 24 hours (WhatsApp only allows free text then). A recheck after either picks it up.
   - `skipped` means the check could not be asked because an earlier one failed (for example a wrong token) or there is no owner number saved to send the test to.
   - `payment_method` is only `pass`, `warn` or `not_verified`; a missing payment method is a warning and the number still connects.
   - A test message that cannot be sent is a warning, never a failure, and never changes the status.
4. **Suggested reply.** `POST /api/conversations/:id/suggest`, no body, owner, admin or staff, free. Answer: `{ reply: string | null, language: string | null, reason: "unavailable" | null }`. When there is nothing safe to suggest (the model is down, or its words did not pass the checks) the answer is still 200 with `reply: null` and `reason: "unavailable"`, so the button can say there is no suggestion this time. It is the lead card's suggested reply, so it only changes when the customer writes again. Nothing is sent by this route: staff send it through the staff reply route.
5. **The admin form** posts to `POST /api/admin/whatsapp/manual`; the answer is 201 with the connection, `active` or `failed`, and a `last_check` with the six checks. Errors: `validation_failed` (with `fields`), `unauthenticated`, `forbidden`, `not_found`, `conflict` (the number is already connected), `upstream_failed`.
6. **What disconnected means on screen.** The row stays, with `status: disconnected`. The AI neither receives nor answers on that number, and no message can be sent from it. Connecting again with the form re-uses the row.

## 4. For Dev 2: what Dev 1's work sends, calls and affects

1. **A test message goes through `notify.send`.** The sixth check sends one `test_message` (0 credits, free text) to the owner's `memberships.whatsapp_phone` (or, if the owner has none, the person connecting). It counts toward the 10 test messages an hour that `notify.send` allows per business, and it needs the connection to be `active`, which is why it runs after the first five checks decide the status.
2. **Status `validating`.** While a recheck runs, the connection's status is `validating` for a few seconds, and `notify.send` refuses any send on it (`whatsapp_not_connected`), as it does for every status other than `active`.
3. **What `disconnected` does to sending.** `message-sender.ts` and the webhook handler both read `status = 'active'` only, so a disconnected number sends nothing and stores nothing inbound. No code of yours was changed for this.
4. **Audit rows written:** `whatsapp_connection.rechecked` (`{ from, to }`), `whatsapp_connection.disconnected` (`{ from, to, unsubscribed }`), and `whatsapp_connection.webhook_seen` (actor `system`, once per connection per server start, when a webhook signed with the connection's own app secret names it).
5. **Plan limit on WhatsApp numbers (your Day 5 list: 1 for Starter and Growth, 3 for Pro).** The connect route (`channels/whatsapp/connect/manual.ts`) has no limit today. A business can connect any number of numbers. Whichever way the limit is enforced, it meets that route and `POST /api/whatsapp/manual`.
6. **The webhook handler has one optional new hook** (`noteWebhookSeen`, in `inbound.ts`). It is called for a manual_byo connection only, is never awaited by the answer, and a failure there changes nothing.

## 5. Still open (Dev 1 follows these up)

1. **Tamil and Tanglish tuning** (prompts, field normalisation, language detection) waits for real chats. It was not started.
2. **Conversation tests:** the suite is at 64 chats, past the 20 asked for. Missing from the list: an out-of-area chat. The prompt-injection chat checks that no invented price gets through, but does not yet assert that score, stage and booking are unchanged.
3. **The five most important Tanglish failures** for the regression set come from real chats or a live-model run, and have not been added.
4. **Not run against a real Meta account.** Every Graph call (`debug_token`, `subscribed_apps`, `primary_funding_id`, `name_status`, `platform_type`) follows Meta's documentation as understood, and is unverified. The checks are written so that an answer that does not fit is `not_verified`, not a failure.
5. **Not run on staging.** The exit tests for connecting the test number, a wrong token, recheck and disconnect have not been done. They need a real number, the owner to have messaged it in the last 24 hours, and a webhook from the app.
6. **The connect call is one step.** The status goes straight to `active` or `failed`; the `pending → validating → active` path is real only for a recheck.

## 6. Limits worth knowing

- The access token is read back (decrypted) only inside the server, for the checks and for the unsubscribe, and is never returned, logged or put in a message.
- The unsubscribe on disconnect is best effort: a revoked token or an unreachable Meta cannot do it, and the disconnect stands anyway (the audit row says whether it worked).
- A server that stops in the middle of a recheck leaves the number `validating`. A new recheck is refused as "already running" until the status is changed. This is rare and has no automatic recovery yet.

## 7. Corrections, 12 Oct

- Section 5, point 2: the suite has **52** chats, not 64 (64 is the highest file number, `64-voice-note-asks-to-type.yaml`). It is still past the 20 asked for.
- Section 5, point 2, second sentence: the prompt-injection chat (05) now also asserts that the lead stays `engaged` (what any understood first message gives), the score stays 0 and nothing is booked or cancelled, and that the chat goes to a person as a discount request (`handoff` negotiation/high, `mode` human), the same as chat 62.
