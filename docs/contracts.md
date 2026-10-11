# Contracts — Spark Agent

The contracts between the three areas: schema, shared types, function signatures, events, API
routes and error codes (9-day plan, section 3). Each item is marked:

- **Fixed:** in the handover, a merged migration or a merged PR.
- **Agreed:** decided between the owners and waiting to be built; changing it needs a PR all three see.
- **Proposed:** to be decided in the freeze meeting.

Shapes of shared types are documented in `docs/shared-types.md`; specs in `docs/handover.md`;
screen-level contracts in `docs/dashboard-screen-contracts.md`; WhatsApp connection routes in
[whatsapp-connection-contract.md](whatsapp-connection-contract.md) (Proposed, decision 15).

## 1. Schema

**Fixed (merged and applied to staging)**

| Migration | Contents |
|---|---|
| `0001_init` | 21 core tables, RLS on every table, `is_member()`, tenant indexes |
| `0002_packs_and_bookings` | Pack versions `(key, version)`, generic bookings (`kind`, `details`, optional `resource_id`), `catalog_items`, `quotes`, member write policies |
| `0003_whatsapp_connections_and_consent` | `whatsapp_connections`, `connect_links`, `consent_logs`, `whatsapp_connections_public` (security_invoker), `channels.credentials_enc` dropped |
| `0004_kb_vector_index` | HNSW `vector_cosine_ops` on `kb_chunks.embedding` |
| `0005_credit_functions` | `spend_credits`, `grant_credits`, `renew_plan_credits`, `credit_balance` (service_role only) |
| `0006_trial_signup` | `create_trial_tenant` (service_role only) |
| `0007_whatsapp_templates` | `whatsapp_templates`, `set_template_status` (service_role only) |
| `0008_credit_refunds` | `refund_credits(tenant, ref_id)`: returns a failed send's credits to the same buckets (service_role only) |
| `0009_notify_functions` | `notify_target`, `notify_template`, `notify_record`: the database side of `notify.send` (service_role only) |
| `0010_inbox_realtime` | `messages`, `conversations`, `handoffs` in the Realtime publication; `conversations.last_message_at` kept by a trigger |
| `0011_knowledge_base` | `kb_documents.status`/`error`/`body`, one FAQ per question, `kb_gaps`, `kb_documents` in Realtime, `match_kb_chunks` (section 9) |
| `0012_kb_gap_functions` | `kb_gaps.summary`/`answered_by`/`answered_at`, `record_kb_gap`, `answer_kb_gap` (service_role only, section 9) |
| `0013_inbound_messages` | `messages.kind`/`meta`, one open conversation per contact and channel, `store_inbound_message`, `apply_message_status` (service_role only; Dev 1, #50) |
| `0014_connection_method_platform` | `whatsapp_connections.method` may be `platform` (our own test and demo numbers; Dev 1, #51) |
| `0015_booking_engine` | `services.buffer_min`/`min_notice_min`, booking status `expired`, end after start, slot kinds need a resource, `hold_slot`, `confirm_booking`, `reschedule_booking`, `cancel_booking`, `release_expired_holds` (service_role only, section 4) |
| `0016_platform_admins_and_link_tokens` | `platform_admins` (server only), `connect_links.token` → `token_hash` (SHA-256 hex; existing links rehashed) |
| `0017_google_calendar` | `google_calendar_connections`: one per resource, refresh token encrypted, `status connected \| needs_reconnect`; members read everything but the token (section 6) |
| `0018_agent_merge_functions` | `merge_lead_fields`, `merge_message_agent_meta`: the agent's lead-field and message-meta merges (Dev 1, #65; service_role only) |
| `0019_notify_staff_target` | `notify_staff_target(tenantId, userId)`: a member's alert number as a contact tagged `staff` with a `human`-mode conversation (service_role only, section 2) |
| `0020_whatsapp_webhook_tokens` | One webhook verify token per business for a client's own Meta app: SHA-256 hash plus an encrypted copy, server only (Dev 3, #78) |
| `0021_consent_functions` | `record_notice_shown` and `record_opt_out` (service_role only): the contact update and the `consent_logs` row in one transaction, once (Dev 1; after 0019 `notify_staff_target` and 0020 `whatsapp_webhook_tokens`) |
| `0022_consent_model_intent` | `record_opt_out` also accepts the source `model_intent` (a clear request to stop read by the model; Dev 1, #69) |
| `0023_booking_resource_lock` | `hold_slot` and `reschedule_booking` take a per-resource advisory lock, so racing holds for one person queue and the losers get `slot_taken` (23P01) instead of a deadlock error (40P01) |

- `kb_chunks.embedding` is `vector(1024)`: Cohere `embed-multilingual-v3.0`, cosine distance (`<=>`).
  Retrieval filters by `tenant_id` and sets `hnsw.iterative_scan = relaxed_order`.
- Seed: `supabase/seed/` (plans, 21 features, demo and isolation-test businesses, services, resources, hours).
- Only the 0005 functions write `credit_ledger`.
- **Member writes from the browser** (everything else is read-only for members; server code writes):

| Table | Members can |
|---|---|
| `catalog_items` | read/write own tenant |
| `quotes` | read/write own tenant; lead and catalog item must be in the same tenant |
| `services`, `resources` | insert/update/delete own tenant |
| `leads` | update `stage`, `owner_user_id`, `outcome`, `fields` |
| `tenants` | update `name`, `timezone`, `business_hours`, `agent_settings` |
| `memberships` | update their own `whatsapp_phone`, `takeover_pref` |
| `consent_logs` | read and insert own tenant (no update or delete) |

**Agreed: template status table** (Dev 2 builds it as the next free migration):

```sql
create table public.whatsapp_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connection_id uuid not null references public.whatsapp_connections(id) on delete cascade,
  name text not null,                  -- versioned, e.g. reminder_24h_v1
  language text not null,              -- en, ta
  category text not null check (category in ('utility','marketing','authentication')),
  components jsonb not null,           -- body, examples, optional header, footer, up to 3 buttons
  status text not null default 'pending'
    check (status in ('draft','pending','approved','rejected','paused','disabled')),
  rejection_reason text,
  meta_template_id text unique,
  updated_at timestamptz not null default now(),
  unique (connection_id, name, language)
);
```

- RLS: members read their own tenant; only the server writes.
- Dev 2's `createTemplate` inserts the row as `pending` after Dev 1's adapter submits the template to Meta.
- Dev 1's webhook, on `message_template_status_update`, calls Dev 2's
  `set_template_status(meta_template_id, status, reason)`. It never writes the table directly.

**Built in 0011:** `match_kb_chunks(p_tenant_id, p_query vector(1024), p_k default 5)` →
`(chunk_id, document_id, title, content, similarity)`, most similar first, `similarity = 1 - cosine
distance`. Only the business's `ready` documents; `k` is clamped to 1–50. Security invoker,
`search_path = ''`, `hnsw.iterative_scan = relaxed_order` (re-sorted after the scan), executable by
`service_role` only. The similarity threshold is the caller's. Migration numbers go to whoever
merges first.

## 2. Shared types (`@pakka/types`)

**Fixed (#8, #12, #15):** `E164`, `PhoneInput`, `InboundMessage`, `StatusUpdate`, `SendResult`,
`Extraction`, `NextAction`, `HandoffTrigger`, the browser-safe connection types,
`PackDefinition`, `SendTestMessageInput`, `CreateTemplateInput`, `ERROR_CODES`, `ApiErrorBody`,
`redactSecrets`. Ids are validated with `z.guid()` (seeded ids are not RFC 9562). Secret-bearing row
types stay in `backend`. Shapes: `docs/shared-types.md`.

**Fixed (#23), applied in `@pakka/types`:**

- `SendTestMessageResult`: `{ providerMsgId, status: "accepted" }` (was `providerMessageId`, `"sent" | "queued"`).
  Delivery arrives later through the status webhook into `messages.delivery_status`.
- `CreateTemplateInput`: optional `header` (text), `footer`, up to 3 `buttons`
  (`quick_reply`, `url`, `phone_number`), optional `connectionId` (default: the business's only
  active connection).
- `CreateTemplateResult`: `{ id, name, language, status: "pending" | "draft" }`.
- `ERROR_CODES`: the additions in section 6.

**Proposed (Dev 2 adds them):**

```ts
type CreditReason =
  | 'plan_grant' | 'topup' | 'trial_grant' | 'ai_reply' | 'template_utility' | 'template_marketing'
  | 'staff_alert' | 'cycle_reset' | 'admin' | 'refund';          // 'refund' written only by refund_credits

type NotificationKind =               // decides toggle, template and credit cost
  | 'ai_reply' | 'consent_notice' | 'booking_confirmation' | 'reminder_24h' | 'reminder_2h'
  | 'followup_nudge' | 'noshow_rebooking' | 'feedback_request' | 'review_request'
  | 'handoff_customer_notice' | 'staff_alert' | 'lead_card' | 'daily_agenda'
  | 'trial_message' | 'credit_alert' | 'quote_sent' | 'quote_followup' | 'pretrip_info'
  | 'staff_reply' | 'test_message' | 'system_notice';

type SendOutcome =
  | { status: 'sent'; messageId: string; providerMsgId: string; creditsCharged: number; usedTemplate: boolean }
  | { status: 'skipped'; reason: 'feature_off' | 'opted_out' | 'insufficient_credits' | 'outside_window' | 'conversation_not_ai' }
  | { status: 'failed'; error: { code: string; message: string; retryable: boolean; outcomeUnknown: boolean } };

type NotifyPayload = {
  conversationId?: string;   // customer messages
  to?: string;               // test_message only: E.164 recipient
  staffUserId?: string;      // staff_alert only: the member to alert
  text?: string;             // free text, inside the 24-hour window
  templateParams?: string[]; // in {{1}}… order, outside the window
  template?: { name: string; language: string; params: string[] }; // staff_reply only: an approved template staff chose
  interactive?: Interactive; // reply buttons or a list, sent instead of `text` inside the window
  idempotencyKey?: string;   // names this exact message; a repeat returns the first send instead of sending again
  actorId?: string;          // the staff user (staff_reply, test_message); recorded in audit_logs
};
```

**Built in `backend/src/notify`** (`send.ts`, `kinds.ts`, `sender.ts`): `NotifyPayload` and
`SendOutcome` as above. The credit ref is the generated message id (not a payload field).
`NotificationKind` covers `ai_reply`, `staff_reply`, `test_message`, the customer automations,
`system_notice` and `staff_alert`; the other staff-facing kinds (`lead_card`, `daily_agenda`) arrive with
their jobs.

**`system_notice` (built, 9 Oct; for Dev 1's pipeline):** a fixed line from the system to the customer.
`send(tenantId, 'system_notice', { conversationId, text })`: 0 credits (so it goes out when the business is
out of credits), `sender 'system'`, no feature toggle, free text inside the 24-hour window only (no template,
so outside it the outcome is `skipped / outside_window`). It is the one kind sent to a contact who opted
out. Use it only for the STOP confirmation and the out-of-credits holding message.

**`staff_alert` (built, 9 Oct):** a WhatsApp alert to a member of the business, not to a customer.
`send(tenantId, 'staff_alert', { staffUserId, text, templateParams: [headline, link] })`: 0 credits, feature
`staff_alerts`, `sender 'system'`. The number is `memberships.whatsapp_phone` (E.164; none or invalid is
`not_found`, "That person has no WhatsApp number for alerts."). `notify_staff_target` makes it a contact tagged
`staff` with an open conversation in `human` mode, so the AI never answers a member's reply and the alert is
stored like any other message. Free text when the member has written to the business in the last 24 hours,
otherwise the approved `staff_alert_vN` template: `{{1}}` the one-line headline, `{{2}}` the dashboard link.
**Nobody calls it directly:** `backend/src/notify/staff-alerts.ts` builds the content and picks the recipients
(owners and admins with an alert number), and the `handoff-alert` job (section 5) sends it.

| Alert | When | Headline | Link |
|---|---|---|---|
| `handoff_opened` | a handoff that is not one of the two below | "{name} is waiting for a person on WhatsApp." | `/dashboard/inbox?conversation=<id>` |
| `credits_exhausted` | handoff trigger `credits_exhausted` | "{business} is out of credits, so the assistant has stopped replying." | `/dashboard/billing` |
| `setup_problem` | handoff trigger `stuck` | "The assistant couldn't continue the chat with {name}." | `/dashboard/inbox?conversation=<id>` |
| `handoff_waiting` | `handoff-sla`: no one picked the chat up within the SLA; **owners only** | "{name} has waited {N} minutes and no one has picked up the chat yet." | `/dashboard/inbox?conversation=<id>` |
| `opted_out` | handoff trigger `opt_out` (the customer sent STOP; Dev 1's #69) | "{name} sent STOP, so the assistant won't message them again. Call them if you need to." | `/dashboard/inbox?conversation=<id>` |
| `visit_outcome` | `post-visit`, after the visit: to the booked staff member if they have an alert number, else owners and admins | "How did the {what} with {name} go? Update the lead so follow-ups stay right." | `/dashboard/inbox?conversation=<id>` |
| `low_rating` | `post-visit`: the customer rated the visit 1–3; **owners only** | "{name} rated their {what} {n} out of 5." | `/dashboard/inbox?conversation=<id>` |
| `own_number_outcome` | `own-number-outcome`, 4 h after an own-number takeover: the staff member who took it; with Booked / Follow-up / Lost buttons inside their window | "How did your WhatsApp chat with {name} go? Update the lead." | `/dashboard/inbox?conversation=<id>` |

**`daily_agenda` (built, 9 Oct):** the day's bookings to the owners, free, behind the `daily_agenda` toggle (Growth and
Pro). Like `staff_alert` it goes to a member's alert number (`staffUserId`): free text inside their window ("Good
morning! Today at {business}: 2 bookings." then one "• 10:00 am, Site visit with Asha (Priya)" line per booking and the
calendar link), else the approved `daily_agenda_vN` template with {{1}} how many ("2 bookings"), {{2}} the first one and
{{3}} the calendar link.

`{name}` is the contact's name, else the masked number (`+9198xxxxxx45`). Every parameter is one line with no
tabs or runs of spaces (Meta refuses them, 132018); customer and business names are cut to 40 characters.

**For the inbox (Dev 3):** contacts tagged `staff` or `test` are our own numbers; their chats should be hidden
from the inbox list (or shown under a separate filter).

**A template chosen by staff (built, 9 Oct; for Dev 3's template picker):** `staff_reply` may pass
`template: { name, language, params }`, an approved template by its exact versioned name (`reminder_24h_v2`), its
language and its body variables in {{1}}… order. It is sent whatever the 24-hour window, free like any staff reply, and
recorded with its name (`messages.template_name`). Only a template with `status = 'approved'` on the business's
connected number is used (`not_found`, "That template isn't approved for this WhatsApp number."); the number of values
must match the body's variables (`validation_failed`, "This template needs 2 values."); a malformed name or language is
`validation_failed` before anything is read. Other kinds cannot pass `template`. For the inbox route
(`POST /api/conversations/:id/messages`), the body would be `{ "template": { "name", "language", "params" } }`
instead of `{ "body" }`, passed through to `notify.send` with the staff member as actor.

**Idempotency key (built, 9 Oct):** a job that may retry passes `idempotencyKey` (up to 200 characters, for example
`reminder_24h:<bookingId>:<start>`). The message id is derived from the business, the kind and the key, so once
that message has gone out (its `messages` row exists), a repeat returns the first send's `sent` outcome without
sending, charging or checking toggles again. A message that fell back to the template went out under the key
`<key>#template`, and a repeat finds that one too. A send whose outcome is unknown wrote no row, so it is still never
retried automatically (`outcomeUnknown`).

**Template catalogue (built, 9 Oct; `backend/src/notify/template-catalogue.ts`, review sheet `docs/templates.md`):**
every template the jobs send outside the window, English and a Tamil draft, with variables, examples and quick replies;
`templateComponents()` gives Meta's components for Dev 1's submission. The English waits for Raja's wording and the
Tamil for a native speaker's review before anything is submitted.

**Reply buttons and lists (built, 9 Oct; `backend/src/notify/interactive.ts`):** any kind can pass
`interactive` instead of `text`. Inside the 24-hour window it goes as WhatsApp reply buttons or a list and costs
what the kind's free text costs; outside the window the kind's approved template goes (its own quick-reply buttons
are part of the template), and if WhatsApp says the window has just closed, the template is sent after a refund,
as for text.

```ts
type Interactive =
  | { type: "buttons"; header?: string; body: string; footer?: string;
      buttons: { id: string; title: string }[] }                       // 1–3 buttons
  | { type: "list"; header?: string; body: string; footer?: string; button: string;
      sections: { title?: string; rows: { id: string; title: string; description?: string }[] }[] };
```

Meta's limits are checked before anything is read or spent (`validation_failed` otherwise): button title 20
characters, button id 256, body 1024 (buttons) or 4096 (list), header and footer 60, list button label 20, row
title 24, row description 72, row id 200, at most 10 rows in all and 10 sections, titles on every section when
there are several, ids unique, titles and ids one line. A tap comes back as an inbound message of type
`interactive` whose `buttonId` is the button's or row's `id`, so ids should say what they are for (for example
`booking:<bookingId>:confirm`). The inbox copy (`messages.body`) is the text followed by the choices: `[Confirm]
[Cancel]` for buttons, one `• <title> (<description>)` line per list row.

**Adapter plug-in (built by Dev 2, 8 Oct):** `registerSender(factory)`, where
`factory({ tenantId, connectionId }) → { sendText(to, text), sendTemplate(to, name, language, params), sendInteractive(to, message) }`
and each returns `{ providerMsgId }`. `server/main.ts` registers the WhatsApp factory at startup
(`registerWhatsAppSender()`, `backend/src/channels/whatsapp/message-sender.ts`). It loads the connection with
the service role; one that is not `active` is `whatsapp_not_connected`, before any credits are spent. With no
factory registered, `notify.send` answers `not_available`, also before spending.
Each method throws a `SendError` (`backend/src/notify/sender.ts`) when WhatsApp refuses the message: a code
from `ERROR_CODES` plus `retryable` and `outcomeUnknown` (the message may have gone out anyway). When Meta
refuses a free-form message because the 24-hour window has closed (131047), `sendText` or `sendInteractive` throws `OutsideWindowError`, a
`SendError` with code `outside_window`, and `notify.send` sends the approved template instead. Every other code
passes through in the `failed` outcome. A plain `Error` is unexpected: it is logged (redacted) and answered as
`upstream_failed`.

`FeatureKey` lives in `backend/src/billing/credit-costs.ts` for now and moves here with the above.

## 3. JSON shapes in jsonb columns

| Column | Shape | Status |
|---|---|---|
| `tenants.business_hours`, `resources.working_hours` | `{ "mon": [{ "start": "10:00", "end": "19:00" }], … }`. Keys `mon`–`sun`; local time in `tenants.timezone`; several intervals allow split shifts; a missing day or `[]` means closed. A resource with no days set uses the business's hours | Fixed: read by `findSlots` (`WeeklyHours` in `backend/src/booking/slots.ts`) |
| `resources.service_area` | `{ "pincodes": ["600041", …] }` (field visits); a resource with no area serves every pincode | Fixed: read by `findSlots` |
| `tenant_features.settings` | Reminders: `{ "offset_minutes": 1440 }`, minutes before the booking's start, a whole number from 1 to 10080 (a week); anything else uses the default (`reminder_24h` 1440, `reminder_2h` 120). Other features `{}` | Fixed for reminders: read by `booking-reminders` (`backend/src/booking/reminders.ts`) |
| `tenant_features.settings` of `handoff_triggers` | `{ "sla_minutes": 15 }`: minutes a handoff may wait before the owner is alerted again, 1 to 1440; anything else uses 15 | Proposed (decision 17): read by `handoff-sla` |
| `tenant_features.settings` of `feedback_request` | `{ "offset_minutes": 120 }`: minutes after the booking's end before the rating question, 0 to 10080; anything else uses 120 | Built: read by `post-visit` |
| `tenant_features.settings` of `review_request` | `{ "review_url": "https://…" }`: the business's review page (https only). Without it no review link is sent | Proposed: read by `post-visit`; Dev 3's settings screen to edit it |
| `tenant_features.settings` of `followup_nudges` | `{ "offset_minutes": [120, 1380], "nurture_after_minutes": 2880 }`: minutes after the customer's message for the two nudges and the move to nurture, each 1 to 10080 and in that order; anything else uses the defaults shown | Proposed (decision 18): read by `lead-nudges` |
| `tenant_features.settings` of `handoff_own_number` | `{ "outcome_after_minutes": 240 }`: minutes after an own-number takeover before the staff member is asked how it went, 1 to 10080; anything else uses 240 | Built: read by `own-number-outcome` |
| `bookings.details` | Free-form per booking kind (pax, pickup point, package id) | Fixed (handover) |
| `whatsapp_templates.components` | As submitted: body, examples, header, footer, buttons | Agreed |
| `tenants.agent_settings` | Persona name, tone, languages, handoff default, scoring overrides | **To define: Dev 1 + Dev 3** |
| `whatsapp_connections.last_check` | One entry per validation check | **To define: Dev 1** |

A service is bookable on any active resource of the same tenant whose `type` equals `services.resource_type`.

## 4. Function signatures

**Fixed (merged).** Dev 2's functions take `tenantId` first and filter by it.

```ts
// backend/src/billing/credits.ts (#13)
spendCredits(tenantId, amount, reason: SpendReason, refId?): Promise<boolean>   // false = would go below zero
getBalance(tenantId): Promise<{ plan: number; topup: number; total: number }>
// backend/src/features/is-enabled.ts (#18)
isEnabled(tenantId, featureKey: FeatureKey): Promise<boolean>
getFeatureStates(tenantId, { fresh? }): Promise<FeatureState[]>
invalidateFeatureCache(tenantId?): void
// backend/src/billing/trial.ts (#18)
createTrialTenant({ userId, name, vertical, timezone? }): Promise<{ tenantId, routeCode, trialEndsAt, created }>
// backend/src/lib/audit.ts
writeAudit({ tenantId, actor, action, entity?, entityId?, diff? }): Promise<void>
```

- `writeAudit` is for every traceable action other than sent messages (`notify_record` writes
  those). `actor` is a user id, `ai`, `system` or `admin:<user id>`; `action` is
  `<entity>.<verb>` (`feature.toggled`); `tenantId` is null only for platform actions. Phone
  numbers in `diff` are masked. It throws if the row is not written.

- `isEnabled` is on only when the business is live (active, or in a trial whose end date has not
  passed), the plan includes the feature and the toggle is on (`default_on` when unset). The
  handover says plan + toggle; the status check is new and needs confirming (decision 12).
- `createTrialTenant`: one self-serve business per account. A repeat call during the trial returns
  the same business (`created: false`); an account that already owns a paying business gets an error.

**Fixed (handover), to be built:**

```ts
notify.send(tenantId, kind: NotificationKind, payload: NotifyPayload): Promise<SendOutcome>   // Dev 2
buildLeadCard(leadId): Promise<LeadCard>                                                      // Dev 1
```

**Booking functions (built, Day 3; `backend/src/booking/`, server only):**

```ts
// bookings.ts
findSlots(tenantId, { serviceId, resourceType?, from, to, pincode? }): Promise<Slot[]>
holdSlot(tenantId, slot: { start, end, resourceId?, serviceId? }, leadId, { kind?, details? }?): Promise<Booking>
confirmBooking(tenantId, bookingId): Promise<Booking>
rescheduleBooking(tenantId, bookingId, newSlot: { start, end, resourceId? }): Promise<Booking>
cancelBooking(tenantId, bookingId, reason?): Promise<void>
// time.ts
localWindow(timeZone, { day: 'today' | 'tomorrow' | 'YYYY-MM-DD', part?: 'morning' | 'afternoon' | 'evening' | 'any' }, now?)
  -> { date, from, to }        // "tomorrow evening" in the business's time zone, as UTC
// Slot = { start, end, resourceId, resourceName, serviceId, label }   start/end ISO UTC; label "Fri 9 Oct, 5:00 pm"
```

- `findSlots` gives up to 3 times spread across the window (first, middle, last). It respects the resource's
  working hours (else the business's), the service's `duration_min`, `buffer_min` (kept clear on both
  sides of a booking) and `min_notice_min`, and held or confirmed bookings (an expired hold no longer
  counts). Start times are every 30 minutes from opening; each time comes with the least busy free resource
  of the service's `resource_type`. With `pincode`, only resources whose `service_area.pincodes` has it, or
  that have no area set. The window is at most 14 days. A person with a connected Google Calendar is also busy when
  Google's free/busy says so (`googleBusyTimes`); Google can only take times away, and a Google failure is logged and
  never stops slot search.
- `holdSlot` holds for 10 minutes (`status 'held'`). `kind` defaults to `slot`; `slot`, `site_visit` and
  `field_visit` need a resource and a service; `callback`, `date_range` and `reservation` may have no resource
  and then never clash. A lead holds one time at a time: a new hold releases its earlier one
  (`cancel_reason 'replaced'`). An expired hold stops blocking at once.
- `confirmBooking` confirms a hold (also one past its expiry while still held) and moves the lead to `booked`
  unless it is further along. A repeat is harmless. Emits `booking.confirmed`.
- `rescheduleBooking` works on a confirmed booking: the old row becomes `rescheduled`, a new confirmed row
  takes the new time (`details.rescheduled_from`). Emits `booking.changed` (old) and `booking.confirmed` (new).
- `cancelBooking` cancels a held or confirmed booking (`details.cancel_reason`). A repeat is harmless. Emits
  `booking.changed`.
- **Errors:** a taken time is `slot_taken` (409, the exclusion constraint's 23P01); an unknown or other
  business's lead, service, resource or booking is `not_found`; a hold that expired or a booking in the wrong
  state is `conflict`; bad times, kinds or resources are `validation_failed`.
- **Jobs:** `release-holds` (Inngest cron, every minute) marks holds past their expiry `expired`.
  `google-calendar-sync` (built 9 Oct; `backend/src/booking/google-sync.ts`): `booking.confirmed` puts the booking on
  its person's Google Calendar ("{service}: {customer name}", no phone number, a link to the dashboard's calendar)
  and keeps the event id in `bookings.calendar_event_id`; `booking.changed` with `cancelled` or `rescheduled` takes it
  off (the new time of a reschedule is its own `booking.confirmed`). The event id is fixed per booking
  (`pk<booking id without dashes>`), so a retry finds the event instead of adding another. Only for a person with a
  connected calendar; a Google error retries the step.
- **Double booking:** blocked by the database: `scripts/db/hold-slot-concurrency.sh` (CI) runs 20 holds for one
  slot at the same moment; exactly one wins and the other 19 get `slot_taken`. Holds and moves for one person take
  turns (0023): without that, Postgres could report a racing loser as a deadlock (a server error) instead.

**`notify.send` behaviour (Proposed, test message Agreed):**

1. `isEnabled` for the kind's feature, if it has one (`staff_reply`, `consent_notice`, `lead_card` and
   `test_message` have none).
2. Skip if the contact has opted out, unless the kind is the final opt-out confirmation.
3. Inside 24 h of `last_customer_msg_at`: free text. Outside: the kind's approved template; if it has
   none, return `skipped / outside_window`.
4. `spendCredits` with the kind's cost; 0-cost kinds skip it. `false` returns `skipped / insufficient_credits`.
5. Send through Dev 1's adapter, store the `messages` row (`credits_charged`), write `audit_logs`.
6. If the adapter fails after credits were spent, call `refund_credits(tenantId, messageId)`.
7. If `sendText` or `sendInteractive` throws `OutsideWindowError` (the window closed after step 3), refund, then send the
   kind's approved template as in step 3; a kind with no template returns `skipped / outside_window`.
   A refused template send is never retried.

**`test_message` (Agreed):**

- 0 credits.
- Always through `notify.send`.
- Free text inside 24 h; otherwise `outside_window`.
- Recorded in `messages` (`direction 'out'`, `sender 'staff'`, `credits_charged 0`,
  `provider_msg_id`; the contact is found or created for the number and tagged `test`) and in
  `audit_logs` (`action 'test_message.sent'`, actor = the staff user).
- Limit: 10 per business per rolling hour, counted from `audit_logs`; over it, `rate_limited`.

## 5. Events (Inngest)

**Fixed names (handover):** `whatsapp/message.received`, `whatsapp/connected`, `booking.confirmed`,
`booking.changed`, `handoff.opened`, `handoff.own_number`, `tenant.trial_started`, `credits.spent`.

**Payloads (Proposed):** ids only, never phone numbers, message text or tokens. An event that may be
sent twice carries a fixed `id` so Inngest drops the duplicate (`tenant.trial_started` uses
`trial_started:<tenantId>`, Fixed in #18).

| Event | Payload |
|---|---|
| `whatsapp/message.received` | `{ tenantId, conversationId, messageId }`; sent by the webhook (id `message_received:<messageId>`, also for a replay); starts `process-message`, and `lead-nudges` (the chat's next message cancels its earlier run) |
| `kb/document.uploaded` | `{ tenantId, documentId }`; sent by `POST /api/kb/documents` (id `kb_document_uploaded:<documentId>`), starts the `kb-ingest` job |
| `whatsapp/connected` | `{ tenantId, connectionId }` |
| `booking.confirmed` | `{ tenantId, bookingId }`; sent by `confirmBooking` and `rescheduleBooking` (id `booking.confirmed:<bookingId>`); starts `booking-reminders` and `post-visit`, and `google-calendar-sync` adds the booking to Google |
| `booking.changed` | `{ tenantId, bookingId, change: 'rescheduled' \| 'cancelled' \| 'completed' \| 'no_show' }`; sent by `rescheduleBooking` and `cancelBooking` (id `booking.changed:<bookingId>:<change>`); cancels that booking's `booking-reminders` run, and its `post-visit` run unless the change is `completed`; `google-calendar-sync` removes its Google event when `cancelled` or `rescheduled`; `no_show` starts `noshow-rebooking` |
| `booking.rated` | `{ tenantId, bookingId, rating }` (1–5); sent by `recordVisitRating` when the customer taps a rating (id `booking.rated:<bookingId>`, so the first rating counts); the `post-visit` run waits for it |
| `handoff.opened` | `{ tenantId, handoffId, conversationId }`; sent by Dev 1's reply step when it opens a handoff (id `handoff_opened:<handoffId>`); starts `handoff-alert`, which sends one `staff_alert` to each owner and admin with an alert number (section 2). A handoff already resolved by the time the job runs gets no alert. **The job is the only sender of handoff alerts:** the reply step does not alert staff itself. Also starts `handoff-sla`: after the SLA (section 3) it alerts the owners again (`handoff_waiting`) unless someone has the chat: the handoff was picked up, assigned or resolved, a staff member took the chat over, or it is no longer in `human` mode (back with the AI, or on the business's own number) |
| `handoff.own_number` | `{ tenantId, handoffId }`; to be sent by Dev 1's own-number takeover; starts `own-number-outcome` |
| `tenant.trial_started` | `{ tenantId }` |
| `credits.spent` | `{ tenantId, amount, reason, balanceAfter }` |

**Booking reminders (`booking-reminders`, built 9 Oct; `backend/src/inngest/booking-reminders.ts`).** On
`booking.confirmed` the run plans the 24 h and 2 h reminders from the booking's start and the business's offsets
(section 3), sleeps until each and sends it through `notify.send` (`reminder_24h`, `reminder_2h`: the toggle, plan,
opt-out, window and 1 credit are notify.send's). Before each send it reads the booking again and sends only if it is
still confirmed at the same start. Any `booking.changed` for the booking cancels the run (`cancelOn`, matched on
`bookingId`); a reschedule confirms a new booking, which gets its own run. A reminder whose time has passed is not
sent. The message goes to the lead's contact's open chat:
- Inside the 24-hour window: "Reminder: your {service, or the kind of booking} with {business} is on Sat 10 Oct,
  5:00 pm." with three reply buttons, `booking:<bookingId>:confirm`, `:reschedule` and `:cancel`.
- Outside it: the approved `reminder_24h_vN` / `reminder_2h_vN` template, with variables {{1}} what, {{2}} the
  business, {{3}} the local date and time, and its own quick-reply buttons.

Each send's idempotency key is `<kind>:<bookingId>:<start>`. **For Dev 1:** a tap arrives as an inbound message whose
`buttonId` is one of those ids; `parseBookingButton(buttonId)` (`backend/src/booking/reminders.ts`) returns
`{ bookingId, action }` for the pipeline to act on (confirm: thank the customer; reschedule: offer slots; cancel:
`cancelBooking`).

**After a visit (`post-visit`, built 9 Oct; `backend/src/inngest/post-visit.ts`).** On `booking.confirmed` the run
sleeps until the booking's end plus the business's delay (section 3, 2 h by default). Then, if the visit happened
(the booking is still confirmed, or marked completed, at the same time):
- It asks the customer for a rating (`feedback_request`, 1 credit): inside the window a list of five rows, ids
  `rating:<bookingId>:<1–5>`; outside it the `feedback_vN` template with {{1}} what and {{2}} the business.
- It prompts staff for the outcome (`staff_alert` `visit_outcome`).
- It waits up to 3 days for `booking.rated`. A 4 or 5 gets the business's review link (`review_request`, 1 credit; the
  `review_vN` template has {{1}} the business and {{2}} the link); without a link nothing is sent. A 1–3 alerts the
  owners (`low_rating`).

A cancelled, moved or no-show booking ends the run (`cancelOn`); one marked completed does not. **For Dev 1:** a
rating tap's `buttonId` is `rating:<bookingId>:<n>`; `parseRatingButton(buttonId)` gives `{ bookingId, rating }` and
`recordVisitRating(tenantId, bookingId, rating)` (`backend/src/booking/post-visit.ts`) saves it on the lead
(`leads.feedback_rating`) and sends `booking.rated`. For a 4 or 5 the job's review message is the thank-you, so the
pipeline should not answer the tap; for a 1–3 it may send a short thank-you (staff are alerted by the job).

**Lead nudges (`lead-nudges`, built 9 Oct; `backend/src/inngest/lead-nudges.ts`).** Every customer message starts a run
and the chat's next message cancels it, so only the latest message's run is alive. At each offset (section 3; 2 h and
23 h by default, decision 18) the run reads the chat again and sends `followup_nudge` (1 credit; the `nudge_vN`
template has {{1}} the customer's name) only if: the assistant answered that message (its `message.answered`
marker), the customer has not written since, the chat is still with the assistant (`mode = 'ai'`), and the lead is
still `new`, `engaged` or `qualified`. Anything else ends the follow-up. Still quiet at `nurture_after_minutes` (48 h),
the lead moves to `nurture` (only from those stages; audited as `lead.stage_changed`). Keys
`followup_nudge:<messageId>:<1|2>`.

**No-show rebooking (`noshow-rebooking`, built 9 Oct).** `booking.changed` with `no_show` → if the booking is still
marked no-show, the customer gets "Sorry we missed you for your {what} with {business}. Would you like to pick a new
time?" (`noshow_rebooking`, 1 credit) with one button, the reminders' `booking:<bookingId>:reschedule`, so the pipeline
answers it the same way; outside the window the `noshow_rebook_vN` template with {{1}} what and {{2}} the business. Key
`noshow_rebooking:<bookingId>`. No-shows are marked by the booking action routes (Day 5).

**Daily agenda (`daily-agenda`, built 9 Oct).** A cron every 15 minutes: each live business (trial or active) where it
is now 8:00–8:14 in its own time zone, with `daily_agenda` on, gets today's confirmed bookings (its local day) sent to
each owner with an alert number (`daily_agenda`, free). A day without bookings sends nothing. Key
`daily_agenda:<business>:<owner>:<local date>`, so one a day whatever retries do.

**Own-number outcome (`own-number-outcome`, built 9 Oct).** `handoff.own_number` → after `outcome_after_minutes` (4 h)
the staff member who took the chat (`handoffs.assigned_user_id`) is asked how it went (`staff_alert`
`own_number_outcome`): inside their window with buttons `outcome:<handoffId>:booked|follow_up|lost`, outside it the
staff_alert template (the question and the chat's link). A handoff that already has an outcome is not asked about.
**For Dev 1:** a staff member's tap arrives from their staff-tagged contact; `parseOutcomeButton(buttonId)` gives
`{ handoffId, outcome }` and `recordHandoffOutcome(tenantId, handoffId, outcome, actor)` (`backend/src/leads/
own-number-outcome.ts`) saves the first answer on the handoff (and resolves it), moves the lead to `booked` or `lost`
(follow-up leaves it) and audits it. The own-number takeover itself, and sending `handoff.own_number`, are Dev 1's.

**The message pipeline (`process-message`, built: steps 2 and 3).** One conversation at a time (concurrency key
`conversationId`); messages from one conversation within 3 seconds (never longer than 15) start one run. A debounce keeps
only the LAST event, so the event is only where to look: the run answers a **batch**, the customer's unanswered messages
from the 15 seconds before the event's message (the newest 10), together. Steps: `resolve` (the message, conversation,
contact and business, each read for the event's business; the message must be that business's and that conversation's),
`batch` (the unanswered ones; the event's own message if it was not answered; an empty batch is "already answered"),
`lead` (the contact's open lead, any stage but won and lost, the oldest if several, or a new one; made even when the AI
will not answer), `gate` (for the conversation: opted out, then a chat a person has, then `ai_auto_reply` off; then per
message: a photo, voice note or other message that is not text or a tapped reply is left for staff and the rest are
answered). A step's result is ids, flags and small facts only: Inngest keeps it, so never message text, a phone number or
a name.

**An answered message is recorded as an audit row** (`audit_logs`, action `message.answered`, entity `message`,
entity_id the message id, actor `ai`). The reply step writes **one row for every message in the turn's `messageIds`**,
in the same step as the send (a crash between the two would send the reply twice on retry), and re-reads the chat's mode
and the contact's opt-out flag right before sending (staff may have taken over, or the customer sent STOP, since the
gate looked). `process-message` skips a message that has a row, however many times its event arrives; the lookup reads
audit rows from a day before the message's time (our clock against Meta's). An outbound message after the inbound one is
not used as the marker: an inbound message's `created_at` is Meta's send time, so a message sent while the previous one
was being answered can look older than our reply and would be dropped.

**Step 4, understanding the message (`understandTurn`, built).** Steps: `extract` (loads the business's pack; none or
invalid is `no_pack`), `save-fields`, `retrieve`. `extract` asks the fast model (Haiku 4.5, `extraction_v1`) what the batch of messages says,
with the pack's fields, the last four messages before the burst and what the lead already has, and validates the answer:
JSON (a code fence is tolerated), the `Extraction` schema, and the details limited to the pack's own fields, each
checked against the pack's type for it (the rest are dropped and counted). A bad answer is asked for once more, with the
reason; a second bad answer, or a refusal, is the **clarifying-question fallback**; a model that cannot be reached
(the client has already tried 3 times) is `model_unavailable`, returned by the step itself so Inngest does not pay for the
same calls again. The batch text sent to the model is capped (4000 characters, the end kept). `save-fields` merges the
details into the lead's `fields` in one statement (`merge_lead_fields`, migration 0018: a member's edit made in the
meantime survives) and moves a `new` lead to `engaged`; it re-checks the details against the pack as it is now, writes
only what changed, lets a low-confidence reading (< 0.5) fill a gap but not replace an answer, and does nothing for the
intent `opt_out`. `retrieve` searches the knowledge base for the English question, only for the intents `question`,
`give_details` and `book`; its outcome is `found`, `none` (a gap), `unavailable` (an outage, not a gap) or `skipped`.
**The extraction is kept on the newest message of the turn, in `messages.meta.agent`** (merged by
`merge_message_agent_meta`, which leaves the rest of the meta and the other keys of `agent` alone): `{ extraction,
droppedFields: { unknownKeys, invalidValues }, at }`, or `{ extractionFailed: "no_text" | "invalid_output" |
"model_declined" | "model_unavailable", at }`. Writing one outcome clears the other's keys (`extraction: null` with a failure, `extractionFailed: null` with a success), so
read `null` as absent. A run that finds a valid `extraction` already on the message uses it and does not ask the model
again; for the intent `opt_out` the saved extraction has no details and no question. A message with no text (media only)
is the `no_text` fallback and does not engage the lead. The history sent to the model is the last four messages with text
strictly before the first message of the burst (by its `created_at`). `confidence` is the model's own word, not a trust
boundary: an injected message can claim 1.0. The customer's words, the question and the details are not in Inngest's
step results; later steps read them from there.

**Step 7, the reply and the send (`replyTurn`, built).** Steps `plan`, `reply`, `handoff`; the first step of the run,
`started`, records when the turn began. The action is fixed until the decide step (Day 3) exists: answer from the
knowledge base's facts, or a safe line. **`plan.ts` is the whole table of what the customer gets, for every way step 4 can
end: nothing ends without an answer.** An answer from the knowledge base is written by the strong model (Sonnet 5.5,
`reply_v1`: persona and business name, tone, the customer's language, the last 10 messages, the facts) and checked by
code (`postcheck.ts`): every ₹ amount (compared by value: ₹85 lakh = 85L = ₹85,00,000; Tamil and Hindi numerals), date and
time must be in the facts, at most 600 characters and two questions; one regeneration, then the safe fallback: exactly
"Let me confirm that with the team" in English, and the same sentence in the customer's language when it is Tamil, Tanglish
or Hindi (fixed lines in `fixed-texts.ts`). Everything
else is a fixed line, with no model call: a clarifying question (nothing readable, a bad answer twice, the model
declined), the safe fallback (the language model or the search could not be reached, a question the knowledge base cannot
answer, the turn's time ran out, no usable pack), the handover line, or a STOP hint for a message about leaving. Fixed
lines go out as `ai_reply` and cost one credit like any reply. A question the knowledge base could not answer is
recorded with `record_kb_gap` once per turn (marker `gapRecorded` on the message), under `normaliseQuestion`.
**The `kb_gap` handoff is two such questions in a row in the SAME chat** (the count is `messages.meta.agent.kbMisses`; any
answered turn resets it, an outage or a clarifying question carries it), never the business-wide `asked_count`, which only
feeds the dashboard's most-asked list. A business can turn it off (`agent_settings.handoffTriggers`, key `kb_gap` or `gap`).
The send is `notify.send(tenantId, "ai_reply", { conversationId, text })`, after a fresh look at the chat's mode and the
contact's opt-out; **in the same step `message.answered` is written for every message of the turn** (a few tries; a failure
is logged and never thrown, since a retry would send again), and a send whose outcome is unknown counts as answered.
`insufficient_credits` sends no AI reply: the chat goes to `human`, a `handoffs` row (`credits_exhausted`, priority
`high`) opens, `handoff.opened` is sent (id `handoff_opened:<handoffId>`), and the free holding message goes through the
system-notice port (`ports.ts`): `notify.send(..., "system_notice", ...)` (built, #70). The owner alert is sent ONLY by Dev 2's `handoff-alert` job from that `handoff.opened` event (#71); the pipeline has no alert call of its own, so owners get exactly one alert. The whole turn has one
clock (`turn-deadline.ts`): target 10 s, hard stop 25 s, after which the model calls stop and the safe line is sent.
`persona` and `tone` are read from `tenants.agent_settings` as the Agent settings screen saves them. The turn's clock also
runs while a failed step waits for its retry, so a slow second attempt can be answered with the safe line. **Never two
replies:** a step looks at `message.answered` (and at the `reply` marker the send leaves on the message's meta) before and
right before the send; the marker is written before the rows, so a failure to write the rows does not allow a second
reply. The handover's event is sent on every run of the step (its id makes it one event), so a retry after a failure still tells staff.

**Anger, a person, and leaving (Raja, 9 Oct).** `extraction_v2` adds the intent `unclear_exit` and the key `notInterested` and carries Raja's phrases (`docs/reference/opt-out-handoff-phrases.md`) as examples, not keywords. The reply step's table (`plan.ts`) then decides: **`opt_out` with confidence >= 0.8** (`OPT_OUT_MIN_CONFIDENCE`) is opted out like a STOP (`consent_logs` source `model_intent`, migration 0022), one confirmation through `system_notice`, a high-priority `opt_out` handoff and `handoff.opened`, no reply and no credit, and the lead goes to `lost` when `notInterested`; **`opt_out` below 0.8 or `unclear_exit`** gets the exit question once: TWO REPLY BUTTONS [Talk to the team] [Continue] (ids `exit:talk` and `exit:continue`, sent with `notify.send`'s `interactive`, #76) under a short line with the STOP hint (no STOP button). A tap on Talk to the team (the inbound message's `meta.buttonId`) is a handoff at any time; Continue goes on as normal. If WhatsApp refuses the buttons (not a retry, not an unknown outcome) the same question goes once as plain text with "Reply 1 to talk to the team, or just continue", and a "1" right after it is a handoff. A business that switched `asked_human` off gets only the short line with the STOP hint; **`talk_to_human`, `complaint` or `sentiment: angry`** gets the handover line, `mode = 'human'`, and a high-priority handoff (`asked_human` or `complaint`) with `handoff.opened`; each of the last two can be switched off in `agent_settings.handoffTriggers`. `asksIfHuman` alone is answered, not handed over.

**Reply-button ids (agreed 9 Oct, built on Day 3).** A booking confirmation's reply buttons carry the ids `booking:<bookingId>:confirm`, `booking:<bookingId>:reschedule` and `booking:<bookingId>:cancel` (WhatsApp allows 3 buttons, ids up to 256 characters). The pipeline, not the webhook, routes the tap: the webhook stores it as a customer message, and step 5 reads the id and calls `confirmBooking` / `rescheduleBooking` / `cancelBooking`.

**Consent (DPDP): the notice and STOP.** *The notice:* the first AI reply to a contact (`contacts.consent_at` is null)
carries one extra line after a blank line, **only when the business turned it on (`agent_settings.privacyNotice`, default off, Raja 9 Oct)**: who answers (an AI assistant), how to stop (reply STOP) and the privacy policy link
last (`PRIVACY_POLICY_URL`, an optional https env var, default https://pakkaagent.in/privacy), in the reply's language
(English, Tamil, Tanglish, Hindi; `fixed-texts.ts`). Every first reply carries it, a fixed line too; it is added after the
post-check and is not part of the 600 characters. After a send (or one whose outcome is unknown) `record_notice_shown` sets
`consent_at` and writes `consent_logs` `notice_shown` (source `first_message`, the outbound message id) in one transaction,
once; a failure there is logged, never thrown, and the next reply carries the notice again. *STOP:* a step `stop-check` runs
before the message is read by the model: if a message of the turn IS a STOP (the whole message, ignoring case, punctuation and
emoji, is one of the fixed phrases in `consent/stop-words.ts`; "bus stop near the project" is not, and neither is a lone ambiguous word such as ruko or நிறுத்து), `record_opt_out` sets
`contacts.opted_out_at` and writes `consent_logs` `opted_out` (source `stop_keyword`, the message id), AT MOST ONE final confirmation
goes through `notify.send`'s `system_notice` (the only message sent after opting out; only the call that recorded the opt-out sends it),
a high-priority `handoffs` row (trigger `opt_out`) opens and `handoff.opened` is sent (id `handoff_opened:<handoffId>`; the alert says: "Customer opted out. Don't message on WhatsApp unless they write again; a call is safer."; the chat's mode is not changed), every message of the turn is marked answered, and the
turn ends: nothing is read, updated or replied to. The check also runs for a chat a person has and one with the AI switched
off (an opt-out never depends on a toggle; step `stop-check-gated`), and for the safe line sent after a run gave up. The gate
(step 3) and `notify.send` (which checks `opted_out_at`) refuse every later message of that contact. The notice is recorded
as shown only when the send is known to have gone out; an unknown outcome leaves `consent_at` null and the next reply
carries it again. `consent_logs` rows go with the contact if the contact is deleted. A message the model reads as "wants to leave"
(`opt_out` intent) without being one of the phrases gets the STOP hint, not an opt-out.

A run that still fails after its 3 retries: `onFailure` logs its id and, if the customer's messages are still unanswered and
the chat is still the assistant's, sends one safe line and marks them answered (`give-up.ts`). A sweep for customer messages
nobody answered is still the follow-up for a failure that could not even do that.

## 6. API routes and errors

**Fixed:** the handover's route table, including the module 10 endpoints. Every route validates
input with Zod, resolves the tenant from the session (the browser never sends `tenantId`), checks
membership and role, and returns `{ error: { code, message, fields? } }`.

**Where routes run (changed in `feat/backend-railway-split`):** the API service on Railway
(`backend/src/server/routes.ts`), at `${NEXT_PUBLIC_API_URL}/api/...`; paths and shapes are unchanged.
The browser authenticates with `Authorization: Bearer <Supabase access token>` instead of the session
cookie, and in the dashboard names the business with `X-Pakka-Tenant`, which the API honours only for
one of the caller's own memberships (the same rule as the `pakka_tenant` cookie). Browser calls come
from allowed origins only (CORS). New route: `POST /api/onboarding/trial` `{ name, industry }` →
`StartTrialResult` (`@pakka/types`), with status 200 `ready`, 409 `has_business`, 422 `invalid` or
`unavailable`, 500 `failed`; 401 envelope when signed out. It replaces the onboarding server action.

**Who may call a route (`backend/src/server/auth.ts`, built):**

- Members: `tenantRoute(handler, { status })`, the tenant from the token and `X-Pakka-Tenant`.
- Platform team (`/api/admin/...`): `adminRoute(handler, { status })` verifies the token, then checks
  `platform_admins` (0016); anyone else gets `forbidden`. The business is named in the body or path
  (`tenantId`), never by `X-Pakka-Tenant`. Record `admin.actor` (`admin:<user id>`) in `audit_logs` and
  `whatsapp_connections.connected_by`. Both answer with `status` (default 200), or 204 when the service
  returns nothing.
- Public (no login): a `browser: true` route whose handler doesn't authenticate; CORS and the origin
  check still apply. List secret path segments in the route's `secretParams` (`["token"]`) so the request
  log shows `***`. Connect-link tokens come from `newConnectLinkToken()` and are looked up by
  `hashConnectLinkToken()` (`backend/src/lib/connect-link-token.ts`); `connect_links.token_hash` stores the
  hash. Mark a link used in the same statement that checks it (`used_at is null and expires_at > now()`).

**Error codes.** The list is `ERROR_CODES` in `packages/types/src/errors.ts`; the HTTP statuses are in
`backend/src/lib/errors.ts`.

| In `ERROR_CODES` (#15) | HTTP | Added in #23 | HTTP |
|---|---|---|---|
| `unauthenticated` | 401 | `outside_window` | 409 |
| `forbidden` | 403 | `conflict` (e.g. duplicate template name and language) | 409 |
| `not_found` | 404 | `rate_limited` | 429 |
| `validation_failed` | 422 | `insufficient_credits` | 402 |
| `no_membership` | 403 | `slot_taken` | 409 |
| `whatsapp_not_connected` | 409 | `plan_required` | 403 |
| `not_available` | 501 | `seat_limit` | 409 |
| `upstream_failed` | 502 | | |
| `internal` | 500 | | |

Every answer to the frontend's origins carries CORS headers, so the browser can read the error
instead of reporting a network failure: a missing route (404; its preflight passes), a method a browser
route doesn't have (405) and a body over the limit (413, sent before the route runs). Requests from
other origins get no CORS headers.

**Meta App Review routes (#15; shapes Fixed in #23):**

- `POST /api/messages/test` `{ to, body }` → `{ providerMsgId, status: "accepted" }`; owner or admin.
- `POST /api/templates` `{ name, category, language, body, examples, header?, footer?, buttons?, connectionId? }`
  → `{ id, name, language, status: "pending" | "draft" }`; owner or admin.
- The test route sends through `notify.send`: `outside_window` (409) when the number has not
  messaged in 24 hours, `conflict` (409) when it opted out, and `notify.send`'s codes otherwise. Since the
  WhatsApp sender is registered (8 Oct), these include the real send's: `rate_limited` (429),
  `whatsapp_not_connected` (409), `validation_failed` (422) and `upstream_failed` (502). The template route
  still answers `not_available` until submission to Meta is built.

**Google Calendar per staff member (built, Day 3; `backend/src/booking/google-calendar.ts`):**

- `GET /api/calendar/google/connect?resourceId=…` → `{ url }`: Google's consent link (offline access,
  scopes `calendar.events`, `calendar.freebusy`, `email`). Owner or admin; a resource of the business. The
  dashboard sends the browser to `url`. `not_available` (501) until `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` are set on Railway.
- `GET /api/calendar/google/callback`: Google sends the browser here. No login: a 10-minute state signed
  with a key derived from `ENCRYPTION_KEY` says who asked, for which business and resource. It stores
  the refresh token encrypted, sets `resources.google_calendar_id`, writes `google_calendar.connected` to
  `audit_logs`, and always answers with a redirect to
  `${NEXT_PUBLIC_APP_URL}/dashboard?google_calendar=connected|denied|failed|not_available&resource=<id>`.
- The dashboard reads `google_calendar_connections` (`google_email`, `status`, `last_error`) under RLS. On
  `needs_reconnect` (Google refused the saved token: access revoked, or the 7-day expiry while the consent
  screen is in Testing), show "Reconnect", which is the same connect link.
- `getGoogleAccessToken(tenantId, resourceId)` gives the calendar sync (Day 4) a fresh access token, or
  null when there is no working connection. Until a resource is connected, the bookings table stays the
  source of truth.

**Read routes (Proposed, screen-contracts Q1).** Entitlements and balances are computed on the
server, so these are routes, not SQL views:

| Route | Returns | Owner |
|---|---|---|
| `GET /api/features` | Every feature with `available`, `enabled`, `creditCost` (`getFeatureStates(…, { fresh: true })`) | Dev 2 |
| `GET /api/billing/balance` | Balance plus renewal date and trial end | Dev 2 |
| `GET /api/dashboard/summary` | Month counts: enquiries, qualified, booked, after-hours handled | Dev 2 |

Plain lists (leads, conversations, bookings, services) are read directly under RLS.

## 7. Rules

- Every query filters by `tenant_id`, including with the service role.
- Every outbound message goes through `notify.send`; every credit change goes through the 0005 functions.
- Secrets live only in `whatsapp_connections`, encrypted; never logged, returned or sent to the browser.
- Phone numbers are masked in logs (`+9198xxxxxx21`).
- Migrations are append-only. Never edit a merged migration.
- No industry names in code; branch on pack capabilities.
- Reminders are relative to an event anchor, never a fixed time.
- Times are ISO 8601 UTC on the wire and `timestamptz` in the database; money is integer rupees.

## 8. Decisions

| # | Decision | Status | Owner |
|---|---|---|---|
| 1 | Template status table | **Agreed** (section 1) | Dev 1 + Dev 2 |
| 2 | Refund when a send fails after spending | **Agreed**: `refund_credits` (0008), same buckets and expiry, once per message | Dev 2 |
| 3 | `NotificationKind`, `SendOutcome`, `NotifyPayload` | Proposed (`test_message` Agreed). **Agreed 8 Oct:** a `failed` outcome keeps the sender's code and carries `retryable` and `outcomeUnknown` | Dev 1 + Dev 2 |
| 4 | Event payloads: ids only, fixed ids for re-sendable events | Proposed | All |
| 5 | Read routes vs views (screen-contracts Q1) | Proposed: routes | Dev 2 + Dev 3 |
| 6 | Prices (screen-contracts Q6) | Handover v1.0 prices, seeded; Raja to confirm. **Confirmed 9 Oct (Raja):** every automated message is 1 credit, inside or outside the 24-hour window; nudges and the other marketing templates included (`CREDIT_COST`, `features.credit_cost`) | Raja |
| 7 | Notification matrix, quiet hours, weekly report, retention (Q7) | Proposed: not in v1 | Raja |
| 8 | `agent_settings` and `last_check` shapes | Open | Dev 1, Dev 3 |
| 9 | Pack `bookingType` vs `bookingModes` | Open | Raja + Dev 1 |
| 10 | PR reviews: CI-only merges vs the plan's paired reviewer | Proposed: paired review for `supabase/`, `packages/` and this file | All |
| 11 | Test message and template routes | **Agreed**; types Fixed in #23, `notify.send` built | Dev 1 + Dev 2 + Dev 3 |
| 12 | `isEnabled` also checks business status (paused, cancelled, trial ended) | Built in #18; confirm | Dev 1 + Dev 2 |
| 13 | One self-serve business per account; repeat signup returns it | Built in #18; confirm | Dev 2 + Dev 3 |
| 14 | Knowledge base: storage, routes, statuses, gaps (section 9) | **Proposed**; schema, router and gap functions built (Shaaz); any team member can answer gaps (Raja); pending Dhatri, and Raja on the rest | Dev 1 |
| 15 | WhatsApp connection routes ([whatsapp-connection-contract.md](whatsapp-connection-contract.md), #44) | **Proposed.** Shaaz's answers (7 Oct): platform admins in a `platform_admins` table; the public connect-link route needs no router change (the token is masked in the request log); link tokens stored hashed; `EMBEDDED_SIGNUP_ENABLED` server flag, off by default; connection status by polling, not Realtime. **Built:** `platform_admins`, `adminRoute`, hashed tokens (0016), `secretParams` log masking (section 6). Roles on recheck and disconnect: Raja | Dev 1 |
| 16 | A send whose outcome is unknown (a timeout, a network failure or an unreadable answer from Meta) | **Proposed by Dev 2 (8 Oct):** hold the credit until Meta's status says sent or failed, instead of refunding. Needs Raja, because it changes billing, and a way to match Meta's status webhook to the send. Until then `notify.send` refunds (decision 2) and reports `outcomeUnknown: true`, so no caller sends the message again | Raja |
| 17 | Handoff SLA (`handoff-sla`) | **Proposed by Dev 2 (9 Oct):** 15 minutes by default, each business can change it (`sla_minutes`, section 3); counted from the handoff at any time of day (business hours not yet considered); the escalation goes to owners only. The handover gives no number | Raja |
| 18 | Lead nudges timing (`lead-nudges`) | **Proposed by Dev 2 (9 Oct):** the handover says "after 2 h and 24 h, then nurture". The second nudge goes at **23 h**, so it is still free text inside the customer's 24-hour window (at 24 h only an approved marketing template could go, and none is approved yet); a lead still quiet at **48 h** moves to nurture. Each business can change all three (section 3) | Raja |

## 9. Knowledge base (PROPOSED, not agreed)

> **PROPOSED.** Shaaz has reviewed his part and built it: the schema (0011), the router and the gap
> functions (0012). Raja has confirmed that any team member can answer a gap. **Still pending Raja**
> (Documents section meaning, FAQ and document write roles) **and Dhatri's review of the routes and
> shapes.** Detail, open questions and the PR order:
> [kb-contract-checklist.md](kb-contract-checklist.md). Owner: Dev 1 (Nithisha).

**Where it runs:** the routes are on the Railway API (`backend/src/server/routes.ts`), at
`${NEXT_PUBLIC_API_URL}/api/kb/...`, `browser: true`, bearer token plus `X-Pakka-Tenant`. The tenant comes
from the token and that header, never the body. Lists are direct RLS reads. The ingest job registers in
`backend/src/inngest/functions.ts` (the one Inngest endpoint is the API's `/api/inngest`).

**Schema (built in `0011_knowledge_base`):** `kb_documents` gains `status text check in
('processing','ready','failed')`, `error text` and `body text` (a FAQ's answer). New rows default to
`processing`, so the FAQ route and the ingest job set `ready` once the chunks are stored. A business can
have each FAQ question once (`lower(btrim(title))` among `source_type = 'manual'` rows, unique), so a
duplicate is a `23505` the FAQ route maps to `conflict`. A new `kb_gaps` table (`tenant_id`, RLS: members
read, only the server writes; unique `(tenant_id, question_norm)`, `question`, `asked_count >= 1`,
`last_contact_id`, `last_asked_at`, `status open|answered|dismissed`, `answered_faq_id`; deleting the
contact or the FAQ clears the link). `kb_documents` joins the Realtime publication. `match_kb_chunks` as in
section 1. `0012_kb_gap_functions` adds `kb_gaps.summary` (the latest chat summary, <= 500 characters),
`answered_by` (deleting the user clears it) and `answered_at`.

**Gap functions (built in `0012_kb_gap_functions`, service_role only):**

```sql
record_kb_gap(p_tenant_id, p_question, p_question_norm, p_summary, p_contact_id default null)
  -> (gap_id, asked_count, status, created)
answer_kb_gap(p_tenant_id, p_gap_id, p_answer, p_answered_by, p_question default null)
  -> (faq_id, question, answer)
```

- `record_kb_gap` (agent pipeline): one upsert on `(tenant_id, question_norm)`. The first ask inserts
  (`created`); a repeat adds 1 to `asked_count`, sets `last_asked_at`, and replaces `summary` and the last
  contact when the call gives them. `question` keeps the first wording (trimmed); the app owns the
  normaliser. An answered gap asked again goes back to `open` (the earlier answer's fields stay); a
  dismissed one stays dismissed. The `kb_gap` handoff uses the returned `asked_count`.
- `answer_kb_gap` (the answer route): locks the gap, then in one transaction writes the FAQ
  (`manual`, `processing`) and closes the gap with `answered_faq_id`, `answered_by` and `answered_at`.
  `p_question` rewords the FAQ's question (null or blank keeps the gap's). A dismissed gap can still be
  answered. The app then embeds the FAQ and sets it `ready`.
- **Errors:** `PA404` → `not_found` (unknown business, or a gap that isn't the business's); `PA409` →
  `conflict` (already answered); `23505` → `conflict` (the question duplicates an FAQ; nothing changes and
  the gap stays open); `P0001` → `validation_failed` (question empty or over 300 characters, empty
  `question_norm`, summary over 500, answer empty or over 2000, a contact from another business, an
  unknown user).

| Route | Request | Response |
|---|---|---|
| `POST /api/kb/faqs` | `{ q, a }` (q <= 300, a <= 2000 chars) | 201 `{ id, q, a }`; `conflict` on a duplicate question |
| `PATCH /api/kb/faqs/:id` | `{ q?, a? }` | `{ id, q, a }` |
| `DELETE /api/kb/faqs/:id` | | 204 |
| `POST /api/kb/documents` | multipart: `file` (+ optional `title`); pdf, docx, txt or md, <= 5 MB | 202 `{ id, title, sourceType: 'upload', status: 'processing', createdAt }` |
| `DELETE /api/kb/documents/:id` | | 204 (chunks cascade) |
| `GET /api/kb/gaps` | | `[{ id, question, askedCount, lastAskedBy }]`, open only, `askedCount` desc; `lastAskedBy` is a contact name or a masked number |
| `POST /api/kb/gaps/:id/answer` | `{ a }` | `{ faq: { id, q, a } }`, gap closed in one transaction |
| `POST /api/kb/gaps/:id/dismiss` | | 204 |

- **Reads:** the FAQ list is `kb_documents` where `source_type = 'manual'` (`title` = question, `body` =
  answer). The documents list is `id, title, source_type, status, created_at`.
- **Errors:** the usual envelope. A too-large or unsupported file is `validation_failed` with
  `fields.file`. No new error codes.
- **Timing:** FAQ saves and gap answers embed inline, so replies see them at once (an embed failure is
  `upstream_failed` and the row is `failed`). Uploads go to an idempotent Inngest job (`kb/document.uploaded`,
  keyed on the document id, chunks deleted before re-insert). The dashboard watches `kb_documents` through
  Realtime, polling while a row is `processing`.
- **Gaps:** pipeline step 5 records one when retrieval is below the threshold, the same event that feeds the
  `kb_gap` handoff after two misses.
- **Roles:** owner and admin write FAQs and documents; owner, admin and staff can answer gaps (Raja
  confirmed, 7 Oct).
- **Router and upload-limit changes: built.** Paths take `:name` segments (`/api/kb/faqs/:id`; a fixed
  path wins over a pattern) and handlers get them as `params`; `PATCH` and `DELETE` are methods, and
  the preflight lists whatever a route has; a route sets `maxBodyBytes` (default 1 MB), applied
  before the body is read. `tenantRoute(handler, { status })` passes `params`, reads JSON only for
  POST, PUT and PATCH, and answers 204 when the service returns nothing. `backend/src/server/` is
  Shaaz's (Dev 2): ask before changing it.
- **Upload and delete: built (Day 2).** `POST /api/kb/documents`: owner or admin (staff get `forbidden`, before the
  upload is read); the file is read in the request (it is not kept), its text goes to `kb_documents.body` as a
  `processing` document, and `kb/document.uploaded` starts the `kb-ingest` job. Refused with `validation_failed` and
  `fields.file`: not a form upload, no file, an empty file, over 5 MB, a kind that is not pdf/docx/txt/md, a file
  that cannot be read, more text than the knowledge base holds (500 chunks), or a business that already has 100
  documents (FAQs are not counted). A title over 200 characters is
  `validation_failed` with `fields.title`; with no title the file name (without folders or extension) is used. If the
  job is refused the document is saved as `failed` (only if it is still `processing`) and the answer is
  `upstream_failed`; if Inngest simply does not answer in time the upload stands as `processing` and the sweep below
  decides.
  `DELETE /api/kb/documents/:id`: owner or admin; an upload or imported document (never an FAQ) of the business, its
  chunks go with it; 204, or `not_found` (unknown id, another business's document, an FAQ, a malformed id).
- **The ingest job** (`kb-ingest`, `backend/src/inngest/kb-ingest.ts`, logic in `backend/src/kb/ingest.ts`): one run
  at a time per document and 5 at once in all, 3 retries per step. Steps: `load`, one `embed-N` per batch of 32
  chunks, `store` (the
  document's chunks are replaced, never added to, then it becomes `ready`). The same event twice changes nothing
  (a `ready` document is skipped); a document that is missing, not the business's, or an FAQ is skipped. A document
  with no text, too much text, a request the provider refuses (4xx other than 429, not retried) or an embeddings
  outage ends `failed` with a short `error` the dashboard can show (never the provider's words). A document deleted
  while the job runs is left deleted. **`kb-sweep`** (cron, every 10 minutes) fails any document still `processing`
  after 30 minutes (its job never started or never finished), with "This file took too long to process. Upload it
  again."
- **Upload size:** a 5 MB file plus its multipart wrapping is more than 5 MB, so the upload route sets
  `maxBodyBytes: 6 * 1024 * 1024` and checks the file itself: over `5 * 1024 * 1024` bytes (the
  frontend's `UPLOAD_MAX_BYTES`) is `validation_failed` with `fields.file`. A body over 6 MB is refused
  before the route runs: 413 `validation_failed`, readable by the frontend but without `fields`.
- **FAQ and gap routes: built (9 Oct)**, `backend/src/kb/faqs.ts`, as the table above. Owner and admin write FAQs
  (staff get `forbidden`); owner, admin and staff list, answer and dismiss gaps. A FAQ is embedded as one text, the
  question then the answer, through the same embed-and-store functions the ingest job uses (`kb/embed-store.ts`). If
  embedding fails the row stays as `failed` (not searchable) and the answer is `upstream_failed`; sending the same
  question again (a POST) or a PATCH retries it (a POST of a question whose earlier save is `failed` reuses that row; one
  whose FAQ is `ready` is a `conflict`). A failed `POST .../answer` leaves the gap answered and the FAQ `failed`:
  retry with a PATCH on that FAQ. An edit makes the FAQ `processing` again until its new chunks are stored. Two saves
  of one FAQ at once: after embedding, a save checks the FAQ still has the text it embedded and stores nothing if not
  (the newer save stores its own), and a late failure only marks `failed` a FAQ that is still `processing`. The
  `kb-sweep` job does not touch FAQs. A duplicate
  question (`23505`) is `conflict`, as is answering an answered gap; a gap or FAQ of another business, an upload sent to
  a FAQ route, and a malformed id are all `not_found`. `validation_failed` carries `fields.q` / `fields.a`. Dismiss
  needs no body and also works on an already dismissed gap; an answered gap cannot be dismissed (`not_found`).
  `GET /api/kb/gaps` returns the open gaps, most asked first and then most recent, at most 100; `lastAskedBy` is the
  contact's name, else the number masked (`+9198xxxxxx21`), else `null` if the contact was deleted. **The gap key is
  `normaliseQuestion`** (`kb/question.ts`): NFKC, lowercase, zero-width characters removed, every character that is not
  a letter, combining sign or digit a space, spaces collapsed (Tamil and Hindi vowel signs are kept); an empty result
  is not recorded. `asked_count` is business-wide and only feeds the dashboard's most-asked list; the `kb_gap` handoff
  is two misses in a row in one conversation, tracked by the pipeline.
- **Build order:** migration, then `backend/src/kb` and the embeddings client (mocked provider), then the
  router PR, then upload and the ingest job, then FAQ routes, then gaps. **FAQ routes and gaps may slip to
  Day 3.**
