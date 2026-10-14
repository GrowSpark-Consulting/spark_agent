# Shared types (`@pakka/types`)

Owner: all three developers (shared package). First contracts written by Dev 1 in PR #8.
Related: [handover.md](handover.md) (the specs these schemas come from) ·
[frontend-architecture-map.md](frontend-architecture-map.md) ·
[whatsapp-webhook-parser.md](whatsapp-webhook-parser.md) (parser-local types)

## 1. What this is

`@pakka/types` (`packages/types`) holds the shared contracts as **Zod schemas plus the TypeScript
types inferred from them**. Each contract is written once, as a schema; the type is
`z.infer<typeof Schema>`. Backend, frontend and tests import the same schema, so a payload that
passes validation always has the matching type.

It ships TypeScript source (`"exports": {".": "./src/index.ts"}`), with no build step. Next.js
compiles workspace packages itself, and Vitest reads the source directly.

| File | Contents |
|---|---|
| `src/whatsapp.ts` | `E164`, `InboundMessageType`, `InboundMessage`, `DeliveryStatus`, `StatusUpdate`, `SendResult`; dashboard API bodies: `PhoneInput`, `SendTestMessageInput`, `SendTestMessageResult`, `TemplateButton`, `CreateTemplateInput`, `CreateTemplateResult`, `templateVariables` |
| `src/errors.ts` | `ERROR_CODES`, `ErrorCode`, `ApiErrorBody` (the error envelope), `redactSecrets`, `containsSecret` |
| `src/tenancy.ts` | `Role`, `TenantRow`, `MembershipWithTenant`, `TenantContext` (the signed-in user's business) |
| `src/agent.ts` | `HandoffTrigger`, `Extraction` (step 4), `NextAction` (step 5) |
| `src/connection.ts` | `ConnectionMethod`, `TokenType`, `ConnectionStatus`, `WhatsAppConnectionPublic`, `ManualConnectInput` |
| `src/pack.ts` | `PackDefinition` and its parts: `PackField`, `PackFieldType`, `ScoringRule`, `HardFail`, `Scoring`, `PackReminder`, `BookingMode`, `PackCatalog` |
| `src/index.ts` | Re-exports all of the above |

### Deliberately not in it

| Left out | Where it lives | Why |
|---|---|---|
| `ChannelAdapter` interface | `backend/src/channels` | It uses `Request` and is only implemented in backend |
| `OutsideWindowError` | `backend/src/channels` | An error class of the adapter, not a data contract |
| Secret-bearing connection rows (`token_enc`, `app_secret_enc`) | `backend` only | The frontend must never be able to import a type that has secret columns |
| Anything used by one workspace only | That workspace | This package is for shapes used by more than one |

## 2. How to use it

**Add the dependency only in the workspace that first imports it**, and in the same PR:

```bash
pnpm --filter @pakka/backend add @pakka/types@workspace:*
pnpm --filter @pakka/frontend add @pakka/types@workspace:*
```

Today nothing depends on it yet. Use `pnpm --filter ... add`, not `pnpm update`, and check that
`pnpm-lock.yaml` changes only in that workspace's importer block.

```ts
import { InboundMessage, NextAction, type StatusUpdate } from "@pakka/types";

const msg = InboundMessage.parse(candidate); // throws ZodError on bad input
const result = NextAction.safeParse(raw);    // { success, data | error }
```

Tests (from the repo root, or inside the package):

```bash
pnpm --filter @pakka/types test        # vitest run
pnpm --filter @pakka/types typecheck
```

`packages/types` has no lint script or eslint config yet.

## 3. Schema reference

| Schema | File | Key rules |
|---|---|---|
| `E164` | whatsapp | `^\+[1-9]\d{7,14}$`: leading `+`, 8 to 15 digits, no spaces |
| `InboundMessage` | whatsapp | `tenantId` and `channelId` are UUID-shaped (any 8-4-4-4-12 hex, not strict RFC versions); `providerMsgId` non-empty; `from` is E.164; `type` is text, interactive, image, audio, location or document; `timestamp` is an ISO datetime (offset allowed); `contactName`, `text`, `buttonId`, `media {id, mime}` and `routeCode` optional |
| `StatusUpdate` | whatsapp | `status` is sent, delivered, read or failed; ISO `timestamp`; optional E.164 `recipient`; optional `error {code: int, message}` |
| `SendResult` | whatsapp | `{ providerMsgId }`, non-empty |
| `PhoneInput` | whatsapp | `E164` as a person types it: trimmed first, with a message written for them |
| `SendTestMessageInput` | whatsapp | `to` is `PhoneInput`; `body` trimmed, 1 to 4096 characters |
| `SendTestMessageResult` | whatsapp | `SendResult` plus `status: "accepted"`. Delivery arrives later as a `StatusUpdate` through the webhook |
| `TemplateButton` | whatsapp | Union on `type`: `{ type: "quick_reply", text }`, `{ type: "url", text, url }` (http or https), `{ type: "phone_number", text, phoneNumber }` (`PhoneInput`); `text` 1 to 25 characters |
| `CreateTemplateInput` | whatsapp | `name` lowercase snake_case ending `_v<n>`; `category` utility or marketing; `language` en or ta; `body` 1 to 1024 characters, variables `{{1}}`, `{{2}}` … numbered in order, not at the start or end; `examples` one non-empty sample per variable, in order; optional `header` and `footer` (text, 1 to 60 characters); optional `buttons`, at most 3; optional `connectionId` (UUID-shaped) |
| `CreateTemplateResult` | whatsapp | `{ id, name, language, status }`; `status` is `pending` (submitted to Meta, awaiting review) or `draft` (saved, not submitted) |
| `ApiErrorBody` | errors | `{ error: { code, message, fields? } }`; `code` is one of `ERROR_CODES` (section 9); `fields` maps an input field to its message |
| `HandoffTrigger` | agent | Core enum: asked_human, complaint, negotiation, hot_lead, kb_gap, stuck, credits_exhausted |
| `Extraction` | agent | `language` en, ta, ta-en, ml, hi or other; `intent` one of the 11 in the handover; `fields` is a record of string to string, number or boolean; `question` and `preferredTime` are nullable but required; `sentiment` positive, neutral, negative or angry; `asksIfHuman` boolean; `confidence` 0 to 1 |
| `NextAction` | agent | Union discriminated on `kind`: answer_and_ask, ask_fields, offer_slots, confirm_booking, reschedule, cancel, handoff, decline_off_topic, close_disqualified, opt_out_ack. `answer_and_ask` allows at most 2 `askFields` (0 is fine); `ask_fields` needs at least 1; `handoff.trigger` is a `HandoffTrigger` |
| `WhatsAppConnectionPublic` | connection | One row of `whatsapp_connections_public`, snake_case. Secret columns are not in the schema, so Zod strips them if a full row is parsed |
| `ManualConnectInput` | connection | Admin form body (camelCase): `tenantId` UUID-shaped, `wabaId`, `phoneNumberId`, `token`, `tokenType` (business or system_user) and `appSecret` all required and non-empty; `displayPhone` and `clientBusinessId` optional |
| `PackDefinition` | pack | `key` lower kebab-case; `version` integer of at least 1; `fields` non-empty; `scoring` required; `bookingType` and `bookingModes` both optional; the lists below default to `[]` |
| `PackField` | pack | `key` lower snake_case; type text, int, boolean, enum, range_inr or date_range_or_month; `enum` needs `options`; `required` defaults to false |
| `ScoringRule` | pack | **Strict object** (unknown keys fail). Needs one of `match`, `equals`, `in` or `gte`; `points` is an integer of at least 0; optional `value` for `match` |
| `HardFail` | pack | **Strict object**. Needs `below` or `match` |
| `Scoring` | pack | `thresholds` is strict, `hot` must be greater than `warm`; `hardFails` defaults to `[]` |
| `PackReminder` | pack | **Strict object**. `anchor` is start, end or quote_sent; `offset` matches `^[+-]\d+[mhd]$` (`-30m`, `+2d`); optional `feature`. `feedback` reuses this shape |
| `BookingMode` | pack | slot, site_visit, field_visit, callback, date_range or quote |
| `PackCatalog` | pack | **Strict object**: `type`, `attributes[]`, `matchOn[]` |

`PackDefinition` lists that default to `[]`: `reminders`, `handoffTriggers`, `templates`,
`kbStarter`, `extraGuardrails`.

## 4. Choices where handover.md was silent

- **`StatusUpdate` and `SendResult` are new shapes.** The handover names them without defining them.
- **ISO timestamps.** `InboundMessage.timestamp` must be an ISO datetime; Meta sends unix seconds, so the parser converts.
- **UUID-shaped ids.** `tenantId`, `channelId` and the connection ids are checked with `z.guid()` (any 8-4-4-4-12 hex), not `z.uuid()`, which also checks the version and variant digits and so rejects the seeded ids such as `d0000000-0000-0000-0000-000000000001`.
- **`HandoffTrigger` is a core enum, but a pack's `handoffTriggers` is a plain string list.** Pack-specific triggers such as `group_above_15` therefore parse. The pipeline owns what to do with an unknown pack trigger.
- **`Extraction.fields` is generic.** Checking its keys against the pack's field schema is the loader's or pipeline's job.
- **`NextAction` limits.** The "max 2 fields" comment in the handover is applied to `answer_and_ask` only. `ask_fields` needs at least 1.
- **New `boolean` pack field type.** Not in the handover's field types; added because the real-estate scoring rule `decision_maker equals true` implies one.
- **Strict scoring, hard-fail, reminder, threshold and catalog objects.** A typo such as `eqauls` fails instead of being silently dropped.
- **Both `bookingType` and `bookingModes` are accepted**, both optional (see section 7).
- **Scoring fields are not cross-checked against `fields`** in the schema. That check belongs to the loader.
- **`WhatsAppConnectionPublic` is snake_case** to match the database view; `ManualConnectInput` is camelCase because it is an API body.
- **`last_check` is `record<string, unknown>`**, because the handover does not fix its shape.
- **`E164` requires a leading `+`.**

## 5. What each developer must follow

**Dev 1 (agent and WhatsApp)**
- The Meta parser normalises raw numbers (Meta sends digits without `+`) to E.164 *before* building an `InboundMessage`, and converts timestamps to ISO.
- The pack loader validates every pack with `PackDefinition`. It derives `bookingModes` from `bookingType` and logs a warning, and it warns when a scoring rule names a field the pack does not declare. (Agreed plan; the loader is not written yet.)
- Validate every LLM output with `Extraction` and every decided action with `NextAction`.

**Dev 2 (booking, jobs, money)**
- Use these shapes for anything that crosses a module boundary, for example `InboundMessage` in `whatsapp/message.received` events, `StatusUpdate` for delivery statuses, `SendResult` for sends. Do not redefine them locally.
- If you need a field added, open a PR here (section 6) rather than extending a copy.

**Dev 3 (dashboard and onboarding)**
- Screens read connections through `WhatsAppConnectionPublic` only.
- `ManualConnectInput` carries a token and an app secret: post it once to the server, never keep it in client state or localStorage, and never echo it back into the UI.
- Never import or recreate a type with `token_enc` or `app_secret_enc`.

## 6. Changing a contract

1. Any change to `packages/types` goes through a pull request; never edit a copy elsewhere.
2. Tag Dev 2 and Dev 3 in the PR (all three own this package), and say which shapes changed.
3. Keep changes backward compatible where possible: add optional fields and new enum values rather than renaming or removing. A breaking change needs every consumer updated in the same PR or an agreed follow-up.
4. Add or update tests in the same PR. `pnpm lint`, `pnpm typecheck` and `pnpm test` must pass.
5. If the change alters a contract in [handover.md](handover.md), update that file in the same PR.
6. Lockfile changes stay inside the importer blocks of the workspaces whose dependencies you changed.

## 7. Open questions for Raja

| Question | Why it matters |
|---|---|
| Is `bookingType` (real-estate example in the handover) or `bookingModes` (tours-travel example) the canonical pack key? | The schema accepts both for now; the loader will derive modes and warn until this is decided |
| Add `decision_maker` to the real-estate `fields`? | The handover's real-estate scoring rule uses `decision_maker`, but the field list does not declare it |

## 8. Status

**Day 1, task 1: done** (PR #8, merged to `main`). 12 files: the four schema modules, `index.ts`, four
test files, `vitest.config.mts`, `package.json` and `pnpm-lock.yaml` (7 lines, `packages/types`
importer only). 51 Vitest tests in `packages/types`; lint, typecheck and test pass across all
workspaces.

**Next (Dev 1, Day 1):** env change (`META_GRAPH_API_VERSION`) and the AES-256-GCM crypto helper;
synthetic webhook fixtures; the parser and HMAC signature check; the webhook route; the
test-number connection seed script; adapter `sendText` and `markRead`; the pack loader in
`backend/src/agent/packs/`. The first of these to import `@pakka/types` adds the dependency in its
own workspace.

## 9. Send-test-message, create-template and errors

Written by Dev 3 for the two Meta App Review screens (PR #15), then agreed: request and response
shapes and error codes by Dev 1 (review of PR #15), backend behaviour by Dev 2 (Shaaz), and recorded
in [contracts.md](contracts.md) (Day 1 freeze). Everything here is in `packages/types/src` and
re-exported from the package index.

| Route | Who | Request | Result |
|---|---|---|---|
| `POST /api/messages/test` | Owner, admin | `SendTestMessageInput` | `SendTestMessageResult`: `{ providerMsgId, status: "accepted" }` |
| `POST /api/templates` | Owner, admin | `CreateTemplateInput` | `CreateTemplateResult`: `{ id, name, language, status: "pending" \| "draft" }` |

Both routes resolve the tenant from the session, never from the body.

### `POST /api/messages/test` (behaviour agreed by Dev 2)

- Sent through `notify.send` with `kind: "test_message"`, for 0 credits.
- Free text only inside the recipient's 24-hour window; outside it the route answers `outside_window` (409).
- Recorded in `messages` (`direction = 'out'`, `sender = 'staff'`, `credits_charged = 0`, `provider_msg_id`;
  the contact is found or created for the number and tagged `test`) and in `audit_logs` (`action = 'test_message.sent'`, actor = the staff user's id).
- At most 10 test messages per business per rolling hour, counted from `audit_logs`; the next one
  answers `rate_limited` (429).
- `"accepted"` means Meta took the message. Delivery arrives later as a `StatusUpdate` through the webhook.

### `POST /api/templates` (behaviour agreed by Dev 2)

- The source of truth is `public.whatsapp_templates`: `id`, `tenant_id`, `connection_id`, `name`,
  `language`, `category`, `components`, `status`, `rejection_reason`, `meta_template_id`, `updated_at`.
  `status` is `draft`, `pending`, `approved`, `rejected`, `paused` or `disabled`. Unique on
  `(connection_id, name, language)`; a duplicate answers `conflict` (409).
- The create flow submits to Meta, then inserts the row as `pending`. The template-status webhook updates
  `status` through Dev 2's `set_template_status(...)`.
- Without `connectionId`, the backend uses the tenant's only active connection.
- The create screen shows only the `pending` or `draft` it is given; it does not derive any other status.

### Names

| Name | File | What it is |
|---|---|---|
| `PhoneInput` | `whatsapp.ts` | `E164` as typed into a form: trimmed, E.164 with a leading `+`, with a user-readable error |
| `WHATSAPP_TEXT_MAX` | `whatsapp.ts` | 4096, the text body limit used by the test message (Meta's limit: unconfirmed) |
| `SendTestMessageInput` | `whatsapp.ts` | Zod: `to` (`PhoneInput`), `body` (trimmed, 1 to 4096 characters) |
| `SendTestMessageResult` | `whatsapp.ts` | TypeScript interface: `SendResult` plus `status: "accepted"` |
| `TEMPLATE_CATEGORIES`, `TEMPLATE_LANGUAGES`, `TEMPLATE_BODY_MAX` | `whatsapp.ts` | `utility` or `marketing`; `en` or `ta`; 1024 |
| `TEMPLATE_HEADER_MAX`, `TEMPLATE_FOOTER_MAX`, `TEMPLATE_BUTTON_TEXT_MAX`, `TEMPLATE_BUTTONS_MAX` | `whatsapp.ts` | 60, 60, 25 and 3 (Meta, confirmed below) |
| `templateVariables(body)` | `whatsapp.ts` | Distinct `{{n}}` numbers in a body, sorted |
| `TemplateButton` | `whatsapp.ts` | Zod union on `type`: `quick_reply { text }`, `url { text, url }`, `phone_number { text, phoneNumber }` |
| `CreateTemplateInput` | `whatsapp.ts` | Zod: `name` (`^[a-z][a-z0-9_]*_v[1-9]\d*$`, max 512), `category`, `language`, `body` (1 to 1024), `examples` (non-empty strings), optional `header`, `footer`, `buttons` (at most 3) and `connectionId`. Variables must be numbered `{{1}}`, `{{2}}`, …, may not open or close the body, and `examples` needs exactly one per variable, in order |
| `CreateTemplateResult` | `whatsapp.ts` | TypeScript interface: `{ id, name, language, status: "pending" \| "draft" }` |
| `ERROR_CODES`, `ErrorCode` | `errors.ts` | The codes in the table below |
| `ApiErrorBody` | `errors.ts` | Zod for every API error: `{ error: { code, message, fields? } }`. `fields` (messages keyed by input field) is an addition to the handover's `{ code, message }` |
| `redactSecrets`, `containsSecret` | `errors.ts` | Strip or detect credentials (connection-string passwords, JWTs, Supabase keys, Meta `EAA…` tokens, bearer headers, Anthropic `sk-ant-` keys, and any other run of 32+ key characters that is not a UUID) before logging or showing text. Phone numbers are not credentials and are not removed here (what the dashboard shows depends on it); the backend's log lines also mask them (`backend/src/lib/redact.ts` `redactForLog`), and an unexpected error is logged by its name and code only (`errorKind`, Day 7) |

### Error codes

| Code | HTTP | Code | HTTP |
|---|---|---|---|
| `unauthenticated` | 401 | `outside_window` | 409 |
| `forbidden` | 403 | `conflict` | 409 |
| `not_found` | 404 | `rate_limited` | 429 |
| `validation_failed` | 422 | `insufficient_credits` | 402 |
| `no_membership` | 403 | `slot_taken` | 409 |
| `whatsapp_not_connected` | 409 | `plan_required` | 403 |
| `not_available` | 501 | `seat_limit` | 409 |
| `upstream_failed` | 502 | `internal` | 500 |

**The HTTP status for each code, and `AppError`, live in `backend/src/lib/errors.ts`, not in this package.**
The status map is an exhaustive record, so a new code needs an entry there and a title in `frontend/lib/errors.ts`.

### Built today

`whatsapp_templates` and `set_template_status` exist (migration 0007, #21). `notify.send`, the adapter's
`sendText` and Meta template submission do not yet. Until they do, both routes validate the request and
the role, then answer `whatsapp_not_connected` (no active connection) or `not_available`: nothing is sent,
recorded or submitted. The table's `category` also allows `authentication`; `CreateTemplateInput` offers
only `utility` and `marketing`.

### Written into the schema where the agreement didn't say

The `url` button takes http or https only; `phoneNumber` is E.164 (`PhoneInput`); `connectionId` is
UUID-shaped like `WhatsAppConnectionPublic.id`; `header` and `footer` are plain text. The start/end rule
comes from Dev 1's review; Meta's other placement rules are unconfirmed and not checked.

### Not reconciled with [dashboard-screen-contracts.md](dashboard-screen-contracts.md)

That file is a proposal and was not changed here:

- Its error list has no `rate_limited`, `no_membership`, `whatsapp_not_connected`, `not_available` or
  `internal`, and its envelope has no `fields`.
- Its `Template` has `variables: { tag, name, sample }[]`, buttons typed `'Quick reply' | 'URL' | 'Phone'`
  and statuses `'Not added' | 'Draft' | 'In review' | 'Approved' | 'Rejected'`. The agreed contract uses
  `examples: string[]`, `quick_reply | url | phone_number` and the six `whatsapp_templates` statuses.

### Open questions

For Dev 2: is template creation done in the request or in a job? What does `POST /api/templates` answer
when `connectionId` is left out and the tenant has more than one active connection? When does the create
route return `draft` rather than `pending`?
For Dev 1: `sendTemplate(to, name, lang, params)` in the handover has no button parameters; a URL button
can take one variable at the end, which `TemplateButton` does not model yet.
Not adopted: a template variant of the test message for recipients outside the 24-hour window.

Meta details **unconfirmed** (not shown on the pages read): the error code for sending outside the 24-hour
window (`131047` is from memory), Meta's error JSON shape, whether `example.body_text` is a flat list or a
list of lists, the rules for variable placement and ratio, which button mixes and orders are allowed, the
4096 text limit, `AUTHENTICATION` as a category, and the full list of language codes.
Confirmed on Meta's pages: names are lowercase letters, digits and underscores (max 512), a name is unique
per language per account (duplicate: error `100`, subcode `2388024`), body max 1024, header text max 60,
footer max 60, button text max 25, and a URL button takes one variable at the end.
