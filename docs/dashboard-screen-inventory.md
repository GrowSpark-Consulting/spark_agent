# Dashboard screen inventory

Owner: Dev 3. Reviewers: Dev 1, Dev 2. Status: **draft for review**. Covers the dashboard at `/dashboard` in
`frontend/` as of 5 Oct 2026. Data shapes for each screen are in
[dashboard-screen-contracts.md](dashboard-screen-contracts.md); how the dashboard relates to the
onboarding wizard is in [frontend-architecture-map.md](frontend-architecture-map.md).

## How to read this

- **Route** is today's URL and the route proposed once the dashboard has real routes. Today every
  screen is `/dashboard` with in-memory state; `?screen=<key>` only picks the screen on first load.
- **Roles** come from `memberships.role` (`owner`, `admin`, `staff`). The split below is a **proposal
  for Raja to confirm**. Hiding a screen in the UI is only for usability; every API route and RLS policy
  must check the role on the server.
- **Data source today** is always fixture data from `frontend/fixtures/dashboard/` held in component state.
  No screen calls an API.
- **API dependency status:**
  - **EXISTS**: implemented in this repo today.
  - **HANDOVER**: specified in `docs/handover.md` but not built yet.
  - **RLS READ**: a direct Supabase read under row-level security (the handover's default for dashboard
    reads). It needs the table, view and policy, not an API route.
  - **PROPOSED**: needed by the UI but not in the handover. It needs the owner's agreement before anyone
    builds it.
- **Tenant scope**: always the signed-in user's tenant, resolved on the server from the Supabase session
  and `memberships`. No screen sends a tenant id; the `?industry=` switch is a prototype demo control
  and goes away.

### Routes that exist today

| Route | Where | What |
|---|---|---|
| `GET /api/health` | root app | Liveness check |
| `GET/POST/PUT /api/inngest` | root app | Inngest function host |
| `/`, `/onboarding` | frontend | Redirect, then the onboarding wizard (client-side steps) |
| `/dashboard` | frontend | The whole dashboard (client-side screens) |

Nothing else exists. Every dependency below is HANDOVER, RLS READ or PROPOSED.

**Update, 7 Oct 2026:** the prototype moved to `/dashboard/preview` (still fixtures). Real routes now
exist for two screens; their status is under "Real route" in sections 2 and 7.

| Route | Data |
|---|---|
| `/dashboard/inbox[?chat=<id>]` | RLS READ `conversations`, `contacts`, `handoffs`, `messages`; Realtime (migration 0010) |
| `/dashboard/knowledge` | RLS READ/WRITE `services`; RLS READ `kb_documents` |

### Proposed role access

| Screen | owner | admin | staff | Notes |
|---|---|---|---|---|
| Home | ✓ | ✓ | ✓ | Staff see their own hot leads and bookings; credit meter read-only |
| Inbox | ✓ | ✓ | ✓ | Staff: assigned chats plus unassigned handovers (to confirm) |
| Leads | ✓ | ✓ | ✓ | Staff may be limited to leads they own (to confirm) |
| Calendar | ✓ | ✓ | ✓ | Staff act on their own bookings |
| Features | ✓ | ✓ | view | Toggling changes credit spend |
| Agent settings | ✓ | ✓ | – | |
| Knowledge base | ✓ | ✓ | answer gaps only (to confirm) | |
| Templates | ✓ | ✓ | – | Submitting to Meta changes the business's WhatsApp account |
| Billing & credits | ✓ | view | – | Payments are owner-only |
| Team | ✓ | ✓ | view self | Invites enforce the seat limit server-side |
| Settings › My profile | ✓ | ✓ | ✓ | Own profile only |
| Settings › other sections | ✓ | ✓ | – | Disconnect WhatsApp and Close account are owner-only |

---

## 1. Home

**Route:** today `/dashboard` or `/dashboard?screen=home`; proposed `/dashboard`
**Purpose:** Morning overview: credits, trial, month summary, hot leads waiting, today's bookings.
**Roles:** owner, admin, staff (staff see their own items).
**Current data source:** fixtures `shell.ts` (`RE_STATS`, `RE_HOT`, `RE_TODAY`), `plans.ts`
(`SAMPLE_BALANCES`, `TRIAL_CREDITS`, `PLAN_CREDITS`), `industries.ts`. The credit balance and banners
are computed in the browser from `?account=` and `?credits=`.
**Future API dependency:**
- `GET /api/dashboard/summary`: **PROPOSED**, Dev 2. Month stats, hot-lead list, today's bookings
  in one call.
- `GET /api/billing/balance`: **PROPOSED**, Dev 2. Wraps `getBalance()` plus plan, trial end and
  renewal date.
- Fallback per part: **RLS READ** of `leads`, `bookings`, `conversations`, `handoffs`.
**HTTP method:** GET.
**Request:** none (tenant from session). Optional `?month=YYYY-MM` later.
**Response:** `DashboardSummary` and `AccountStatus` (see contracts).
**Loading state:** Not built yet. Needs skeletons for the credit meter, 4 stat cells, 2 lists.
**Empty state:** Built (`?firstDay=1`): zero stats, "Maya is live…", empty lists.
**Error state:** Not built yet. Needs an inline retry per card, with the rest of Home still usable.
**Feature flag:** none to view. The "Maya is replying / Auto-reply off" status follows `ai_auto_reply`.
**Plan restriction:** none. Trial countdown when `tenant.status = 'trial'`.
**Tenant scope:** session tenant.
**Owner:** UI Dev 3 · summary and balance Dev 2.

## 2. Inbox

**Route:** today `/dashboard?screen=inbox[&chat=<id>]`; proposed `/dashboard/inbox`, `/dashboard/inbox/[conversationId]`
**Purpose:** Realtime chat list and conversation; AI/Human switch; lead card; suggested reply;
templates outside the 24-hour window.
**Roles:** owner, admin, staff.
**Current data source:** `shell.ts` `convs()` (conversations with messages and lead card),
`CLOSED`, `TPLS`; `industries.ts`. Sending, mode switch and template send only change local state.
**Future API dependency:**
- Conversation list and messages: **RLS READ** of `conversations`, `contacts`, `messages`, plus
  Supabase Realtime. Dev 3, schema by Dev 2.
- Lead card: `buildLeadCard(leadId)`: **HANDOVER** contract (Dev 1). Needs a read route; see contracts.
- `POST /api/conversations/:id/messages`: **HANDOVER**, Dev 3 (sends through `notify.send`, Dev 2).
- `POST /api/conversations/:id/mode`: **HANDOVER**, Dev 3.
- `POST /api/conversations/:id/suggest`: **HANDOVER**, Dev 1.
- Approved templates list: **RLS READ** of the template status table (Dev 2, schema not defined yet).
**HTTP method:** GET (RLS), POST (actions).
**Request:** message `{ body } | { template: { name, lang, params } }`; mode `{ mode: 'ai'|'human' }`.
**Response:** `Conversation[]`, `Message[]`, `LeadCard`, `SendOutcome`.
**Loading state:** Not built yet. Needs list skeleton, chat skeleton, and a pending bubble while a send is in flight.
**Empty state:** Built (`?firstDay=1`): no chats plus copy-test-link; "no filter match" is built too.
**Error state:** Not built yet. Needs a failed-send bubble with retry, a lost-realtime banner, and an `OutsideWindowError` → template prompt (the window-closed strip exists).
**Feature flag:** `ai_auto_reply` (status), `handoff_triggers`, `handoff_own_number` (takeover options).
**Plan restriction:** none to view. Own-number takeover is Growth+.
**Tenant scope:** session tenant; RLS on every table.
**Owner:** UI Dev 3 · lead card and suggest Dev 1 · send pipeline and credits Dev 2.

**Real route (7 Oct 2026):** `/dashboard/inbox`, code in `frontend/features/inbox/`.
- Built: chat list and chat (RLS reads), AI / Needs human / Human / Own number tags (mode + open
  handoff), search, All / AI handling / Needs human filters, one Realtime channel per business, loading,
  empty, error and "live updates aren't connected" states.
- Shown switched off: Unread (no unread data), AI/Human switch, message box and Send.
- Not built: lead card, suggested reply, templates, sending (`POST /api/conversations/:id/messages`
  and `/mode`). No persona or staff names exist yet, so bubbles say "AI" and "Staff".
- Database tests (`inbox_rls.test.sql`) and migration 0010 have not been run yet.

## 3. Leads

**Route:** today `/dashboard?screen=leads`; proposed `/dashboard/leads`, `/dashboard/leads/[leadId]`
**Purpose:** Kanban by stage, score and source filters, lead detail with fields and timeline.
**Roles:** owner, admin, staff.
**Current data source:** `leads.ts` (`LEADS`, `STAGES`, `OWNERS`, `RE_TIMELINE`), `industries.ts`.
Stage moves are local.
**Future API dependency:**
- `leads`, `contacts`: **RLS READ**. Pack field labels from `vertical_packs` (Dev 1).
- Lead timeline: **PROPOSED** `GET /api/leads/:id/timeline`, Dev 2 (from `audit_logs`, `messages`,
  `bookings`, `handoffs`), or a SQL view.
- Stage change and owner change: **PROPOSED** `PATCH /api/leads/:id`, Dev 3 (audit log required).
**HTTP method:** GET, PATCH.
**Request:** filters `stage`, `temperature`, `source` (query).
**Response:** `Lead[]`, `LeadDetail`.
**Loading state:** Not built yet. Needs column skeletons.
**Empty state:** Built (`?firstDay=1`).
**Error state:** Not built yet.
**Feature flag:** `lead_qualification` (scores shown only when on).
**Plan restriction:** none.
**Tenant scope:** session tenant.
**Owner:** UI Dev 3 · scoring and fields Dev 1 · timeline data Dev 2.

## 4. Calendar

**Route:** today `/dashboard?screen=calendar`; proposed `/dashboard/calendar?view=day|week&resource=`
**Purpose:** Day/week per staff or resource; reschedule, cancel, mark visited or no-show.
**Roles:** owner, admin, staff.
**Current data source:** `calendar.ts` (`DAYS`, `TODAY`, `STAFF`, `INIT`, `RE_CAL` incl. free slots),
`industries.ts`.
**Future API dependency:**
- `bookings`, `resources`, `services`: **RLS READ**.
- Free slots for reschedule: `findSlots()`: **HANDOVER** contract (Dev 2); needs a read route,
  **BUILT** `GET /api/bookings/:id/slots` (Dev 2, 12 Oct).
- `POST /api/bookings/:id/(reschedule|cancel|complete|no-show)`: **BUILT**, Dev 2 (12 Oct; docs/contracts.md, section 4). Staff act only on their own calendar's bookings.
**HTTP method:** GET, POST.
**Request:** `reschedule { slot }`, `cancel { reason }`.
**Response:** `Booking[]`, `Slot[]`, updated `Booking`.
**Loading state:** Not built yet.
**Empty state:** Partly built: days with no bookings render empty.
**Error state:** Not built yet. Needs "slot was just taken" (exclusion constraint) → refresh slots.
**Feature flag:** `booking`; reminders reset on reschedule (`reminder_24h`, `reminder_2h`).
**Plan restriction:** none.
**Tenant scope:** session tenant; times shown in `tenants.timezone`.
**Owner:** UI Dev 3 · booking engine and actions Dev 2.

## 5. Features

**Route:** today `/dashboard?screen=features`; proposed `/dashboard/features`
**Purpose:** Feature toggles grouped by area, locked items with Upgrade, credits per month estimate,
reminder timing, working-hours mode.
**Roles:** owner, admin (staff view only).
**Current data source:** `plans.ts` (`FEATURES`, `GROUPS`, `PLAN_*`); toggle state, lock state and
estimate are computed **in the browser**. That has to move to the server.
**Future API dependency:**
- `GET /api/features`: **BUILT**, Dev 2 (12 Oct). Features × plan × tenant toggles × 30-day usage, computed on the
  server (docs/contracts.md, section 6).
- `PATCH /api/features/:key`: **BUILT**, Dev 2 (checks plan, writes audit log).
**HTTP method:** GET, PATCH.
**Request:** `{ enabled?: boolean, settings?: Record<string, unknown> }`; settings keys are the jobs' own (`offset_minutes` in minutes, `review_url`, …; docs/contracts.md, section 3). Working-hours mode is not built yet (shown as disabled).
**Response:** `FeatureList` (see contracts: available / locked / disabled per feature).
**Loading state:** Not built yet. Needs a per-row pending switch while a PATCH is in flight.
**Empty state:** not applicable.
**Error state:** Not built yet. On PATCH failure, revert the switch and show a toast. A 403 `plan_required` opens the Upgrade dialog.
**Feature flag:** this screen is the flag UI.
**Plan restriction:** lock state per feature from the plan's `feature_keys`.
**Tenant scope:** session tenant.
**Owner:** UI Dev 3 · API Dev 2.

## 6. Agent settings

**Route:** today `/dashboard?screen=agent`; proposed `/dashboard/agent`
**Purpose:** Persona name and tone, languages, business hours, scoring weights and thresholds,
handover triggers, takeover default.
**Roles:** owner, admin.
**Current data source:** `agent.ts` (`CRIT`, `TRIG`, `LANGS`), `industries.ts` (`agent`); preview text
is fixture copy.
**Future API dependency:**
- `tenants.agent_settings`, `tenants.business_hours`, `tenants.pack_overrides`: **RLS READ**.
- Save: **PROPOSED** `PATCH /api/agent/settings`, Dev 1 (validates overrides against the pack
  with Zod; overrides cannot remove required fields or hard fails).
- Pack scoring rules and triggers: `vertical_packs` (Dev 1).
**HTTP method:** GET, PATCH.
**Request:** `AgentSettingsInput`.
**Response:** `AgentSettings`.
**Loading state:** Not built yet.
**Empty state:** not applicable (pack defaults).
**Error state:** Not built yet. Show validation errors per field (e.g. weights must total 100; the UI already shows the total).
**Feature flag:** `lead_qualification`, `handoff_triggers`, `working_hours_mode`.
**Plan restriction:** custom scoring weights are **Pro** (`custom_scoring`); own-number takeover is
Growth+ (`handoff_own_number`). Neither is locked in the prototype today.
**Tenant scope:** session tenant.
**Owner:** UI Dev 3 · settings contract Dev 1.

## 7. Knowledge base

**Route:** today `/dashboard?screen=knowledge`; proposed `/dashboard/knowledge`
**Purpose:** Services and prices, FAQs, document upload, website re-sync, "questions Maya couldn't
answer".
**Roles:** owner, admin (staff: answer gaps, to confirm).
**Current data source:** `knowledge.ts` (`GAPS`, `FAQS`), `industries.ts` (`kb`). Answers, uploads and
sync are local.
**Future API dependency:**
- `kb_documents`, `services`, `catalog_items`: **RLS READ**.
- `POST /api/kb/documents`: **HANDOVER**, Dev 1 (upload, chunk, embed).
- `POST /api/onboarding/import-site`: **HANDOVER**, Dev 1 (also used by "Sync website again").
- FAQ create/edit and answering a gap: **PROPOSED** `POST/PATCH /api/kb/faqs`, Dev 1 (must re-embed).
- Unanswered questions list: **PROPOSED** `GET /api/kb/gaps`, Dev 1 (needs a source table; not in the
  schema).
**HTTP method:** GET, POST, PATCH.
**Request:** multipart upload; `{ q, a }`.
**Response:** `KnowledgeBase`.
**Loading state:** Not built yet. Needs upload and embedding progress.
**Empty state:** Built (`?firstDay=1`).
**Error state:** Not built yet. Needs upload failed or unsupported type, and import failed.
**Feature flag:** none.
**Plan restriction:** none known.
**Tenant scope:** session tenant.
**Owner:** UI Dev 3 · ingestion, retrieval and gaps Dev 1.

**Real route (7 Oct 2026):** `/dashboard/knowledge`, code in `frontend/features/knowledge/`.
- Built: Services & prices (list, add, edit, delete under RLS; validation before saving; a delete
  blocked by bookings is explained), documents list from `kb_documents` (title, source, date).
- Shown as not available, no data and no saving: unanswered questions, FAQs, Upload. The ported list
  components take the PROPOSED `KnowledgeBase.faqs` / `gaps` shapes and are wired when Dev 1's
  contracts exist (open question 3 above, `POST /api/kb/documents` shape).
- Not shown: website sync (`POST /api/onboarding/import-site` not built); a document processing
  status (no column in `kb_documents`, though the PROPOSED shape has one).
- Database test `services_rls.test.sql` has not been run yet.

## 8. Templates

**Route:** today `/dashboard?screen=templates`; proposed `/dashboard/templates`, `/dashboard/templates/[key]`
**Purpose:** WhatsApp template list with Meta status per language, editor, new-version builder
with live preview, send stats.
**Roles:** owner, admin.
**Current data source:** `templates.ts` (`V`, `BASE`, `FEATS`). Submit only changes local state.
**Future API dependency:**
- Template status table: **RLS READ** (Dev 2; seeded by `whatsapp/connected`, schema not defined).
- Submit a new version: **PROPOSED** `POST /api/templates`, Dev 2. A changed template is a new
  version submitted to Meta, never an edit in place.
- Send counts and read rate: **PROPOSED** from `messages.template_name` (Dev 2).
**HTTP method:** GET, POST.
**Request:** `TemplateDraft`.
**Response:** `Template[]`.
**Loading state:** Not built yet.
**Empty state:** not applicable (seeded per pack).
**Error state:** Not built yet. Needs Meta rejection reason (the UI shows one from fixtures).
**Feature flag:** each template is linked to the feature that sends it.
**Plan restriction:** none known.
**Tenant scope:** session tenant; templates live on the tenant's own WABA.
**Owner:** UI Dev 3 · Meta submission and status Dev 2 (via Dev 1's adapter `sendTemplate`).

## 9. Billing & credits

**Route:** today `/dashboard?screen=billing`; proposed `/dashboard/billing`
**Purpose:** Plan, next bill, daily usage, credit history, top-ups, monthly/yearly, plan change,
setup add-on, invoices.
**Roles:** owner (admin view only).
**Current data source:** `billing.ts` (`PLANS`, `USE`), `plans.ts` (`TOPUP_PACKS`). Plan change and
top-up are simulated.
**Future API dependency:**
- `GET /api/billing/balance`: **PROPOSED**, Dev 2 (see Home).
- Credit history: **RLS READ** of `credit_ledger` (or a view with readable reasons).
- Daily usage: **PROPOSED** view or route, Dev 2.
- `POST /api/billing/checkout`, `/topup`, `/change-plan`: **HANDOVER**, Dev 2 (Razorpay).
- Invoices: **PROPOSED**, Dev 2 (open question: Razorpay invoices or our own numbering).
**HTTP method:** GET, POST.
**Request:** `{ planKey, cycle: 'monthly'|'yearly' }`, `{ pack }`.
**Response:** `AccountStatus`, `LedgerEntry[]`, Razorpay order/subscription for the checkout widget.
**Loading state:** Not built yet. Needs a payment-in-progress state while Razorpay is open.
**Empty state:** not applicable.
**Error state:** Not built yet. Needs payment failed or cancelled, with the balance left unchanged.
**Feature flag:** `auto_topup`.
**Plan restriction:** shows the current plan; downgrades apply from the next renewal.
**Tenant scope:** session tenant.
**Owner:** UI Dev 3 · Razorpay, ledger and plans Dev 2.
**Note:** prototype prices and credits (₹1,999 / 1,000 …) differ from the v1.0 specs
(₹2,499 / 1,500 …). The specs win unless Raja decides otherwise; see `docs/dev2-roadmap.md`.

## 10. Team

**Route:** `/dashboard/team` (real, first slice); the full screen is still `/dashboard?screen=team` in the preview
**Purpose:** Staff list, roles, invite, WhatsApp alert preferences, takeover preference.
**Built (first slice):** "Your WhatsApp alerts": every member (owner, admin, staff) reads and sets their own
`memberships.whatsapp_phone` (E.164, `PhoneInput`) under RLS (0002 `own_preferences`), filtered by business and
member; an update RLS refuses returns no row and is reported as not saved (`features/team/`).
**Not built, and why:** members list (no profile table for names), invites (`POST /api/team/invite` not built),
alert choices (no column), takeover preference (the own-number and "ask" options need `handoff_own_number`, and no
server-computed entitlement is readable from the browser yet).
**Roles:** owner, admin (staff view self).
**Current data source:** `team.ts` (`ALERTS`, `INIT`), `industries.ts` (`team`).
**Future API dependency:**
- `memberships` (+ user profile): **RLS READ**.
- `POST /api/team/invite`: **HANDOVER**, Dev 3 (enforces the seat limit).
- Update alerts, takeover and role: **PROPOSED** `PATCH /api/team/:userId`, Dev 3.
**HTTP method:** GET, POST, PATCH.
**Request:** `{ name, phone, role }`.
**Response:** `TeamMember[]`.
**Loading state:** Not built yet.
**Empty state:** not applicable (owner always present).
**Error state:** Not built yet. Needs seat limit reached → Upgrade, and invalid phone.
**Feature flag:** `staff_alerts`, `handoff_own_number` (takeover option).
**Plan restriction:** seats per plan (Starter 2, Growth 5, Pro unlimited in the specs).
**Tenant scope:** session tenant.
**Owner:** Dev 3.

## 11. Settings

**Route:** today `/dashboard?screen=settings` (section in component state); proposed `/dashboard/settings/[section]`
with sections `profile`, `business`, `services`, `whatsapp`, `notifications`, `security`, `data`.
**Purpose:** Profile, business details, services and booking rules, WhatsApp connection health,
notification matrix, sessions and 2-step check, data export, close account.
**Roles:** everyone (profile); owner and admin (other sections); owner only for Disconnect and Close account.
**Current data source:** `settings.ts` (`RE_BIZ`, `EX`, `SVC`, `EVENTS`), `industries.ts`. Some sample
rows are still built inline in `pakka-settings.tsx` `renderVals()` because they're made from component
state: sessions, activity log, connection log, WhatsApp health numbers, approved-template list.
**Future API dependency:**
- Profile and business: **RLS READ** of `tenants`, `memberships`; saves **PROPOSED** `PATCH /api/settings/*`.
- Services and booking rules: **RLS READ** of `services`, `resources`. Book-ahead window is not in
  the schema yet (see `docs/dev2-roadmap.md`).
- WhatsApp: **RLS READ** of `whatsapp_connections_public` only (never the base table);
  `POST /api/whatsapp/connections/:id/recheck` and `/disconnect`: **HANDOVER**, Dev 1.
- Google Calendar: `GET /api/calendar/google/connect`: **HANDOVER**, Dev 2.
- Notification matrix, quiet hours, weekly report: **PROPOSED**, Dev 2 (not in the specs).
- Sessions and 2-step check: Supabase Auth (Dev 3); export and close account: **PROPOSED**.
**HTTP method:** GET, PATCH, POST.
**Loading state:** Not built yet.
**Empty state:** WhatsApp "Disconnected" state is built.
**Error state:** Not built yet. Health "Needs attention" is built (hotel sample).
**Feature flag:** none to view.
**Plan restriction:** extra WhatsApp numbers are Pro (up to 3).
**Tenant scope:** session tenant. Tokens and app secrets never reach the browser.
**Owner:** UI Dev 3 · WhatsApp connection Dev 1 · notifications and calendar Dev 2.

---

## Screens in the handover that are not in this dashboard

| Screen | Status | Where |
|---|---|---|
| Signup and onboarding wizard | `/onboarding` in `frontend/` (prototype, no backend) | see frontend-architecture-map.md |
| Connect-link page `/connect/:token` | Not designed | Dev 3 |
| Admin panel (internal) | Not designed | Dev 3 |
| Landing page | Not designed | Dev 3 |
| Handoff takeover `/h/:token` | Server redirect, no screen | Dev 1 |
| Catalog editor, quote approval queue (M7, travel) | Not designed | Dev 2 / Dev 3 |

## Shared dialogs and overlays

| Dialog | Trigger | Future dependency |
|---|---|---|
| Top up credits → credits added | credits pill, sidebar Top up, banners | `POST /api/billing/topup` (HANDOVER, Dev 2) |
| Upgrade (locked feature) | Upgrade on a locked feature | `POST /api/billing/change-plan` (HANDOVER, Dev 2) |
| Send a template | chat outside 24 h | `POST /api/conversations/:id/messages` with template (HANDOVER) |
| Disconnect WhatsApp | Settings › WhatsApp | `POST /api/whatsapp/connections/:id/disconnect` (HANDOVER, Dev 1) |
| Close account | Settings › Data & privacy | PROPOSED, owner only |
| Lead card sheet (below 1180 px) | Inbox › Lead | lead card read |
| More sheet (mobile) | tab bar › More | none |
