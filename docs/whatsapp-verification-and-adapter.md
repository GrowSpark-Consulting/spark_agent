# WhatsApp webhook verification and adapter

Owner: Dev 1. Written for Dev 2 and Dev 3.
Related: [whatsapp-webhook-parser.md](whatsapp-webhook-parser.md) · [encryption-and-env.md](encryption-and-env.md) ·
[contracts.md](contracts.md) · [environments.md](environments.md)

# Part 1: Webhook GET verification

## 1.1 What Meta calls and what we answer

Meta checks a callback URL with `GET /api/webhooks/whatsapp?hub.mode=...&hub.verify_token=...&hub.challenge=...`.
If the mode is `subscribe` and the token is ours, we answer **200 with the challenge as plain text** and nothing
else. Every other case is **403 with an empty body**. The code is
`backend/src/channels/whatsapp/verify-challenge.ts`; the API service serves it at
`/api/webhooks/whatsapp` (`backend/src/server/routes.ts`), `GET` for the check and `POST` for deliveries
(`channels/whatsapp/inbound.ts`, see `docs/task-notes/2026-10-08-feat-agent-webhook-post.md`); other methods get a 405.

## 1.2 The token and the setup

| | |
|---|---|
| Variable | `META_WEBHOOK_VERIFY_TOKEN`, one platform-wide value for our Meta app, read through `serverEnv()` |
| Staging callback URL | `https://<staging API host>/api/webhooks/whatsapp`: the Railway domain, or `https://api-staging.pakkaagent.in/api/webhooks/whatsapp` once that DNS points at Railway |
| Railway (staging env) | **Dev 2** owns the Railway environment ([environments.md](environments.md)) and sets `META_WEBHOOK_VERIFY_TOKEN` there |
| Meta app and DNS | **Raja** sets the webhook callback URL and the same verify token in the Meta app, and adds the DNS (his Day 1 list) |

The API host comes from [environments.md](environments.md). **Both setups must happen before Meta can verify
the callback**, and neither is confirmed yet. The values must match: the token in Railway and the token in the
Meta app. **Do not subscribe the app to the `messages` field until the POST route is merged**, or Meta's
deliveries will get errors. The callback check only needs the GET.

## 1.3 Behaviour worth knowing

- The token is compared in constant time (SHA-256 digests, then `timingSafeEqual`), so tokens of different
  lengths never throw.
- An empty or missing configured token always refuses, even if the request token is also empty.
- The challenge must be 1 to 256 printable ASCII characters. A repeated parameter counts as missing.
- Nothing is logged except one fixed line, `webhook verification: environment invalid`, when `serverEnv()`
  throws (the answer is still 403). The token and the challenge are never logged or returned.
- Other methods (PUT, PATCH, DELETE) answer 405 with `allow: GET, POST`; that is **unconfirmed** until seen on
  staging. The POST handler verifies `META_APP_SECRET` only; `manual_byo` signatures are a follow-up.

**Open item:** clients on `manual_byo` set their own verify token in their own Meta app, which will not match
ours. A decision for Raja before `manual_byo` goes live.

# Part 2: WhatsApp adapter (`sendText`, `sendTemplate` and `markRead`)

## 2.1 What it is

The send side of module 1, in `backend/src/channels/whatsapp/adapter.ts`, with the error mapping in
`meta-errors.ts`. It calls Meta's Graph API at `META_GRAPH_API_VERSION` (default `v26.0`) on
`POST /{phone_number_id}/messages`, through an injected `fetch`. The tests use no network.

```ts
type SendConnection = { tenantId: string; connectionId: string; phoneNumberId: string; tokenEnc: string }; // server-only
type AdapterDeps = { fetch?: typeof fetch; timeoutMs?: number;       // default 10 000
                     env?: Pick<ServerEnv, "ENCRYPTION_KEY" | "META_GRAPH_API_VERSION"> };  // default serverEnv()
type AdapterError = { code: ErrorCode; retryable: boolean; outcomeUnknown: boolean; message: string;
                      meta?: { code?: number; subcode?: number; httpStatus?: number } };
type AdapterResult<T> = { ok: true; value: T } | { ok: false; error: AdapterError };

sendText(connection, to, body, deps?): Promise<AdapterResult<SendResult>>        // SendResult = { providerMsgId }
sendTemplate(connection, to, { name, language, params }, deps?): Promise<AdapterResult<SendResult>>
markRead(connection, wamid, deps?):    Promise<AdapterResult<{ success: true }>>
```

All three return a result and never throw. `to` is normalised to E.164 and sent with its `+` (Meta supports it
and recommends it). The text must be 1 to 4096 characters. A bad number, text, phone number id or wamid gives
`validation_failed` before any network call.

`sendTemplate` sends an approved template: its exact versioned name (`booking_confirmed_v1`), a language code
(`en`, `ta`, `en_US`) and the body variables in `{{1}}…` order, as
`components: [{ type: "body", parameters: [{ type: "text", text }] }]` (left out when there are none). A variable
that is empty, over 1024 characters, or has a newline, a tab or more than 4 spaces in a row is refused with
`validation_failed` before any network call (Meta would answer 132018). Header and button variables are not
supported yet; the Day 4 staff alert's URL buttons will need them.

## 2.2 How `notify.send` uses it

**How it plugs in (built by Dev 2, 8 Oct).** `backend/src/channels/whatsapp/message-sender.ts` is the
`SenderFactory` that `server/main.ts` registers at startup (`registerWhatsAppSender()`), so `notify.send` no
longer answers `not_available`. For each send it loads the connection with the service role (`phone_number_id`,
`token_enc` and `status`, filtered by tenant and id; anything not `active` is `whatsapp_not_connected`) and
returns a `MessageSender` bound to it. Its `sendText` and `sendTemplate` call this adapter and **throw** on
`ok: false`: `OutsideWindowError` for 131047, otherwise a `SendError` carrying the adapter's `code`, `retryable`
and `outcomeUnknown` (both in `backend/src/notify/sender.ts`). The token stays encrypted until the adapter
decrypts it for the call. `notify.send` checks the 24-hour window and picks free text or a template; the adapter
does not.

**Errors.** The Meta code wins; the HTTP status is only the fallback. Only existing codes are used.

| Meta | Our code | `retryable` |
|---|---|---|
| 131047 (24-hour window closed) | `outside_window` | no |
| 4, 80007, 130429, 131048, 131056; HTTP 429 | `rate_limited` | yes |
| 0, 3, 10, 190, 200 to 299, 131005, 133010; HTTP 401 | `whatsapp_not_connected` | no |
| 100, 131008, 131009, 131021, 131026, 132000, 132012 | `validation_failed` | no |
| 1, 2, 131000, 131016, 135000; HTTP 5xx | `upstream_failed` | yes |
| 131042, 131045, 368, 131050, 131051, 132001, 132015, 132016 | `upstream_failed` | no |
| Anything else | `upstream_failed` | no |

`outcomeUnknown: true` means the message may have gone out: a timeout, a network failure, or a 200 answer that
could not be read. Timeout and network failure are also `retryable: true`. Error messages are fixed strings;
Meta's own text is never passed on, and `meta` holds integers only.

**The two questions sent to Shaaz, answered on 8 Oct:**
1. Can `notify.send` pass the error code and the `retryable` flag through? **Yes, built.** A `failed` outcome
   now keeps the sender's code (`outside_window`, `rate_limited`, `whatsapp_not_connected`, `validation_failed`,
   `upstream_failed`) and always carries `retryable` and `outcomeUnknown`.
2. Refund, or hold for reconciliation, after a timeout? **Dev 2 proposes holding, but it waits for Raja**
   because it changes billing ([contracts.md](contracts.md), decision 16). Holding also needs a way to learn the
   outcome later, such as Meta's status webhook. Until then `notify.send` refunds as before and reports
   `outcomeUnknown: true`, so no caller sends the message again.

## 2.3 Token handling

The tenant's token is decrypted **per call** with the `token_enc` context
(`whatsapp_connections:token_enc:<tenant_id>:<connection_id>`, see [encryption-and-env.md](encryption-and-env.md)).
It goes only into the `Authorization` header and is never stored, logged, or put in a result or an error. A
tampered, wrong-key or copied `token_enc` gives `whatsapp_not_connected` without calling fetch; a missing
`ENCRYPTION_KEY` gives `internal`.

## 2.4 What it never does

- No retries: a retry after a timeout could send twice.
- No database reads or writes (so it cannot mark a connection `failed` when a token has expired).
- No 24-hour window check, and it does not call `notify.send`. Nothing else may send messages.
- No logging.

## 2.5 Unconfirmed Meta details

Not shown on the Meta pages read, so treated loosely: the error JSON shape (`error.code`, `error_subcode` and so
on), which HTTP status goes with which code, a `Retry-After` header, an idempotency key for sends (none is
used), and code `131030` (recipient not in the allowed list). `preview_url: false` is our choice, and Meta's
default is unconfirmed. Confirmed on Meta's pages: the endpoint and headers, `+` accepted in `to`, the success
shapes (`messages[0].id`, `{"success": true}`), and the error codes in the table above.

# What each developer should do

| | Do |
|---|---|
| Dev 1 | Marking a connection `failed` when a send says its token no longer works (`whatsapp_not_connected`). Header and button variables in `sendTemplate` when the Day 4 staff alert needs them. (The POST webhook handler is done, #50.) |
| Dev 2 | Done on 8 Oct: the `MessageSender` wrapper, `sendTemplate`, the connection loader, `registerSender` at startup and the answers above. Still to do: set `META_WEBHOOK_VERIFY_TOKEN` and `META_APP_SECRET` in Railway (the token must match the one Raja enters in the Meta app). |
| Dev 3 | The test-message screen can now get the real send's errors: `outside_window` (409), `rate_limited` (429), `whatsapp_not_connected` (409), `validation_failed` (422) and `upstream_failed` (502), each with a message ready to show. |
| Raja | Set the webhook callback URL and the verify token in the Meta app, add the staging DNS, and decide the `manual_byo` verify-token question. Both his setup and Dev 2's Railway variable are needed before Meta can verify the callback. |

# Status

Done: the webhook GET verification and the adapter with `sendText`, `sendTemplate` and `markRead`. Tests:
`verify-challenge.test.ts` (right and wrong mode, token and challenge, empty or missing token, different token
lengths, the log line, no token in any response), the route test `backend/src/server/webhook.test.ts`
(GET and POST only, other methods 405; 200 and 403; no CORS headers), `webhook-post.test.ts` (the POST route),
`adapter.test.ts` (exact request, token handling, errors, timeouts, validation, `sendTemplate`, `markRead`) and
`meta-errors.test.ts` (the mapping table). The POST webhook route is built. Built on 8 Oct (Dev 2): the
`MessageSender` wrapper, the connection loader and the startup registration, tested in
`message-sender.test.ts`, including `notify.send` end to end through the registered sender with only the
database and Meta faked. **Next:** marking a connection `failed` on a broken token, and template header and
button variables.

**Read receipts (12 Oct).** `markRead` now has a caller: the message pipeline marks the newest customer message of a turn read (the blue ticks) as soon as the gate lets it through, before STOP, understanding and the reply (`channels/whatsapp/mark-read.ts`, wired in `inngest/process-message.ts`). It is best effort and never goes through `notify.send`: a 3-second timeout, skipped when less than 8 seconds of the turn's 10-second target remain, never an error, and the log line is only `[pipeline] mark read: marked|skipped (reason)`. Unverified against a live Meta account.
