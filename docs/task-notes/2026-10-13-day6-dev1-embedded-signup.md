# 13 Oct (Dev 1): the Embedded Signup route, flagged off (PR 2). What was built, and what touches Dev 2's and Dev 3's areas

Dev 1 files: `backend/src/channels/whatsapp/connect/embedded-signup.ts` and its test (new); `manual.ts` (the saved record can now carry `method`, `coexistence`, `messagingLimit`, `tokenExpiresAt`, and a null `appSecretEnc`; a manual connection leaves them out and saves as before; `realDb` is exported) and `checks.ts` (the `Graph` client takes an optional JSON body) edited. Shared files, additive only: one import, one handler and one route entry in `backend/src/server/routes.ts`; `EMBEDDED_SIGNUP_ENABLED` in `backend/src/lib/env.ts` and `backend/.env.example`. Nothing of Dev 2's or Dev 3's changed. Nothing ran against a real Meta account: every Graph call below is UNVERIFIED.

## 0. One thing for Dev 3 before this merges green

`frontend/lib/api/backend-routes.test.ts` lists `POST /api/onboarding/whatsapp/embedded-signup` under `AWAITING_BACKEND`. The test is built to fail the moment the API registers a route in that list, so with this PR `pnpm test` fails in the frontend (two tests: "a route the frontend is waiting for is still not registered" and "every backend route is called by the frontend or has a stated reason it is not"). The fix is one line in Dev 3's file: move that entry from `AWAITING_BACKEND` to `FRONTEND_CALLS`. Not done here, because the file is Dev 3's. `GET /api/connect-links/:token` stays in `AWAITING_BACKEND` (PR 3).

## 1. The route

`POST /api/onboarding/whatsapp/embedded-signup`, signed in as owner or admin (the business is the caller's own; a `tenantId` in the body is dropped). Body `{ code, wabaId, phoneNumberId, coexistence }`. 201 the connection (`WhatsAppConnectionPublic`).

1. **Flag.** `EMBEDDED_SIGNUP_ENABLED` (default off, must be exactly `true`). Off, or `NEXT_PUBLIC_META_APP_ID` / `META_APP_SECRET` unset: `not_available` (501) before the role, the body or Meta is looked at. One edge: the route wrapper reads the JSON body before the handler, so an unparseable body is still `validation_failed`.
2. **Input.** Staff: `forbidden`. Ids must be digits. `phoneNumberId` null or missing (Dev 3's payload sends null when Meta's finish event has no number) is `validation_failed` with `fields.phoneNumberId` "Pick or add a phone number in the Facebook sign-in, then try again." `connectToken` is refused until the assisted-link PR.
3. **Number.** Another business's number, or one this business already has `active`: `conflict`, before the code is used. This business's own row for it that is `failed`, `disconnected` or `pending` (by either method, so a failed manual row can be taken over) is connected again in place. The manual path itself is unchanged and still retries only its own method. The plan's number limit (`assertNumberAvailable`, Dev 2's) is asked before Meta is.
4. **Exchange.** `GET /oauth/access_token?client_id&client_secret&code` on the pinned Graph version, no `redirect_uri` (Meta's examples send none), 10 seconds. A refused code is `upstream_failed` "Facebook didn't accept that sign-in... Start the Facebook sign-in again."; no answer is `upstream_failed` too. Nothing is saved or sent.
5. **Subscribe** (`subscribeApp`, `POST {waba}/subscribed_apps`) then **register** (`POST {phone}/register` `{ messaging_product: "whatsapp", pin: WHATSAPP_REGISTER_PIN }`), both best effort with the new token. Register is skipped for a coexistence number and when the pin is unset. A refusal shows in the checks and the audit row (`registered`), never stops the connection.
6. **Read and check.** A token that cannot read the number, or a number that is not in the account the person signed in with, is `validation_failed` on `phoneNumberId` and **nothing is saved** (a failed row would hold the number id against its real owner); only an expired-token answer is saved `failed`. `runConnectionChecks` with `method: "embedded_signup"`: the same six checks, the "token expired" wording, `failed` when any check fails, otherwise `active`. The webhook check passes for "some app is subscribed"; when our own `subscribed_apps` call did not go through (a number leaving a BSP still lists the BSP's app) it is made a `warn` instead, and the audit says `subscribed: false`. Meta's shape for naming which app is listed is not known, so we do not compare app ids (UNVERIFIED). Display phone, verified name and quality come from the number's read; the messaging limit from `readMessagingLimit` (`messaging_limit_tier`); `token_expires_at` from `debug_token`. Meta not answering the read is `upstream_failed` and nothing is saved (the code has been used by then: the client starts the Facebook sign-in again).
7. **Save.** Token encrypted under its own column, business and connection; **no app secret is stored** (`app_secret_enc` null), because webhooks for this method are signed with `META_APP_SECRET` (`inbound.ts` `PLATFORM_SIGNED` already lists `embedded_signup`). `connected_by` is the user id; `token_type` `business`.
8. **Audit** `whatsapp_connection.connected`: ids and outcomes only (`method`, `status`, `reconnected`, `coexistence`, `subscribed`, `registered`). **Event** `whatsapp/connected` `{ tenantId, connectionId }`, only for an active connection, id `whatsapp_connected:<connectionId>:<ran_at of the checks>` so a later reconnection is a new event; a failure to send is logged with a fixed line and changes nothing. **Sixth check** (a test message through `notify.send`, Dev 2's) runs last for an active number and never changes the status.

For Dev 3: shapes are the connection's, as for manual. A finish with no phone number (v4 can end with none) comes back as `validation_failed` on `phoneNumberId`; the screen should send the person back into the popup. The code lives about 30 seconds, so post it as soon as it arrives. The popup configuration is v4 (set by the login configuration, not by `extras`); Meta's Embedded Signup v2 is deprecated on 15 October 2026.
For Dev 2: nothing changes. `whatsapp/connected` has no listener yet: the template submission waits for your template-status table decision (it will read `connectionId` and the pack's templates).

## 2. What Meta's pages said (13 Oct), and how sure we are

Read from developers.facebook.com (the Embedded Signup "Onboarding customers as a Tech Provider" page, "Versions" and "Version 4 public preview", the implementation page, the phone-number page).

| Point | Result | Sure? |
|---|---|---|
| Exchange: `GET /oauth/access_token` with `client_id`, `client_secret`, `code` | as the page shows | Page read; not run |
| `redirect_uri` | Not mentioned anywhere, so not sent | UNVERIFIED (absence in examples, not a statement) |
| Answer of the exchange | The page shows the token alone; we also accept JSON `{ access_token }` | UNVERIFIED |
| `subscribed_apps` / `register` bodies, six-digit pin, `{ "success": true }` | as the page shows | Page read; not run |
| v4 is the latest; v2 deprecated 15 October 2026; v4 is set by the login configuration, `extras` is empty | stated on Meta's pages | Sure it is what Meta says |
| v4 can finish with a verified, unverified or no phone number (`FINISH_ONLY_WABA`) | stated | Sure; the shape of the finish message for those cases is UNVERIFIED |
| Code lifetime | about 30 seconds | Page read; whether it is single use is not stated: UNVERIFIED |
| Token lifetime | not stated | UNVERIFIED (we read `expires_at` from `debug_token`) |
| `register` for a coexistence number | not stated; we do not call it | UNVERIFIED |
| `messaging_limit_tier` on the number | not named on the phone-number page; `readMessagingLimit` already used it | UNVERIFIED |

## 2b. Independent review: what it found and what is left as it is

Fixed: the webhook check passing on someone else's subscription; a failed row claiming another business's number id; a manual row that failed blocking Embedded Signup; a stale `token_expires_at` kept on a retry (now cleared when Meta does not say); the env test depending on the shell. Not fixed, known limits (all need a real account to settle):

1. `coexistence` comes from the browser and is not checked against Meta before `register` runs. A wrong `false` for a shared number would register it with our pin, which may cut the phone app off. The live test should read the number's `platform_type` first.
2. If the exchange works and a later step fails (Meta not answering the read, a database error), the code is spent, our app may already be subscribed and the number may already be registered with our pin, and nothing is saved. The person starts the sign-in again. Nothing records the attempt.
3. Two requests at once for one new number can both pass the number check and both exchange a code; one then loses on the unique `phone_number_id` (`conflict`) or on Meta refusing a second use of the code. Two retries of one failed row can send two `whatsapp/connected` events with different ids; the template submission must be idempotent per connection.

## 3. Follow-ups, not in this PR

1. The manual path does not send `whatsapp/connected` (the handover says every path does). A small follow-up: send it from `connectManual` after an active save, same id rule.
2. `connection-health` and `token-expiry` only look at `manual_byo` connections (`HEALTH_METHODS`); an `embedded_signup` connection is covered only by a recheck until they are widened.
3. The assisted link and `/connect/:token` (PR 3). Dev 3's connect page already posts `connectToken` with no bearer token; this route refuses `connectToken` today.
4. The cancel route (`/embedded-signup/cancel`) and template submission.
5. A finish with no phone number: we could read the account's numbers and take the single one. Not done; needs a real account to see what Meta sends.
