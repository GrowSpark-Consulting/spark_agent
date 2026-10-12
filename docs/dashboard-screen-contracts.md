# Dashboard screen contracts

Owner: Dev 3. Reviewers: Dev 1, Dev 2. Status: **draft for review. Nothing here is implemented.**

What each dashboard screen needs from the backend, in the shape the UI will consume it. Dev 1 and
Dev 2 can build APIs, views and RLS policies against these shapes. Dev 3 replaces
`frontend/fixtures/dashboard/*` with them screen by screen. Screen-level status (which routes exist, roles,
owners) is in [dashboard-screen-inventory.md](dashboard-screen-inventory.md).

Every shape below is a **proposal**. Field names follow the database in `docs/handover.md` where a
column exists. A change to an agreed shape goes through a pull request like any other contract.

## Rules that apply to every screen

1. **Tenant comes from the session.** The browser never sends `tenantId`. Server routes resolve it from
   the Supabase session and `memberships`. Direct reads rely on RLS (`is_member(tenant_id)`), and server
   code still filters by `tenant_id`.
2. **Roles are enforced on the server.** The UI hides what a role can't use. Every route checks
   `memberships.role` and returns `403 { error: { code: 'forbidden' } }` regardless.
3. **Entitlements are computed on the server.** Whether a feature is available on the plan, how many
   credits remain, seat limits: all of it comes from Dev 2's code (`isEnabled`, `getBalance`, plan
   checks). The browser renders the result and never derives it from a plan name.
4. **Errors** use the handover envelope `{ error: { code: string, message: string } }` with the HTTP
   status. Codes the UI branches on: `unauthenticated`, `forbidden`, `not_found`, `validation_failed`,
   `plan_required`, `seat_limit`, `insufficient_credits`, `outside_window`, `slot_taken`, `conflict`,
   `upstream_failed`.
5. **No secrets in responses.** No WhatsApp tokens, app secrets, Razorpay secrets, service-role keys or
   encryption keys. WhatsApp connection data comes only from `whatsapp_connections_public`.
6. **Validation:** routes validate input with Zod. The shared types for these shapes should live in
   `packages/types` (`@pakka/types`, shared ownership).
7. **Times** are ISO 8601 UTC strings. The UI formats them in `tenant.timezone`.
8. **Money** is integer rupees (`price_inr`), as in the `plans` table.

## Every screen has these states

| State | UI behaviour | Built in prototype? |
|---|---|---|
| Loading | Skeleton in the screen's layout; the shell (nav, credits pill) stays usable | No |
| Empty | Screen-specific copy, shown on first day (`?firstDay=1`) | Home, Inbox, Leads, Knowledge |
| Error | Inline message with Retry; a write failure reverts the optimistic change and shows a toast | No |
| Forbidden | "Ask the owner" note in place of the screen | No |
| Paused | Banner when credits are 0 or the trial ended (account state from the server) | Yes |

The empty and paused designs exist. Loading, error and forbidden still need designing. That's the
first Dev 3 task once integration starts.

---

## Shell (every screen)

```
UI: sidebar / tab bar, business name, plan, credits pill and meter, Maya status, banners
  ↓ data
AccountStatus + Me
  ↓ API
GET /api/me                                  PROPOSED · Dev 3  (session → membership → tenant)
GET /api/billing/balance                     PROPOSED · Dev 2  (getBalance + plan + trial)
  ↓ loading: shell renders with a credits placeholder
  ↓ error: shell renders; credits pill shows "–"; banner logic is skipped
  ↓ permission: any member
  ↓ plan: none
```

```ts
type Role = 'owner' | 'admin' | 'staff';

interface Me {
  user: { id: string; name: string; initials: string; phone: string; email: string | null };
  role: Role;
  tenant: {
    name: string; sector: string; city: string;   // sector = pack label, not a branch key
    timezone: string;
    vertical: string; verticalVersion: number;    // UI reads capabilities from the pack, never the name
    testCode: string | null;                      // TRIAL-xxxx route code
  };
}

interface AccountStatus {
  status: 'trial' | 'active' | 'paused' | 'cancelled';
  plan: { key: 'trial' | 'starter' | 'growth' | 'pro'; name: string; monthlyCredits: number };
  credits: { plan: number; topup: number; total: number };   // getBalance()
  creditsGranted: number;            // denominator for the meter this cycle
  renewsAt: string | null;           // "Resets 1 Nov"
  trialEndsAt: string | null;        // "4 days left in your trial"
  aiPaused: boolean;                 // server decides (zero credits, trial ended, disconnected)
  lowCredits: boolean;               // server decides the 80 % / 20 %-left threshold
  aiAutoReply: boolean;              // isEnabled('ai_auto_reply')
}
```

Replaces: `SAMPLE_BALANCES`, `TRIAL_CREDITS`, `PLAN_CREDITS`, `RE_BIZ`, the `?account=`, `?credits=`,
`?plan=`, `?industry=` URL switches.

## Home

```
UI: date, month summary (4 stats), hot leads waiting, today's bookings
  ↓ data: DashboardSummary
  ↓ API: GET /api/dashboard/summary          PROPOSED · Dev 2
  ↓ loading: 4 stat skeletons + 2 list skeletons
  ↓ empty: first-day copy (built)
  ↓ error: per-card retry
  ↓ permission: all; staff get their own hot leads and bookings
  ↓ plan: none
```

```ts
interface DashboardSummary {
  month: string;                                   // '2026-10'
  stats: { enquiries: number; qualified: number; booked: number; afterHours: number;
           enquiriesChangePct: number | null };    // UI writes the notes ("+18% vs September")
  overnightHandled: number;                        // "Maya handled 9 chats overnight"
  hotLeads: { leadId: string; conversationId: string; name: string; need: string; score: number;
              temperature: 'hot' | 'warm' | 'cold'; reason: string; waitingSince: string | null;
              assignedTo: string | null }[];
  todayBookings: { bookingId: string; startAt: string; name: string; place: string;
                   staff: string; status: 'held' | 'confirmed' }[];
}
```

Replaces: `RE_STATS`, `RE_HOT`, `RE_TODAY`, `industries.*.stats|hot|bookings`.

## Inbox

```
UI: filters (All / AI handling / Needs human / Unread), search, chat list, chat, AI/Human switch,
    suggested reply, lead card, 24-hour window strip, template dialog
  ↓ data: ConversationSummary[], Message[], LeadCard, ApprovedTemplate[]
  ↓ API: RLS READ conversations + contacts + messages, Realtime on messages/conversations   Dev 3
        GET  /api/conversations/:id/lead-card            PROPOSED · Dev 1 (wraps buildLeadCard)
        POST /api/conversations/:id/messages             HANDOVER · Dev 3 → notify.send (Dev 2)
        POST /api/conversations/:id/mode                 HANDOVER · Dev 3
        POST /api/conversations/:id/suggest              BUILT · Dev 1 → { reply: string|null, language, reason: "unavailable"|null }
  ↓ loading: list and chat skeletons; outgoing bubble shows "sending"
  ↓ empty: first-day copy + copy test link (built); "no chats match" (built)
  ↓ error: failed bubble + Retry; outside_window → template dialog; realtime lost → banner
  ↓ permission: all members; staff see assigned + unassigned handovers (to confirm)
  ↓ plan: own-number takeover is Growth+ (handoff_own_number)
```

```ts
interface ConversationSummary {
  id: string; contactId: string; leadId: string | null;
  name: string; initials: string;
  phoneMasked: string;            // '+91 98xxx xxx21', masked on the server
  language: string | null;
  mode: 'ai' | 'human' | 'external';
  needsHuman: boolean;            // an open handoff
  assignedTo: { userId: string; name: string } | null;
  unread: number;
  score: number | null; temperature: 'hot' | 'warm' | 'cold' | 'disqualified' | null;
  lastMessage: { sender: 'customer' | 'ai' | 'staff' | 'system'; preview: string; at: string };
  windowOpenUntil: string | null; // last_customer_msg_at + 24 h; null = closed
}

interface Message {
  id: string; direction: 'in' | 'out';
  sender: 'customer' | 'ai' | 'staff' | 'system';
  staffName?: string;
  body: string | null;
  media?: { kind: 'image' | 'document' | 'audio'; name: string; meta: string; url: string };
  buttons?: string[];              // interactive list or buttons the AI sent
  templateName?: string;
  deliveryStatus: 'sent' | 'delivered' | 'read' | 'failed' | null;
  creditsCharged: number;
  createdAt: string;
}

interface LeadCard {                // buildLeadCard(leadId), Dev 1
  need: string; languageNote: string; source: string;
  answers: string[];                // qualifying answers, labelled by the pack
  score: number; temperature: string;
  booking: string | null;           // "Site visit today, 11:00 am · Aster"
  trigger: string | null;           // why it was handed over
  sentiment: string;
  summary: string; nextStep: string;
  owner: string | null;
}

type SendMessageInput =
  | { body: string }
  | { template: { name: string; lang: 'en' | 'ta'; params: string[] } };

interface SendOutcome { messageId: string; creditsCharged: number; status: 'sent' | 'queued' }
```

Replaces: `convs()`, `CLOSED`, `TPLS`, `industries.*.convs`.

## Leads

```
UI: kanban by stage, score filter (All/Hot/Warm/Cold), source filter, lead detail with fields + timeline
  ↓ data: LeadListItem[], LeadDetail
  ↓ API: RLS READ leads + contacts; pack field labels from vertical_packs (Dev 1)
        GET   /api/leads/:id/timeline        PROPOSED · Dev 2 (or a SQL view)
        PATCH /api/leads/:id                 PROPOSED · Dev 3 (stage/owner; audit log)
  ↓ loading: column skeletons · empty: first day (built) · error: retry
  ↓ permission: all; staff possibly own leads only
  ↓ plan: none
```

```ts
type Stage = 'new' | 'engaged' | 'qualified' | 'booked' | 'visited' | 'won' | 'lost' | 'nurture' | 'human';

interface LeadListItem {
  id: string; name: string; stage: Stage; score: number | null;
  need: string; source: string; owner: { userId: string; name: string; initials: string } | null;
  phoneMasked: string;
}
interface LeadDetail extends LeadListItem {
  fields: { key: string; label: string; value: string }[];   // pack field schema + leads.fields
  summary: string;
  timeline: { at: string; kind: 'enquiry' | 'ai' | 'booking' | 'alert' | 'handover' | 'visited' | 'won' | 'lost';
              text: string }[];
}
```

Stage labels come from the pack, not from code (`STAGES` and per-industry `leads.stages` today).
Replaces: `LEADS`, `STAGES`, `OWNERS`, `RE_TIMELINE`, `industries.*.leads`.

## Calendar

```
UI: day / week, filter by staff (resource), booking detail, reschedule (pick slot), cancel,
    mark visited, mark no-show, undo
  ↓ data: Resource[], Booking[], Slot[]
  ↓ API: RLS READ bookings + resources + services (range query)
        GET  /api/bookings/:id/slots                              BUILT · Dev 2 (findSlots; → { slots })
        POST /api/bookings/:id/(reschedule|cancel|complete|no-show) BUILT · Dev 2 (docs/contracts.md, section 4)
  ↓ loading: grid skeleton · empty: empty day columns · error: slot_taken → refresh slots
  ↓ permission: all; staff act on their own resource
  ↓ plan: none
```

```ts
interface Resource { id: string; type: string; name: string; subtitle: string | null }
interface Booking {
  id: string; leadId: string; resourceId: string | null;
  kind: 'slot' | 'site_visit' | 'field_visit' | 'callback' | 'date_range' | 'reservation';
  startAt: string; endAt: string;
  status: 'held' | 'confirmed' | 'rescheduled' | 'cancelled' | 'completed' | 'no_show';
  customer: { name: string; phoneMasked: string };
  place: string; serviceName: string | null;
}
interface Slot { start: string; end: string; resourceId: string; label: string }
```

Replaces: `DAYS`, `TODAY`, `STAFF`, `INIT`, `RE_CAL`, `industries.*.cal`.

## Features

```
UI: grouped toggles, credits/month per toggle, total estimate vs plan credits,
    reminder timing (48/24/12/6 h), working-hours mode (24×7 / after hours), Upgrade on locked rows
  ↓ data: FeatureList
  ↓ API: GET   /api/features          BUILT · Dev 2 (docs/contracts.md, section 6)
        PATCH /api/features/:key     BUILT · Dev 2 (plan check + audit log; { enabled?, settings? } → FeatureRow)
  ↓ loading: row skeletons; switch shows pending while PATCH is in flight
  ↓ error: revert switch + toast; 403 plan_required → Upgrade dialog
  ↓ permission: owner, admin toggle; staff read-only
  ↓ plan: per feature from the server
```

```ts
interface FeatureList {
  plan: { key: string; name: string; monthlyCredits: number };
  estimatedCreditsPerMonth: number;          // sum over enabled + available features, server-side
  groups: { name: string; features: FeatureRow[] }[];
}
interface FeatureRow {
  key: string;                               // features.key, e.g. 'reminder_24h'
  name: string; description: string;         // pack-specific copy allowed
  state: 'on' | 'off' | 'locked' | 'disabled';
  // locked   = plan doesn't include it → show Upgrade with requiredPlan
  // disabled = available but can't be used right now (e.g. needs a calendar or a connected number)
  enabled: boolean;                          // the business's own switch, whatever the state (built: added)
  requiredPlan: 'starter' | 'growth' | 'pro' | null;
  disabledReason: string | null;
  creditsPerMonth: number | null;            // last-30-day estimate; null = "No extra credits"
  creditNote: string | null;                 // "Part of replies", "Only when used"
  settings: Record<string, unknown>;         // e.g. { offset_minutes: 1440 } from tenant_features.settings
  control: 'switch' | 'segmented' | 'timing';
}
```

Built (12 Oct): `FeatureList`, `FeatureRow` and `UpdateFeatureInput` are in `@pakka/types`. Settings keys are the jobs'
own (`offset_minutes`, `review_url`, `sla_minutes`, …; docs/contracts.md, section 3), not `offsetHours`.

Mapping from prototype keys to `features.key`: `autoReply`→`ai_auto_reply`, `hours`→`working_hours_mode`,
`qualify`→`lead_qualification`, `booking`→`booking`, `confirm`→`booking_confirmation`,
`r24`→`reminder_24h`, `r2`→`reminder_2h`, `nudge`→`followup_nudges`, `noshow`→`noshow_rebooking`,
`feedback`→`feedback_request`, `review`→`review_request`, `alerts`→`staff_alerts`,
`agenda`→`daily_agenda`, `webhooks`→`outbound_webhooks`, `topup`→`auto_topup`. Not shown in the
prototype's Features screen: `handoff_triggers`, `handoff_own_number`, `custom_scoring` (Agent settings)
and `quote_auto_send`, `quote_followup`, `pretrip_info` (travel pack).

Replaces: `FEATURES`, `GROUPS`, `PLAN_*` and the browser-side `locked` and `est` computations in
`pakka-app.tsx`.

## Agent settings

```
UI: persona, tone + preview, languages, business hours, scoring weights + Hot/Warm thresholds,
    handover triggers, takeover default
  ↓ data: AgentSettings
  ↓ API: RLS READ tenants (agent_settings, business_hours, pack_overrides)
        PATCH /api/agent/settings         PROPOSED · Dev 1 (Zod against the pack; overrides can't
                                          remove required fields or hard fails)
  ↓ loading/error: form skeleton; field errors from validation_failed
  ↓ permission: owner, admin
  ↓ plan: scoring weights locked unless custom_scoring (Pro); 'own' takeover needs handoff_own_number
```

```ts
interface AgentSettings {
  persona: string; tone: 'friendly' | 'formal';
  languages: ('en' | 'ta' | 'ta-en' | 'ml' | 'hi' | 'te')[];
  businessHours: Record<'mon'|'tue'|'wed'|'thu'|'fri'|'sat'|'sun', { open: string; close: string } | null>;
  scoring: { rules: { field: string; label: string; rule: string; points: number }[];
             thresholds: { hot: number; warm: number }; editable: boolean };
  handoffTriggers: { key: string; label: string; example: string; highPriority: boolean; enabled: boolean }[];
  takeoverDefault: 'inbox' | 'own_number' | 'ask';
  previewSample: { customer: string; reply: string } | null;   // optional, from the pack
}
```

Replaces: `CRIT`, `TRIG`, `LANGS`, `industries.*.agent`.

## Knowledge base

```
UI: services & prices table, FAQs (expand/edit/add), documents (upload), website sync,
    unanswered questions with "Add answer"
  ↓ data: KnowledgeBase
  ↓ API: RLS READ kb_documents, services / catalog_items
        POST /api/kb/documents            HANDOVER · Dev 1
        POST /api/onboarding/import-site  HANDOVER · Dev 1
        POST|PATCH|DELETE /api/kb/faqs    PROPOSED · Dev 1 (contracts.md section 9)
        GET  /api/kb/gaps                 PROPOSED · Dev 1 (needs a table for unanswered questions)
  ↓ loading: upload/embedding progress · empty: first day (built) · error: upload failed
  ↓ permission: owner, admin (+ staff answering gaps, to confirm)
  ↓ plan: none
```

```ts
interface KnowledgeBase {
  site: string | null; lastSyncedAt: string | null;
  services: { id: string; name: string; category: string; details: string; price: string; active: boolean }[];
  faqs: { id: string; q: string; a: string }[];
  documents: { id: string; title: string; sourceType: 'website' | 'upload' | 'manual'; createdAt: string;
               status: 'processing' | 'ready' | 'failed' }[];
  gaps: { id: string; question: string; askedCount: number; lastAskedBy: string }[];
}
```

Replaces: `GAPS`, `FAQS`, `industries.*.kb`.

## Templates

```
UI: list with category, credit cost, per-language Meta status, sends + read rate; detail with
    variables, buttons, versions, rejection reason; builder (new version) with live preview
  ↓ data: Template[]
  ↓ API: RLS READ template status table (Dev 2, schema to define)
        POST /api/templates                PROPOSED · Dev 2 (submits a new version to Meta)
  ↓ loading: list skeleton · error: Meta rejection reason shown per language (built from fixtures)
  ↓ permission: owner, admin
  ↓ plan: none
```

```ts
interface Template {
  key: string;                              // 'reminder_24h_v1'; changes = new version
  label: string; category: 'Utility' | 'Marketing'; creditCost: number;
  featureKey: string | null; when: string;
  languages: { lang: 'en' | 'ta'; body: string;
               status: 'Not added' | 'Draft' | 'In review' | 'Approved' | 'Rejected';
               rejectReason?: string }[];
  variables: { tag: string; name: string; sample: string }[];
  buttons: { type: 'Quick reply' | 'URL' | 'Phone'; text: string }[];
  stats: { sent30d: number; readPct: number | null };
  versions: { key: string; note: string; status: string }[];
}
```

Replaces: `V`, `BASE`, `FEATS`.

## Billing & credits

```
UI: current plan, next bill + GST, daily usage chart, credit history, top-up packs,
    monthly/yearly switch, plan change, setup add-on, invoices
  ↓ data: AccountStatus, BillingOverview, LedgerEntry[]
  ↓ API: GET  /api/billing/balance (shell)                 PROPOSED · Dev 2
        RLS READ credit_ledger (or view)                  Dev 2
        POST /api/billing/checkout | /topup | /change-plan HANDOVER · Dev 2 → Razorpay widget
  ↓ loading: payment in progress while Razorpay is open
  ↓ error: payment failed / cancelled → balance unchanged, toast
  ↓ permission: owner pays; admin read-only
  ↓ plan: downgrade/cycle change applies at next renewal (server decides and returns effectiveAt)
```

```ts
interface BillingOverview {
  plans: { key: string; name: string; priceInr: number; yearlyPriceInr: number; monthlyCredits: number;
           seats: number | 'unlimited'; whatsappNumbers: number; highlights: string[] }[];
  current: { planKey: string; cycle: 'monthly' | 'yearly'; nextBillAt: string | null;
             nextBillInr: number | null; gstInr: number | null };
  topupPacks: { id: string; credits: number; priceInr: number }[];   // specs: 1,000 for ₹1,199
  dailyUsage: { date: string; credits: number }[];                    // last 24–30 days
  setupFee: { priceInr: number; purchased: boolean };
  invoices: { id: string; number: string; date: string; amountInr: number; url: string }[];
}
interface LedgerEntry {
  id: number; at: string; delta: number;
  reason: 'plan_grant' | 'topup' | 'trial_grant' | 'ai_reply' | 'template_utility' |
          'template_marketing' | 'staff_alert' | 'cycle_reset' | 'admin';
  label: string; expiresAt: string | null;
}
interface CheckoutResponse { razorpay: { orderId?: string; subscriptionId?: string; keyId: string } }
// keyId is RAZORPAY_KEY_ID (public); the key secret never leaves the server.
```

Replaces: `PLANS`, `USE`, `TOPUP_PACKS`, `PLAN_PRICES`, `PLAN_SEATS`, `PLAN_NUMBERS`.

## Team

```
UI: staff list with role, phone, alert chips, takeover preference; invite form
  ↓ data: TeamMember[], seat usage
  ↓ API: RLS READ memberships (+ profile)
        POST  /api/team/invite        HANDOVER · Dev 3 (seat limit → 403 seat_limit)
        PATCH /api/team/:userId       PROPOSED · Dev 3
  ↓ error: seat_limit → Upgrade dialog; invalid phone → field error
  ↓ permission: owner, admin edit; staff view self
  ↓ plan: seats from plan
```

```ts
interface Team {
  seats: { used: number; limit: number | 'unlimited' };
  members: { userId: string; name: string; initials: string; role: 'owner' | 'admin' | 'staff';
             displayRole: string;                // "Sales", "Stylist", from the pack or free text
             phoneMasked: string;
             alerts: Record<'hot_leads' | 'bookings' | 'handovers' | 'daily_agenda' | 'low_credits', boolean>;
             takeoverPref: 'inbox' | 'own_number' | 'ask' | null;
             status: 'active' | 'invited' }[];
}
interface InviteInput { name: string; phone: string; role: 'admin' | 'staff' }
```

Replaces: `ALERTS`, `INIT` (team), `industries.*.team`.

## Settings

```
UI sections: My profile · Business · Services & slots · WhatsApp number · Notifications ·
             Security & login · Data & privacy
  ↓ data: Profile, Business, BookingRules, WhatsAppConnection, NotificationPrefs, Sessions
  ↓ API: see inventory; WhatsApp reads ONLY whatsapp_connections_public
        POST /api/whatsapp/connections/:id/recheck       HANDOVER · Dev 1
        POST /api/whatsapp/connections/:id/disconnect    HANDOVER · Dev 1 (owner)
        GET  /api/calendar/google/connect                HANDOVER · Dev 2
  ↓ permission: profile = self; rest owner/admin; disconnect + close account = owner
  ↓ plan: extra numbers = Pro
```

```ts
interface WhatsAppConnection {           // from whatsapp_connections_public, nothing else
  id: string;
  method: 'embedded_signup' | 'assisted' | 'manual_byo';
  displayPhone: string; verifiedName: string | null; coexistence: boolean;
  status: 'pending' | 'validating' | 'active' | 'failed' | 'disconnected';
  lastCheck: { at: string; checks: { key: string; ok: boolean; message?: string }[] };
  qualityRating: string | null; messagingLimit: string | null;
}
interface BookingRules {
  services: { id: string; name: string; duration: string; staff: string[]; where: string }[];
  bufferMin: number; minNoticeMin: number; bookAheadDays: number /* not in schema yet */; holdMin: number;
  calendar: { provider: 'google'; connected: boolean; account: string | null };
}
```

Replaces: `RE_BIZ` (settings), `EX`, `SVC`, `EVENTS`, plus the inline sample rows in
`pakka-settings.tsx` (sessions, activity, connection log, health stats, template list).

---

## Open questions for Dev 1 and Dev 2

| # | Question | For |
|---|---|---|
| 1 | Read routes vs direct RLS reads: OK to add the PROPOSED aggregate routes (`/api/dashboard/summary`, `/api/features`, `/api/billing/balance`), or should these be SQL views read under RLS? | Dev 2 |
| 2 | `buildLeadCard` over HTTP: `GET /api/conversations/:id/lead-card` or a column/view the inbox reads? | Dev 1 |
| 3 | Where do "questions Maya couldn't answer" live? No table in the schema. | Dev 1 |
| 4 | Template status table schema (seeded by `whatsapp/connected`). | Dev 2 |
| 5 | Staff visibility: all chats/leads, or assigned + unassigned only? | Raja |
| 6 | Prices, credits, top-up packs and seats: confirm the specs over the prototype numbers. | Raja, Dev 2 |
| 7 | Notification matrix, quiet hours, weekly report, book-ahead window, chat retention: in v1? | Raja, Dev 2 |
| 8 | Onboarding "partner access" WhatsApp path isn't one of the three `method`s in the handover. | Dev 1, Raja |
