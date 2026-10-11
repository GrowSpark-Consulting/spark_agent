# WhatsApp connection and KB upload: contract for Dev 3

Owner: Dev 1 (Nithisha). For: Dev 3 (Dhatri), who builds the UI against it. Status: **PROPOSED**, nothing
here is built or agreed. It becomes agreed through a review by Shaaz (Dev 2) and Dhatri, and through the open
decisions below. [contracts.md](contracts.md) is the freeze doc and is not edited by this file; Shaaz links
this file from it in his own PR.

Sources: [handover.md](handover.md) module 10 and the endpoints table, `supabase/migrations/0003`,
`packages/types/src/connection.ts`, `backend/src/server/routes.ts`, `backend/src/lib/errors.ts`.

**Secrets rule.** `token_enc` and `app_secret_enc` never appear in any response, log or example. The dashboard
reads `whatsapp_connections_public`. Examples below use placeholders only.

## Open decisions (owner)

| # | Decision | Owner | Dev 1's suggestion |
|---|---|---|---|
| 1 | **Platform admin.** The repo has only tenant roles (`owner`, `admin`, `staff` in `memberships`); nothing identifies someone who works for us across businesses. Endpoints marked "requires platform admin (mechanism TBD)" wait on this. Options: (a) a `platform_admins` table, (b) a Supabase auth claim, (c) an env allowlist of user ids. | Shaaz + Raja | (a): auditable, and fits `connected_by = 'admin:<id>'`. |
| 2 | **Public connect-link route.** `GET /api/connect-links/:token` has no bearer token, so it needs `browser: true` (CORS, origin check) with no auth. That is a router change in `backend/src/server/`. | Shaaz | Add it as a route that skips `authenticate`, with a rate limit. |
| 3 | **Connect-link token storage.** `connect_links.token` is the primary key and holds the raw token today. Wording of this contract: the raw token only appears in the URL; storage TBD. | Shaaz | Store a hash and look it up by hash (a future migration). |
| 4 | **Embedded Signup gate.** Embedded Signup and the assisted link wait for Meta App Review. | Shaaz + Raja | A platform env flag `EMBEDDED_SIGNUP_ENABLED`; while off, the routes answer `not_available`. This PR does not touch the env schema or `.env.example`. |
| 5 | **Live status for the admin.** The handover has the admin watching the checks live. `whatsapp_connections` is not in the Realtime publication (0010 covers messages, conversations, handoffs; 0011 covers `kb_documents`). | Shaaz | Add it in a migration, or poll the view while `status = 'validating'`. |
| 6 | **Roles on recheck and disconnect.** Owner and admin of the business, and platform admin. Confirm that `staff` may not. | Raja | As written. |

## Differences from the first proposal

1. **Error codes:** only the existing `ERROR_CODES` and the statuses in `backend/src/lib/errors.ts`. No new
   codes. The proposal's `VALIDATION_ERROR`, `FORBIDDEN`, `CONFLICT`, `LINK_EXPIRED`, `LINK_USED`,
   `META_ERROR`, `FILE_TOO_LARGE`, `UNSUPPORTED_TYPE`, `FEATURE_DISABLED` become `validation_failed` (422, not
   400), `forbidden`, `conflict`, `not_found` (an expired or used link, no "gone" code), `upstream_failed`
   (502), `validation_failed` with `fields.file`, and `not_available` (501).
2. **One connection shape:** every route returns the same snake_case shape as `whatsapp_connections_public`
   (`WhatsAppConnectionPublic` in `@pakka/types`). The proposal's camelCase connection object is dropped.
   Other bodies (`{ url, expiresAt }`, request bodies) stay camelCase, as the rest of the API does.
3. **`last_check`** is never null: `{}` means "never checked". The structured shape below is new.
4. **Manual connect body** is the existing `ManualConnectInput` (`token`, `tokenType`, `appSecret`, ...), not
   `accessToken`.
5. **KB:** not copied; this file links to [contracts.md](contracts.md) section 9. The JSON `manual` upload is
   dropped (FAQs already cover it). KB writes are owner and admin, not staff.
6. **Owner:** the handover's endpoints table lists embedded-signup under Dev 3, and module 10 lists Dev 1 for
   the backend. The agreed owner of every endpoint here is **Dev 1**; Dev 3 builds the UI.
7. **Platform admin, the public connect-link route, the Embedded Signup gate and Realtime on connections** are
   open decisions (above), not settled behaviour.

## How requests are made

Routes live on the Railway API at `${NEXT_PUBLIC_API_URL}/api/...`. A signed-in call sends
`Authorization: Bearer <Supabase access token>` and `X-Pakka-Tenant: <tenantId>`; the tenant is never taken
from the body, except where an endpoint below says it names another business (platform admin only). Errors are
always `{ error: { code, message, fields? } }`.

**For Dev 3:** every connection endpoint below is `GET` or `POST`, so `frontend/lib/api/client.ts` needs no
change for them. (The KB routes include `PATCH` and `DELETE`; that is separate.)

## Build order

(a) webhook POST (Meta only, no frontend contract; the inbox sees the rows through Realtime), (b) manual connect
with the validation checks, (c) recheck, (d) disconnect, (e) connect-link create and validate, (f) Embedded
Signup exchange. (e) and (f) answer `not_available` until open decision 4 is settled and Meta App Review passes.

## The connection (one shape everywhere)

Read the list with the Supabase client from `whatsapp_connections_public` (RLS); there is no list endpoint.
Every route that returns a connection returns this shape, parsed with `WhatsAppConnectionPublic`:

```json
{
  "id": "<uuid>",
  "tenant_id": "<uuid>",
  "method": "embedded_signup | assisted | manual_byo | platform",
  "waba_id": "<string>",
  "phone_number_id": "<string>",
  "display_phone": "<string | null>",
  "verified_name": "<string | null>",
  "coexistence": false,
  "status": "pending | validating | active | failed | disconnected",
  "last_check": {},
  "quality_rating": "<string | null>",
  "messaging_limit": "<string | null>",
  "created_at": "<ISO 8601>"
}
```

`last_check` is never null. `{}` means "never checked".

`method = 'platform'` (migration 0014, **Fixed**): one of our own test or demo numbers in our own Meta app,
signed with `META_APP_SECRET`. It is created only by the seed script (`pnpm seed:connection`), never through
an endpoint here, so no endpoint above accepts or returns it except the connection reads. A client-facing screen
should label it "Spark Agent number" and offer no disconnect or recheck for it.

### `last_check` (PROPOSED / NEW)

The structured shape is new; today the type is a free record. The Zod type is added in Dev 1's implementation
PR, not in this one.

```json
{
  "ran_at": "<ISO 8601>",
  "overall": "pass | warn | fail",
  "checks": [
    { "key": "token_permissions", "status": "pass", "message": "<safe for the UI>", "checked_at": "<ISO 8601>" }
  ]
}
```

- `status` of a check: `pass | warn | fail | not_verified | skipped`.
- `key`, in this order: `token_permissions`, `number_registered`, `webhook_subscribed`,
  `display_name_approved`, `payment_method`, `test_message_delivered`.
- `payment_method` is only `pass` or `warn`; the connection still goes active (templates won't send).
- `overall` is `fail` if any check fails; `warn` if none fail but any is `warn` or `not_verified`; else `pass`.
- `message` is safe for the UI: no tokens, secrets or raw Meta error bodies.
- Connection `status` after the checks: `active` unless `overall` is `fail`, then `failed`.

## Endpoints

### Admin: manual connection

`POST /api/admin/whatsapp/manual`, **requires platform admin (mechanism TBD)**.

- Body: `ManualConnectInput` exactly, with `tenantId` naming the business:
  `{ tenantId, wabaId, phoneNumberId, token, tokenType, appSecret, displayPhone?, clientBusinessId? }`.
  Post it once; never keep or echo the secrets.

  ```json
  { "tenantId": "<uuid>", "wabaId": "<waba id>", "phoneNumberId": "<phone number id>",
    "token": "<system-user token>", "tokenType": "system_user", "appSecret": "<app secret>" }
  ```
- 201: the connection, `status` `active` or `failed`, with `last_check`.
- Errors: `validation_failed` (422, with `fields`), `unauthenticated` (401), `forbidden` (403, not a platform
  admin), `not_found` (404, no such business), `conflict` (409, `phoneNumberId` is already connected),
  `upstream_failed` (502, Meta could not be reached).

### Added with the onboarding "own Meta app" flow (not yet reviewed by Shaaz and Raja)

Built for the wizard's "Use my own Meta app" path; they go beyond the admin-only route above and need sign-off.

- `GET /api/whatsapp/webhook-config`, owner or admin, business from the token + `X-Pakka-Tenant`. 200
  `{ webhookUrl, verifyToken, partnerBusinessId }`. `verifyToken` is this business's own token (created on first
  call, migration 0020; stored as a SHA-256 plus an encrypted copy). It is never the platform-wide
  `META_WEBHOOK_VERIFY_TOKEN`. `not_available` (501) while `API_PUBLIC_URL` is unset; `forbidden` for staff.
- `POST /api/whatsapp/manual`, owner or admin. Same body as `ManualConnectInput` without `tenantId` (the business
  is the caller's own; a `tenantId` in the body is overwritten). 201 the connection (`manual_byo`, `active` or
  `failed`, with `last_check`). Same errors as the admin route. Secrets are encrypted and never returned.
- `POST /api/admin/whatsapp/manual` (platform admin) now exists and shares the same service.
- Meta's GET handshake accepts the platform token or any business's own verify token. A POST signed with a
  `manual_byo` connection's own app secret is accepted for that connection's numbers only.
- `last_check` for a manual connection has all six checks (Day 5): `token_permissions` (both WhatsApp permissions, via `debug_token`), `number_registered` (in the account and on the Cloud API), `webhook_subscribed` (an app is subscribed and, for `manual_byo`, a webhook signed with the connection's own app secret has arrived; until then `not_verified`), `display_name_approved`, `payment_method` (`warn` when missing) and `test_message_delivered` (a `test_message` to the owner's number through `notify.send`, run once the number is active; `not_verified` if the owner has not written to the number in 24 hours; it never changes the status). A check Meta does not answer is `not_verified`. All of it is UNVERIFIED against a live account.

### Recheck and disconnect

- `POST /api/whatsapp/connections/:id/recheck`, no body. Owner or admin of the business that owns the
  connection, or platform admin (mechanism TBD). 200: the connection with a new `last_check`.
- `POST /api/whatsapp/connections/:id/disconnect`, no body. Same roles. 200: the connection with `status`
  `disconnected`; the AI is paused for that number.
- Errors: `unauthenticated`, `forbidden` (staff, or another business's connection), `not_found`,
  `upstream_failed` (502).

### Assisted connect link

- `POST /api/admin/whatsapp/connect-link`, **requires platform admin (mechanism TBD)**. Body `{ tenantId }`.
  201 `{ url, expiresAt }`: valid 24 hours, single use. The raw token only appears in the URL; storage TBD
  (open decision 3). Errors: `validation_failed`, `forbidden`, `not_found` (no such business),
  `not_available` while open decision 4 is off.
- `GET /api/connect-links/:token`, **public, no bearer token** (open decision 2), for the `/connect/:token`
  page. 200 `{ tenantName, expiresAt }`. An unknown, expired or used link is `not_found` (404). `not_available`
  while open decision 4 is off.

### Embedded Signup exchange

`POST /api/onboarding/whatsapp/embedded-signup`

- Auth, one of: owner or admin with `X-Pakka-Tenant`, **or** the assisted flow with `connectToken` in the body
  and no bearer token.
- Body: `{ code, wabaId, phoneNumberId, coexistence: boolean, connectToken?: string }`. `code` is the
  `FB.login` `authResponse.code`; `wabaId` and `phoneNumberId` come from the `WA_EMBEDDED_SIGNUP` `FINISH`
  message event.
- 201: the connection. Errors: `validation_failed`, `unauthenticated`, `forbidden`, `not_found` (a bad, expired
  or used `connectToken`), `conflict` (the number is already connected), `upstream_failed` (502, a Meta failure;
  a safe message only), `not_available` (501) while open decision 4 is off.

`POST /api/onboarding/whatsapp/embedded-signup/cancel` (optional, same auth). Body
`{ currentStep: string, connectToken?: string }`. 204. Logged for the admin.

> **Unverified, to check before implementation.** Every Graph API call, and the fields of the
> `WA_EMBEDDED_SIGNUP` event, must be re-checked against Meta's documentation for the pinned Graph version
> (`META_GRAPH_API_VERSION`). Embedded Signup is believed to be at v4, with v2 deprecated on 15 October 2026;
> this has not been confirmed from Meta's pages.

## KB upload

Not repeated here; the single source of truth is [contracts.md](contracts.md) section 9. In short:
`POST /api/kb/documents`, multipart `file` (+ optional `title`), pdf, docx, txt or md, 5 MB maximum,
answers `202 { id, title, sourceType: 'upload', status: 'processing', createdAt }`, for owner and admin. Errors
are `validation_failed` with `fields.file` for too-large and unsupported files.

## What Dev 3 does NOT need

- The webhook POST (`/api/webhooks/whatsapp`, Meta only). The inbox sees new rows through Realtime.
- Token storage or encryption: tokens and app secrets stay on the server, encrypted in `whatsapp_connections`.
- Any Graph API call. The dashboard only calls the routes above and reads `whatsapp_connections_public`.

## What Dev 3 builds

The "Connect WhatsApp" wizard step and the `/connect/:token` page (the Facebook JS SDK and `FB.login`, the
`WA_EMBEDDED_SIGNUP` listener, then a call to the exchange route), the status panel from `last_check`, and the
admin panel (connection list, connect-link generator, manual form). The current placeholder
(`whatsapp-connection-panel.tsx`) stays disabled until the routes exist.
