# Frontend architecture map

Owner: Dev 3. Status: **structure merged on 5 Oct 2026; product data is still fixtures.** No backend
integration and no authentication have been added.

**Update, 7 Oct 2026:** auth, tenant resolution and the signed-in shell are built (below), and two
screens read real data. See "Dev 3 integration status" below. The prototype at `/dashboard/preview`
still runs on fixtures and remains the visual reference for every screen.

## Dev 3 integration status (7 Oct 2026)

| Area | Status | Data path |
|---|---|---|
| `/dashboard/inbox` | Built, read-only | browser client → `conversations`, `contacts`, `handoffs`, `messages` under RLS, filtered by the session's tenant → one Realtime channel `inbox:<tenantId>` (inserts and updates, `tenant_id` filter) |
| `/dashboard/knowledge` · services | Built: list, add, edit, delete | browser client → `services` under RLS (0002 member writes) |
| `/dashboard/knowledge` · documents | Built, read-only | browser client → `kb_documents` under RLS (members can't write it) |
| FAQs | **Blocked on Dev 1**: no storage, no API | UI ported (`faq-list.tsx`), shown as not available |
| Unanswered questions (gaps) | **Blocked on Dev 1**: no storage, no API | UI ported (`gaps-list.tsx`), shown as not available |
| Document upload | **Blocked on Dev 1**: `POST /api/kb/documents` not built or specified | Upload shown switched off |
| Sending, AI/Human switch, lead card | Not started (Dev 3 routes; send needs Dev 1's registered sender) | Controls shown switched off |
| PostgreSQL / RLS verification | **Pending**: needs Docker | `0010_inbox_realtime.sql`, `inbox_rls.test.sql`, `services_rls.test.sql` not yet run |
| `/dashboard/settings/booking` (Day 3) | Built: business hours, staff and resources (own hours, service-area pincodes), services (length, gap, minimum notice) | browser client → `tenants.business_hours`, `resources`, `services` under RLS (0002 member writes; 0015 `buffer_min`, `min_notice_min`). Owners and admins edit; staff read-only. The shapes are the slot engine's (`contracts.md` section 3) |
| `/dashboard/leads`, `/dashboard/leads/[leadId]` (Day 3) | Built, read-only | browser client → `leads` + `contacts`; answers labelled from `vertical_packs` (by `tenants.vertical`, `vertical_version`); timeline from `conversations`, `handoffs`, `messages`, `bookings`. Score and temperature shown as stored, never computed |
| `/dashboard/calendar` (Day 3) | Built, read-only | browser client → `bookings` (range query) + `resources`, in `tenants.timezone`. Lapsed holds show as expired; cancelled, moved and expired only on request; bookings with no resource in their own lane |

What Dev 3 needs from Dev 1 for the blocked rows: [kb-contract-checklist.md](kb-contract-checklist.md).

Known limits, all shown honestly in the UI: no unread data; no persona or staff names ("AI", "Staff");
no conversation → lead link (no score, no lead card); the inbox reads the newest 200 chats and a chat's
newest 300 messages, with no paging; when Realtime can't subscribe (for example before 0010 is applied)
the inbox says so and re-reads at most every 10 seconds while it retries; the browser receives
contacts' full numbers under RLS, and the UI only ever shows them masked. Reads and live changes are
ordered (`ReadSequencer` in `features/inbox/data.ts`) so an older read can't overwrite a newer one or
drop a change that arrived during it.

Related: [dashboard-screen-inventory.md](dashboard-screen-inventory.md) ·
[dashboard-screen-contracts.md](dashboard-screen-contracts.md) · [handover.md](handover.md) ·
[frontend-exports/](frontend-exports/) (archived READMEs of the two original exports)

## Repository layout

The repo is a pnpm monorepo with two deployables: the Next.js app (Vercel) and the API (Railway).
Hosting, variables and the request flow are in [environments.md](environments.md).

```
AgentX/
├── frontend/            @pakka/frontend: the Next.js 16 app (UI, sign-in, server-rendered reads)
├── backend/             @pakka/backend: the API service (backend/src/server) and the modules behind it
├── packages/
│   ├── types/           @pakka/types: shared types + Zod schemas (empty until the first contract)
│   └── config/          @pakka/config: shared tsconfig base
├── supabase/            migrations + database tests (untouched by this change)
├── packs/  tests/conversations/  scripts/  docs/
├── package.json         workspace scripts + repo CLIs (supabase, inngest-cli)
└── pnpm-workspace.yaml  frontend, backend, packages/*
```

The dashboard and onboarding were built as two separate Next.js 15 exports (`pakka-app/` and
`pakka-onboarding/`). Both were merged into `frontend/` on Next 16 and the export folders deleted.
Visual output is unchanged: see "Regression baseline" below.

### frontend/

```
frontend/
├── app/
│   ├── (onboarding)/            root layout #1: onboarding.css + Archivo via next/font/google
│   │   ├── layout.tsx
│   │   ├── page.tsx             /            → redirect('/onboarding')
│   │   └── onboarding/page.tsx  /onboarding  → <OnboardingFlow />
│   ├── (dashboard)/             root layout #2: dashboard.css + self-hosted Archivo
│   │   ├── layout.tsx
│   │   ├── login/page.tsx       /login       → email + password sign-in
│   │   └── dashboard/
│   │       ├── layout.tsx       signed-in gate: verifies the session, resolves the tenant, TenantProvider
│   │       ├── (app)/           app shell (sidebar, business, nav, logout)
│   │       │   ├── page.tsx              /dashboard                 → signed-in home
│   │       │   ├── messages/test/        /dashboard/messages/test   → Send test message
│   │       │   ├── templates/new/        /dashboard/templates/new   → Create template
│   │       │   ├── whatsapp/             /dashboard/whatsapp        → WhatsApp connection panel
│   │       │   ├── inbox/                /dashboard/inbox[?chat=]   → real Inbox (features/inbox)
│   │       │   └── knowledge/            /dashboard/knowledge       → real Knowledge base (features/knowledge)
│   │       └── preview/page.tsx  /dashboard/preview → <PakkaRoot /> prototype (sample data, demo URL switches)
│   ├── auth/callback/route.ts   GET /auth/callback (Supabase code exchange; the only route handler)
│   ├── connect/[token]/         reserved (assisted WhatsApp connect page, not built; .gitkeep only)
│   ├── h/[token]/               reserved (staff takeover redirect, not built; .gitkeep only)
│   └── favicon.ico
├── components/
│   ├── ui/                      shadcn/ui primitives (button, dialog, input, label, switch)
│   ├── dashboard/               dashboard shell: pakka-app.tsx (shell + Home, Inbox, Features, dialogs),
│   │                            pakka-root.tsx (client-only mount), runtime.tsx (DCLogic runtime)
│   ├── onboarding/              onboarding-flow.tsx, step-*.tsx, meta-popup.tsx, primitives.tsx
│   └── shared/                  empty until something is genuinely shared
├── features/
│   ├── onboarding/{data,state,packs}  onboarding mock data, state model, active packs (vertical_packs)
│   ├── leads/ calendar/ agent/ knowledge/ templates/ billing/ settings/ team/
│   │                            one prototype screen each (pakka-<screen>.tsx), fixtures only
│   ├── inbox/                   real Inbox: data.ts (RLS reads, view model), use-inbox-realtime.ts,
│   │                            inbox-screen, conversation-list, chat-view, message-bubble. The
│   │                            prototype Inbox still lives in components/dashboard/pakka-app.tsx
│   ├── knowledge/               pakka-knowledge.tsx (prototype) plus the real screen: knowledge-screen,
│   │                            services-editor (+ data.ts, dialogs), documents, faq-list and
│   │                            gaps-list (kb-content.ts); FAQs and gaps have no backend contract yet
│   └── auth/                    empty: auth is not started
├── fixtures/dashboard/          TEMPORARY dashboard sample data + fixtures.test.ts
├── styles/                      dashboard.css, onboarding.css
├── lib/                         api/client.ts (the one way to call the API), supabase/{server,client}.ts,
│                                auth/, onboarding/trial.ts, env.ts, errors.ts, utils.ts (cn())
├── hooks/  types/               empty
├── public/fonts/                Archivo woff2 used by the dashboard
├── tests/
│   └── e2e/{app,dashboard,onboarding}/   Playwright (starts the API and a mock Supabase)
└── next.config.ts  tsconfig.json  eslint.config.mjs  postcss.config.mjs  components.json
    vitest.config.mts  playwright.config.ts  vercel.json
```

Folder names keep their original file names (`pakka-leads.tsx`, …) so history and the archived
export docs still line up.

### backend/

```
backend/src/
├── server/    main.ts (entry: PORT, 0.0.0.0, graceful shutdown), node.ts (node:http ↔ Request/Response),
│              app.ts (dispatch, 404/405, error envelope), routes.ts (every endpoint), auth.ts (bearer
│              token + tenant), cors.ts (exact-origin allowlist)
├── inngest/   client.ts, functions.ts, ping.ts, serve.ts (inngest/edge handler for /api/inngest)
├── lib/       env.ts (serverEnv()), tenant.ts, errors.ts, supabase-admin.ts, crypto.ts
└── agent/ channels/whatsapp/ kb/ booking/ notify/ billing/ features/ consent/
```

`backend/` is its own service: `pnpm --filter @pakka/backend start` runs `src/server/main.ts` with tsx
on Railway. Only `backend/` depends on `inngest`, so there's one copy of it and one Inngest endpoint.
The frontend imports exactly two of its modules, `@pakka/backend/lib/tenant` and
`@pakka/backend/channels/whatsapp/connections`, which run on the caller's own Supabase client (RLS);
ESLint refuses any other `@pakka/backend` import in `frontend/`.

## Route ownership

| Route | Owner | Status |
|---|---|---|
| `/` | Dev 3 | Redirects to `/onboarding` (from the onboarding export). The handover's landing page will take `/` later. |
| `/onboarding` | Dev 3 | Prototype wizard: the Business step creates the account's trial business; every other step is mock behaviour (dummy WhatsApp code, nothing saved). Needs a signed-in account, signed out → `/signup?next=/onboarding` |
| `/login` | Dev 3 | Existing accounts: email + password sign-in, or Continue with Google; "Forgot password?". A member → `/dashboard` (or the `next` page), an account with no business yet → `/onboarding`. Signed-in visitors are sent on the same way |
| `/signup` | Dev 3 | New accounts: email + password (confirmed if the project requires it), or Continue with Google → `/onboarding`. An existing Google account still lands on `/dashboard` (the callback decides). Signed-in visitors are sent on like `/login` |
| `/forgot-password` | Dev 3 | Emails a Supabase reset link (same answer whether or not the address has an account) |
| `/reset-password` | Dev 3 | Opened by the reset link through `/auth/callback`; sets the new password, then routes like sign-in. Without the link's session → `/forgot-password?error=link_expired` |
| `/auth/callback` | Dev 3 | Finishes Google sign-in, email confirmation and reset links: exchanges the code, then a reset link (PKCE verifier marked as recovery) → `/reset-password`, no business → `/onboarding`, member → `/dashboard` |
| `/dashboard` | Dev 3 | Signed-in home: real business from `memberships` → `tenants` |
| `/dashboard/messages/test`, `/dashboard/templates/new` | Dev 3 | Meta App Review screens (send test message, create template) |
| `/dashboard/whatsapp` | Dev 3 | Connection panel reading `whatsapp_connections_public` |
| `/dashboard/inbox` | Dev 3 | Real Inbox, read-only: RLS reads of `conversations`, `contacts`, `handoffs`, `messages`; one Realtime channel `inbox:<tenantId>` (needs migration 0010). Sending, AI/Human switch, lead card and suggested reply are not built |
| `/dashboard/knowledge` | Dev 3 | Real Knowledge base: services CRUD under RLS; `kb_documents` list (read only). FAQs, unanswered questions, upload and website sync are shown as not available: no backend contract yet |
| `/dashboard/leads`, `/dashboard/leads/[leadId]` | Dev 3 | Real Leads board by stage (temperature and minimum-score filters) and lead detail (answers, timeline), read-only, RLS reads |
| `/dashboard/calendar[?view=week&date=&resource=]` | Dev 3 | Real Calendar, read-only: day and week, staff filter, times in the business's zone |
| `/dashboard/settings/booking` | Dev 3 | Booking setup: business hours, staff and resources, services, RLS reads and writes |
| `/dashboard/preview` | Dev 3 | Prototype dashboard (sample data), signed-in only |
| `/connect/[token]`, `/h/[token]` | Dev 3 / Dev 1 | Reserved folders, no route yet |
API routes are served by the API service (`backend/src/server/routes.ts`), not by Next.js:

| Route (on the API host) | Owner | Status |
|---|---|---|
| `GET /api/health` | Dev 2 | Exists (Railway healthcheck) |
| `GET/POST/PUT /api/inngest` | Dev 2 | Exists (functions in `backend/src/inngest`) |
| `POST /api/messages/test` | Dev 3 UI · Dev 1 adapter · Dev 2 API | Exists; answers `whatsapp_not_connected` without an active connection, and `not_available` until the adapter lands |
| `POST /api/templates` | Dev 3 UI · Dev 2 service | Exists; answers `not_available` until a template table and Meta submission exist |
| `POST /api/onboarding/trial` | Dev 3 UI · Dev 2 API | Exists; the onboarding Business step |
| `GET /api/webhooks/whatsapp` | Dev 1 | Exists (Meta verification); POST not built, answers 405 |
| Other `/api/*` in the handover (onboarding, conversations, bookings, features, billing, team, admin) | per handover | Not built; add them to `routes.ts` |

## Auth and tenant context

Supabase Auth with email + password and Google, through `@supabase/ssr` (cookie sessions, PKCE).
Sign-up, sign-in, the Google round trip and sign-out run on the Next.js server, as do server-rendered
reads. The Inbox and Knowledge screens read (and, for services, write) from the browser through
`lib/supabase/browser.ts`, acting as the signed-in member: RLS applies, every query also filters by the
session's tenant id, which the page resolves on the server and passes down. The same browser client
gives `lib/api/client.ts` the access token for API calls: it sends `Authorization: Bearer <access token>`
and, in the dashboard, `X-Pakka-Tenant` (the business from `useTenant()`). The API verifies the token
with Supabase Auth and the membership with the same `resolveTenant` (`backend/src/server/auth.ts`).

A new account is told apart from an existing one by membership only: no business yet → onboarding,
otherwise → dashboard. This is decided from the account's state after sign-in, never from the page it
started on: an existing member using "Continue with Google" on `/signup` still lands on the dashboard,
and an existing account that never set up a business is sent back to onboarding when it signs in. Signing up (email or Google) creates only the account. The business is created
on onboarding's Business step, once the user has typed its name and picked a trade:
`lib/onboarding/trial.ts` calls `POST /api/onboarding/trial`, where the API runs `startTrialFor` and
`createTrialTenant` with the token's user id and the trade's pack key, mapped on the server
(`TRIAL_PACKS` in `@pakka/types`; trades without a pack can't start a trial). The step offers only the
trades whose pack is active in `vertical_packs`, read by `onboarding/page.tsx` as the signed-in user
(`features/onboarding/packs`: key and `definition->>label` only; the label names the card). If that
read fails it offers none, never a built-in list. An account that already
belongs to a business, in any role, gets no new one. Onboarding has no saved progress or "completed"
flag yet.

| Piece | Where | What it does |
|---|---|---|
| Public config | `frontend/lib/env.ts` | Validates `NEXT_PUBLIC_SUPABASE_URL` (must be the https API URL, no credentials), the anon key and `NEXT_PUBLIC_API_URL` (an origin, no path) |
| Server client | `frontend/lib/supabase/server.ts` | Per-request client acting as the user; row-level security applies |
| Browser client | `frontend/lib/supabase/browser.ts` | One client per tab from the same cookies; `ensureRealtimeAuth()` hands the member's token to Realtime before subscribing |
| Session refresh | `frontend/components/shared/session-refresh.tsx` | Mounted in both root layouts; the browser client refreshes the access token and rewrites the session cookies (Server Components can't). There is no proxy or middleware: every redirect below happens in a page, layout, server action or route handler |
| Root page | `app/(onboarding)/page.tsx` | `/` → `/login` for everyone; the session alone decides nothing there |
| Browser client | `frontend/lib/supabase/browser.ts` | One client per tab from the same cookies; `ensureRealtimeAuth()` hands the member's token to Realtime before subscribing; also supplies the access token for API calls |
| API client | `frontend/lib/api/client.ts` | `apiFetch()` / `postJson()`: `${NEXT_PUBLIC_API_URL}/api/...` with the bearer token and `X-Pakka-Tenant` |
| Proxy | `frontend/proxy.ts` | Refreshes the session cookie; signed-out `/dashboard/*` → `/login?next=…`, `/onboarding` → `/signup?next=/onboarding`; signed-in `/login` → `/dashboard`, `/signup` → `/onboarding` (optimistic) |
| Proxy | `frontend/proxy.ts` | Refreshes the session cookie; signed-out `/dashboard/*` → `/login?next=…`, `/onboarding` → `/signup?next=/onboarding` (optimistic). Signed-out `/login` and `/signup` always render the page |
| Redirect rules | `frontend/lib/auth/redirect.ts` | `safeNext()` (in-app paths only), `destinationAfterAuth()`, fixed copy for `?error=` codes |
| Post-sign-in destination | `frontend/lib/auth/destination.ts` | `destinationForUser()`: resolves the account's memberships and applies `destinationAfterAuth()`. Used by the callback, the password login, the new-password form and `redirectIfSignedIn()` |
| OAuth / email-link callback | `frontend/app/auth/callback/route.ts` | `exchangeCodeForSession()`, then routes by membership (or to `/reset-password` for a reset link); failures → `/login`, `/signup` or `/forgot-password?error=…` |
| Data access layer | `frontend/lib/auth/session.ts` | `getAuth()` (Supabase verifies the token), `getSessionState()`, `redirectIfSignedIn()` (for `/login` and `/signup`), `requireTenantContext()`, `requireDashboardView()` |
| Tenant resolver | `backend/src/lib/tenant.ts` | memberships → tenants through the user's own client; one membership → that tenant; several → the user chooses (`pakka_tenant` cookie on the frontend, `X-Pakka-Tenant` on the API, honoured only if the user is a member); none → "not linked to a business" |
| Gate | `app/(dashboard)/dashboard/layout.tsx` | Authoritative check for every `/dashboard` page; renders no markup in the normal case |
| Client context | `components/dashboard/tenant-context.tsx` | `TenantProvider` / `useTenant()` |
| Actions | `frontend/lib/auth/actions.ts` | `login` (validated, safe `next`), `signup` (validated; same screen whether or not the address is taken), `signInWithGoogle`, `logout`, `chooseTenant` |

API routes use `tenantRoute()` (`backend/src/server/auth.ts`): verify the bearer token, resolve the
tenant on the server, call the backend service with the body and any `:name` path values, answer
errors as `{ error: { code, message } }`.
User-facing error text comes from `formatError()` (`frontend/lib/errors.ts`); credentials are
stripped by `redactSecrets()` (`@pakka/types`) before anything is logged.

### Day 1 dependencies still open

| Needed | Owner | Until then |
|---|---|---|
| Migration 0003 applied to each database (it is in the repo since PR #5) | Dev 2 | Where `whatsapp_connections_public` is missing, the panel shows "details aren't available yet"; sending answers `whatsapp_not_connected` |
| Connect flow: Embedded Signup + `POST /api/onboarding/whatsapp/embedded-signup` (handover module 10) | Dev 1 (server) · Dev 3 (UI) | "Connect WhatsApp" is shown switched off with the reason; nothing is connected or saved |
| WhatsApp adapter `sendText` | Dev 1 | Even with an active connection, sending answers `not_available` (never a fake success) |
| Meta template submission (`whatsapp_templates` exists since 0007, #21) | Dev 1 (adapter) · Dev 2 (`createTemplate`) | Create template validates fully, then answers `not_available`; a template list reading `whatsapp_templates` is not built yet |
| `dashboard-screen-contracts.md` brought in line with the agreed send/template/error contract (now in `docs/shared-types.md`) | Dev 3 + Dev 2 | The proposal still lists different error codes, template variables, button types and statuses; the code follows `shared-types.md` |
| 0001 applied to the hosted project, test user + membership, `frontend/.env.local` with the https API URL | Dev 2 / Raja | Login is verified end to end against the Playwright mock only |
| Packs for Hotel, Restaurant and Plumber / Electrician | Dev 1 | Those trades show "Trials for this trade aren't open yet" and create nothing |
| Pending team invites (no invite flow yet) | Dev 2 | Someone invited to a team who signs up before their membership exists could still start their own trial on the Business step |

## Onboarding domain

| | |
|---|---|
| Code | `components/onboarding/`, `features/onboarding/{data,state}`, `components/ui/` |
| Steps | 1 Verify phone (OTP) · 2 Business (6 trades) · 3 Teach (website import) · 4 Try it · 5 WhatsApp (Facebook with coexistence, or manual partner / own app; simulated Meta popup; checks) · 6 Team & go live · "You're live" |
| State | One `OnboardingState` in `OnboardingFlow` (`useState`), timers simulate import and checks. Not shared with the dashboard. A reload restarts at step 1. The only server call is the Business step's `startTrial`; once it succeeds, the Try and live steps show the real trial code, days and credits instead of the samples. |
| Mock data | `features/onboarding/data`: `ROUTES`, `TRIAL_CODE`, `INDUSTRIES`, `PROFILES`, `FEATURES`, `CHECKS`, popup steps, fake QR |
| Exit | "Go to my dashboard" is a plain `<a href>` to `ROUTES.dashboard` (`/dashboard`), plus `?industry=<key>` for non-real-estate trades. Because the two route groups have different root layouts, this is always a **full page load**: the dashboard never renders inside the onboarding tree. |

## Dashboard domain

| | |
|---|---|
| Code | `components/dashboard/` (shell, runtime), `features/<screen>/`, `fixtures/dashboard/` |
| Screens | Home, Inbox, Leads, Calendar, Features, Agent settings, Knowledge base, Templates, Billing & credits, Team, Settings (7 sections) |
| State | One `DCLogic` class per screen with synchronous `setState`. The shell owns the screen, chat, dialogs and toggles. Not shared with onboarding. |
| Navigation | Sidebar (≥ 720 px) or tab bar + More sheet; in-memory, the URL does not change |

### Temporary prototype switches (not production architecture)

`/dashboard/preview` reads these query parameters in `app/(dashboard)/dashboard/preview/page.tsx` (props) and on mount
in `components/dashboard/pakka-app.tsx`. They exist so the 213-state visual baseline and the
Playwright suite can reach every state. Remove them once the dashboard reads the signed-in tenant.

`screen`, `chat`, `industry`, `theme`, `frame`, `account`, `credits`, `plan`, `firstDay`, `productName`.
Onboarding passes `?industry=` to the dashboard for non-real-estate trades; that link goes too.

### Temporary fixtures

`frontend/fixtures/dashboard/*` (dashboard) and `frontend/features/onboarding/data` (onboarding) are
sample data from the prototypes. Each dashboard fixture is replaced by the shape in
[dashboard-screen-contracts.md](dashboard-screen-contracts.md). `fixtures.test.ts` keeps the
cross-references intact until then.

## Shared UI

`components/ui/` holds the shadcn/ui primitives that came with onboarding (Radix-based, themed with the
`--pk-*` tokens). `components.json` points shadcn at `styles/onboarding.css`, so `shadcn add` output
matches onboarding. The dashboard doesn't use these primitives yet; it renders with its own `.btn`,
`.input`, `.dialog`, `.table` classes. Switching it over would change its look, so that's a design task.

## CSS and font strategy

The two products ship conflicting global CSS:

| | Dashboard (`styles/dashboard.css`) | Onboarding (`styles/onboarding.css`) |
|---|---|---|
| Tailwind | theme + utilities layers, **no Preflight** | full `tailwindcss` **with Preflight** + `tw-animate-css` |
| Tokens | `--color-*` (Modernist), e.g. `--color-neutral-300` | `--pk-*` mapped to shadcn vars; Tailwind `--color-neutral-*` with **different values** |
| Base rules | `html, body {height:100%}`, `.btn`, `.input`, `.dialog`, `.table`, `.pk-dark` | `body` 15px/1.55, headings, `:focus-visible` |
| Font | self-hosted Archivo `@font-face` (`public/fonts`) + `<link rel=preload>` | `next/font/google` Archivo → `--font-archivo` on `<html>` |

Merging them into one sheet would break one product. So each route group has its **own root
layout** with its own `<html>`, `<body>`, stylesheet and font, exactly as in its export. Next.js does
a full page load when moving between root layouts, so styles never leak across. Each sheet limits
Tailwind's content scan with `source(none)` + `@source` to its own folders. That keeps one product's
class names from generating rules in the other's sheet; add a line when a dashboard feature folder
is added.

There's one coherent toolchain for both: one PostCSS config (`@tailwindcss/postcss`), one Tailwind
version, one tsconfig and alias (`@/*` → `frontend/*`), one ESLint config, one `components.json`.

Unifying the two token sets and choosing one Preflight policy and one font loader is an
**unresolved design decision** (below). Until then, the split is deliberate.

## TypeScript strategy

`frontend` and `backend` extend `packages/config/tsconfig.base.json` (`strict: true`). The dashboard
was written for `strict: false`, so 11 ported files start with `// @ts-nocheck` and a comment
pointing here:

`components/dashboard/pakka-app.tsx`, `features/{leads,calendar,agent,knowledge,templates,billing,settings,team}/pakka-*.tsx`,
`fixtures/dashboard/industries.ts`, `fixtures/dashboard/templates.ts`.

Every other file is checked strictly, including `runtime.tsx`, `pakka-root.tsx`, the other fixtures,
all onboarding code and the tests. Without the pragma these files report about 350 implicit-`any`
errors and nothing else. Removing the boundary means typing them file by file against
[dashboard-screen-contracts.md](dashboard-screen-contracts.md), ideally as each screen gets real data.

## Shared concepts

| Concept | Dashboard | Onboarding | Backend source (handover) | Gap |
|---|---|---|---|---|
| Business | `RE_BIZ`, `industries.*.biz`; Settings › Business | `state.biz`, `PROFILES[k]` | `tenants` | No columns for city, address, website, GSTIN, legal name, about |
| User | Owner name/initials/email; My profile | `state.phone` + OTP | `auth.users` + `memberships` | No profile table; login method undecided |
| Tenant | Implicit (`?industry=`) | Created implicitly at the end | `tenants` row at signup (trial, 300 credits, `TRIAL-xxxx`) | When it's created (after OTP or Business step) |
| Industry / pack | `re`, `salon`, `int`, `hotel`, `rest` | `re`, `int`, `salon`, `hotel`, `rest`, `fix` | `vertical_packs.key`: `real-estate`, `interiors`, `salon`, `tours-travel` | Three key sets |
| WhatsApp | Settings › WhatsApp (connected / attention / disconnected, log) | Facebook (coexistence) or manual partner / own app; checks | `whatsapp_connections` (`embedded_signup` / `assisted` / `manual_byo`) + public view | "Partner access" has no `method`; client-side manual entry isn't in the handover |
| Staff | `team.ts` (display role, alert prefs, takeover) | `StaffMember` | `memberships` | Display role vs auth role; alert prefs have no column |
| Calendar | Calendar screen; Services & slots | `cal: boolean` | `resources.google_calendar_id` + OAuth route | Per-resource vs one calendar |
| Features | 15 toggles with prototype keys | 6 toggles by index | `features` + `tenant_features` | Key mapping in the contracts doc |
| Plan / account | `?account`, `?credits`, `?plan` | trial implied | `tenants.status`, `plan_key`, `credit_ledger` | Prices differ from the specs |

## Future integration flow

```
/ ─▶ /onboarding
  1 Verify phone   Supabase Auth OTP ─▶ session                                              [Dev 3]
  2 Business       create tenant + owner membership + trial grant + route code              [Dev 3 / Dev 2]
  3 Teach          POST /api/onboarding/import-site ─▶ draft KB                              [Dev 1]
  4 Try it         shared demo number + TRIAL code                                          [Dev 1]
  5 WhatsApp       Embedded Signup ─▶ POST /api/onboarding/whatsapp/embedded-signup ─▶
                   whatsapp_connections ─▶ checks ─▶ status from whatsapp_connections_public [Dev 1]
  6 Team & live    invites, Google Calendar OAuth, feature toggles                          [Dev 3 / Dev 2]
  Live             tenant marked onboarded ─▶ full page load to /dashboard
/dashboard         reads everything for the session's tenant; no tenant id or ?industry= in URLs
```

Rules: progress stored on the tenant so a reload resumes; a server-side check sends signed-in users to
`/onboarding` until onboarded and to `/dashboard` after; WhatsApp is optional for "live" (AI stays
paused until a connection is `active`); manual tokens and app secrets are posted once to the server,
encrypted, and never returned or kept in client state.

## API dependencies

| Owner | Onboarding | Dashboard |
|---|---|---|
| **Dev 1** | import-site; demo-number routing; Embedded Signup exchange (module 10, see open decision); manual connect; connection status | lead card; suggested reply; KB documents, FAQs, gaps; agent settings; pack definitions; WhatsApp recheck/disconnect |
| **Dev 2** | trial grant + route code; Google Calendar OAuth; `PATCH /api/features/:key` | balance; dashboard summary; feature list; booking actions + slots; PayU billing; ledger/usage; template status; RLS and migrations for reads |
| **Dev 3** | OTP login; tenant creation route; team invite | `/api/me`; conversation send + mode; team invite/update; lead update; realtime inbox; all UI states |
| **External** | Meta (Tech Provider, App Review, Embedded Signup config, FB JS SDK); OTP delivery; Supabase Auth | PayU; Google OAuth; Meta template review |

Full per-screen list with status (EXISTS / HANDOVER / PROPOSED / RLS READ):
[dashboard-screen-inventory.md](dashboard-screen-inventory.md).

## Data contracts needed

| Mock object | Lives in | Becomes |
|---|---|---|
| `RE_BIZ`, `industries.*.biz`, onboarding `PROFILES` | `fixtures/dashboard/shell.ts`, `industries.ts`, `features/onboarding/data` | `Me.tenant` + business profile |
| `SAMPLE_BALANCES`, `TRIAL_CREDITS`, `PLAN_*`, URL account switches | `fixtures/dashboard/plans.ts` | `AccountStatus` |
| `RE_STATS`, `RE_HOT`, `RE_TODAY` | `fixtures/dashboard/shell.ts` | `DashboardSummary` |
| `convs()`, `CLOSED`, `TPLS` | `fixtures/dashboard/shell.ts` | `ConversationSummary`, `Message`, `LeadCard` |
| `LEADS`, `STAGES`, `OWNERS`, `RE_TIMELINE` | `fixtures/dashboard/leads.ts` | `LeadListItem`, `LeadDetail` |
| `INIT`, `STAFF`, `DAYS`, `RE_CAL` | `fixtures/dashboard/calendar.ts` | `Resource`, `Booking`, `Slot` |
| `FEATURES`, `GROUPS` (+ onboarding `FEATURES`) | `fixtures/dashboard/plans.ts`, `features/onboarding/data` | `FeatureList` |
| `CRIT`, `TRIG`, `LANGS` | `fixtures/dashboard/agent.ts` | `AgentSettings` |
| `GAPS`, `FAQS` (+ onboarding services/FAQs) | `fixtures/dashboard/knowledge.ts` | `KnowledgeBase` |
| `V`, `BASE`, `FEATS` | `fixtures/dashboard/templates.ts` | `Template` |
| `PLANS`, `USE`, `TOPUP_PACKS` | `fixtures/dashboard/billing.ts`, `plans.ts` | `BillingOverview`, `LedgerEntry` |
| `INIT` (team), `StaffMember` | `fixtures/dashboard/team.ts`, `features/onboarding/data` | `Team`, `InviteInput` |
| `EX`, `SVC`, `EVENTS` + inline settings rows | `fixtures/dashboard/settings.ts`, `features/settings/pakka-settings.tsx` | business profile, `BookingRules`, notification prefs |
| `CHECKS`, `wa`, `waMethod`, `mMode`, `coex` | `features/onboarding/{data,state}` | `WhatsAppConnection` |
| `OnboardingState.step` | `features/onboarding/state` | `tenants.onboarding_step` (new) |

Shared types and Zod schemas go in `packages/types` (`@pakka/types`).

## Unresolved decisions (not decided in this change)

| Decision | Options / notes | Who |
|---|---|---|
| Industry key normalization | Dashboard `re/salon/int/hotel/rest`, onboarding adds `fix`, packs use `real-estate/interiors/salon/tours-travel`. UI must read the pack, never branch on names. | Dev 1, Raja |
| WhatsApp connection paths | Onboarding offers "partner access" (no `method` value) and client-side manual entry (handover: admin only). Embedded Signup route: API table says Dev 3, module 10 says Dev 1. | Dev 1, Dev 3, Raja |
| Pricing and credits | Prototype ₹1,999/1,000 … vs specs ₹2,499/1,500 …; top-up packs; Pro seats | Raja, Dev 2 |
| Loading / error / forbidden states | Specified in the contracts doc, not designed or built | Dev 3 (design) |
| CSS Preflight | Two root layouts keep both looks today; one policy (and one token set) needs a design pass with screenshot review | Dev 3 |
| Font loading | Self-hosted `@font-face` (dashboard) vs `next/font/google` (onboarding). `next/font/local` with the existing files would serve both offline. | Dev 3 |
| Dashboard strict typing | 11 files behind `@ts-nocheck` (see TypeScript strategy) | Dev 3 |
| `/` | Redirects to onboarding today; the handover puts the landing page there | Dev 3, Raja |
| handover.md repo layout | Still describes a single `src/` tree; needs a PR reviewed by all three to describe this monorepo | All |

## Regression baseline

Captured with deterministic Playwright scripts (frozen clock for onboarding timers), and compared
byte for byte:

| Check | Result on `frontend/` |
|---|---|
| Dashboard: 213 states (11 screens × 5 sample industries at 1440 px; 1440/820/390 for real estate, salon, hotel; account states; dialogs; sheets) | 0 of 213 differ from the validated export |
| Onboarding: 107 states (every step, OTP, 6 trades, import, popup steps, popup cancel, Facebook checks → live, manual partner fail / wait / live, own-app fail, team edits, live; 1440/820/390) | 0 of 107 differ from the original export |
| Playwright (`pnpm test:e2e`): sign-in setup + 110 dashboard + 18 onboarding + 78 auth, tenant, messaging and WhatsApp, against a mock Supabase (`tests/e2e/support/mock-supabase.mjs`) | 207 passed, 7 skipped (mobile-only or desktop-only by design), 0 failed |

Since Day 1 the dashboard baseline is captured at `/dashboard/preview` with a signed-in session; still 0 of 213 differ.
