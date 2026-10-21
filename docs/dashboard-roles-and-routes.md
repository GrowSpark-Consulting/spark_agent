# Dashboard screens, roles and the routes each screen calls

Written 16 Oct 2026 (Day 9, Dev 3) from the code at `39ffdd2` plus the uncommitted Dev 3 work described in `docs/task-notes/2026-10-16-day9-dev3-status-audit.md`. Every cell below was read in code: the screen's own file for what the **screen** allows, `backend/src/**` for what the **server** enforces. Nothing here was run against staging, Meta, PayU or a real Supabase; "Tested" names the mocked browser spec or unit test that exercises it.

Two roles layers, and the second one is the one that counts:

- **Screen**: what the dashboard shows or enables for the member's role. It is a convenience. A member can always call the API directly.
- **Server**: the check in `backend/src` (`requireRole`, `requireOwner`, `requirePlatformAdmin`) or, for reads and a few writes the browser makes itself, the row-level security (RLS) policy. This is what keeps a role out.

Roles are `owner`, `admin`, `staff` (`memberships.role`). A **platform admin** (the Spark Agent team, `platform_admins`) is a separate list that only the server can read, so the browser never knows who is one.

Legend: ✅ allowed · 👁 read only · ⛔ refused or hidden · — not applicable.

## Business screens

| Screen (route) | Staff | Admin | Owner | Routes and reads | Server check | Tested |
|---|---|---|---|---|---|---|
| **Home** `/dashboard` | ✅ (their own items) | ✅ | ✅ | `GET /api/dashboard/summary`, `GET /api/billing/balance`, `whatsapp_connections_public` (RLS) | Any member. The summary is scoped to the caller's own leads when staff (`dashboard/summary.ts:108`) | `home-overview.spec.ts`, `loading-states.spec.ts` |
| **Inbox** `/dashboard/inbox` | ✅ reply, take over, return to AI | ✅ | ✅ | `conversations`, `messages`, `leads` (RLS); `POST /api/conversations/:id/messages`, `/mode`, `/suggest`; `GET /api/conversations/:id/lead-card`, `/templates`; Supabase Storage signed URLs for media | `owner, admin, staff` on messages, mode, lead-card, suggest (`conversations/*.ts`, `agent/leadcard/*.ts`). The template list route: role not read in this audit | `inbox.spec.ts`, `inbox-lead-card.spec.ts`, `inbox-template-reply.spec.ts`, `inbox-media.spec.ts` |
| **Leads** `/dashboard/leads`, `/leads/:id` | ✅ read | ✅ | ✅ | `leads`, `contacts`, `bookings` (RLS) | RLS read for any member. A lead's stage, owner and outcome are changed by owner/admin, or by staff only on a lead assigned to them (0046); this screen is read-only | `leads.spec.ts`, `leads-paging.spec.ts`, `lead-detail-refresh.spec.ts` |
| **Calendar** `/dashboard/calendar` | ✅ read; actions only on their own staff calendar | ✅ | ✅ | `bookings`, `resources` (RLS); `POST /api/bookings/:id/reschedule`, `/cancel`, `/complete`, `/no-show`; `GET /api/bookings/:id/slots` | Staff only for a booking on a resource linked to them (`booking/actions.ts:72`, `:85`) | `calendar.spec.ts`, `calendar-actions.spec.ts`, unit `booking-actions.test.ts` |
| **Features** `/dashboard/features` | 👁 every switch fixed | ✅ | ✅ | `GET /api/features`, `PATCH /api/features/:key` | `owner, admin` to change (`features/toggles.ts:180`); the plan check is the server's | `features.spec.ts`, unit `feature-api.test.ts` (`rowControl`, `changeFor` for each role) |
| **Agent settings** `/dashboard/agent` | 👁 controls off, no Save | ✅ | ✅ | `GET`, `PATCH /api/agent/settings` | `owner, admin` to change (`agent/settings/agent-settings.ts:209`); any member reads | `agent-settings.spec.ts` (staff, 403) |
| **Billing** `/dashboard/billing` | ⛔ a notice instead of the screen | 👁 plan, credits, history; no pay buttons | ✅ pays and changes the plan | `GET /api/billing/balance`, `plans` and `credit_ledger` (RLS); `POST /api/billing/checkout`, `/topup`, `/setup-fee`, `/change-plan`, `/cancel`, `/resume`; `GET /api/billing/payments/:id` | Every money action is `owner` only (`billing/checkout.ts` `requireOwner`) | `billing.spec.ts`, unit `billing-data.test.ts` |
| **Knowledge base** `/dashboard/knowledge` | 👁 read; may answer unanswered questions | ✅ edit | ✅ edit | `services`, `kb_documents` (RLS); `POST /api/kb/documents`, `DELETE /api/kb/documents/:id`, `POST /api/onboarding/import-site`; `POST`, `PATCH`, `DELETE /api/kb/faqs…`; `GET /api/kb/gaps`, `POST /api/kb/gaps/:id/answer`, `/dismiss` | Documents, FAQs, import: `owner, admin`. Unanswered questions (list, answer, dismiss): `owner, admin, staff` (`kb/faqs.ts:34`). Services: RLS `is_admin` since 0028 | `knowledge.spec.ts`, `website-import.spec.ts` |
| **Booking setup** `/dashboard/settings/booking` | 👁 | ✅ | ✅ | `tenants.business_hours`, `resources`, `services` (RLS writes); `GET /api/calendar/google/connect` | Writes: RLS `is_admin` (owner/admin) since 0028. Google connect: `owner, admin` (`booking/google-calendar.ts:137`) | `booking-setup.spec.ts`, `booking-service.spec.ts` |
| **Integrations** `/dashboard/settings/integrations` | ⛔ refused by the server (the page says so) | ✅ | ✅ | `GET`, `PUT`, `DELETE /api/integrations/webhook`, `POST …/rotate-secret`, `POST …/test` | `owner, admin` on every one, reads included (`outbound-webhooks/endpoint.ts`); the Pro plan check is the server's | `webhooks.spec.ts` |
| **Data & privacy** `/dashboard/settings/privacy` | 👁 notice, no delete | ✅ | ✅ | `contacts` (RLS); `GET`, `POST /api/contacts/:id/deletion` | `owner, admin` (`consent/deletion.ts:57`, `:88`) | `privacy.spec.ts` |
| **Team** `/dashboard/team` | ✅ sees members without emails; sets their own alert number and takeover choice | ✅ invites staff only | ✅ invites admin or staff | `memberships` (own row, RLS); `GET /api/team`; `POST /api/team/invite`, `/invites/:id/resend`, `/cancel` | Invite: `owner, admin`; an admin invites `staff` only (`team/invites.ts:240`). Pending invites and emails go to owner/admin only (`:310`) | `team.spec.ts`, `team-invites.spec.ts`, `team-takeover.spec.ts` |
| **WhatsApp** `/dashboard/whatsapp` | 👁 status only | ✅ recheck | ✅ recheck, **disconnect** | `whatsapp_connections_public`, `whatsapp_templates` (RLS); `POST /api/whatsapp/connections/:id/recheck`, `/disconnect` | Recheck and disconnect: `owner, admin`. The screen offers **disconnect to the owner only**, which is stricter than the server | `whatsapp.spec.ts` |
| **Send test message**, **Create template** | ⛔ | ✅ | ✅ | `POST /api/messages/test`, `POST /api/templates` | `owner, admin` (`channels/whatsapp/test-message.ts:36`, `notify/templates.ts:23`) | `messaging.spec.ts` |

## Onboarding and public pages

| Page | Who | Routes | Server check | Tested |
|---|---|---|---|---|
| **Onboarding wizard** `/onboarding` | Any signed-in account, with or without a business | `POST /api/onboarding/trial`; `POST /api/onboarding/import-site`; `GET /api/features`, `PATCH /api/features/:key` (Team step); `GET /api/whatsapp/webhook-config`, `POST /api/whatsapp/manual`; `POST /api/onboarding/whatsapp/embedded-signup`; `whatsapp_connections_public` (RLS) | Trial: authenticated, one trial per owner phone and per number (409 `has_business` for an account that has one). Import, manual connect, Embedded Signup, webhook details: `owner, admin`. Features: `owner, admin` | `onboarding/onboarding.spec.ts`, `trial-signup.spec.ts` |
| **Connect link** `/connect/:token` | Anyone holding the link (no sign-in) | `GET /api/connect-links/:token`; `POST /api/onboarding/whatsapp/embedded-signup` with the link token | The token is random, single use, 24 hours (server). Embedded Signup also needs Meta App Review | `connect.spec.ts` (mocked) |
| **Invite** `/invite/:token` | Preview is public; accepting needs a signed-in account with a confirmed email | `GET /api/team/invites/:token`; `POST /api/team/invites/:token/accept` | Email must match; seats counted by the server | `invite.spec.ts` |

## Admin pages (the Spark Agent team)

None is in the navigation. The browser cannot tell who is on the platform-admin list, so each page calls its route and **the server's `forbidden` is the only gate**: the page then says so and shows nothing. The two plan and feature **lists** are the one exception, because they are catalogues any signed-in member reads (0001), so `/dashboard/admin/plans` shows them to anyone and the server refuses the save.

| Page | Routes | Server check | Tested |
|---|---|---|---|
| `/dashboard/admin/billing` | `GET /api/admin/tenants`, `POST …/extend-trial`, `POST …/credits`, `GET /api/admin/payments/refunds` | `requirePlatformAdmin`; each change audited with the admin | `admin-billing.spec.ts` |
| `/dashboard/admin/connections` | `GET /api/admin/whatsapp/connections` | `requirePlatformAdmin` | `admin-connections.spec.ts` |
| `/dashboard/admin/whatsapp` | `POST /api/admin/whatsapp/manual`, `POST /api/admin/whatsapp/connect-link` | `requirePlatformAdmin` | `admin-whatsapp.spec.ts`, `admin-connect-link.spec.ts` |
| `/dashboard/admin/metrics` | `GET /api/admin/metrics` | `requirePlatformAdmin` | `admin-metrics.spec.ts` |
| `/dashboard/admin/plans` (new, uncommitted) | reads `plans`, `features` (RLS catalogue); `PATCH /api/admin/plans/:key`, `PATCH /api/admin/features/:key` | `requirePlatformAdmin`; a price change is refused (409) while a business is subscribed at the old price | `admin-plans.spec.ts`, unit `lib/admin/catalogue.test.ts` |

Not built, and why: **open a business's dashboard with an audit entry** has no route (`backend/src/server/routes.ts`); see the cross-team requests.

## Where the screen is stricter or looser than the server

These are not bugs by themselves; they are the places a reader would otherwise be surprised.

| Where | Screen | Server | Note |
|---|---|---|---|
| Disconnect a WhatsApp number | Owner only | Owner or admin | A deliberate choice recorded in the regression matrix (WA-4) |
| Dismiss an unanswered question | Owner or admin | Owner, admin or staff | The server would accept a staff dismiss; the screen does not offer it |
| Billing | Staff see nothing; admin reads | `GET /api/billing/balance` is read by every role for Home; money actions owner only | Admin can read the plan and history but not pay |
| Integrations | Staff see the refusal | Staff refused on every call, including reads | Consistent |

## How this is kept honest

- `backend/src/server/authorization-routes.test.ts` drives the real route table with owner, admin, staff, mixed and platform-admin tokens and proves a refused call reads or writes nothing. It is the server-side matrix. It does not prove RLS or the SQL functions.
- `frontend/lib/api/backend-routes.test.ts` fails when the frontend calls a route the API does not register, or the API registers a route nobody classified.
- What none of these prove: real RLS from a browser session, a real platform-admin lookup, Realtime events scoped to a role. Those need staging (regression matrix, section M).
