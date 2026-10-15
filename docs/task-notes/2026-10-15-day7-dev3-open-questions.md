# Day 7, Dev 3: open questions for Dev 1 and Dev 2 (15 Oct 2026)

Dev 3's screens that wait on a backend contract. Nothing below is built on a guess: each item says what the screen does today and what would unblock it.

## Dev 2: message media (signed URLs)

State today: `messages.media` holds `{ id, mime }`, and once the download job has run, also `path` (a path in the private `message-media` bucket), `size`, `storedAt`, or `skipped` / `unavailable` with a reason. The inbox shows a placeholder tile ("Can't be shown here yet"), or the reason when the job left the file out. It never shows or uses `path`.

Questions:
No signed-URL helper or route exists in the repository (`backend/src/lib/storage.ts` has path building, listing and removal only; nothing calls `createSignedUrl`).

1. Is there an approved route or helper that returns a short-lived signed URL for one message's file (for example `GET /api/messages/:id/media`), or should the browser sign with its own session, which 0047's `message_media_member_read` policy allows?
2. Who may call it: any member of the business, or owners and admins only? Does staff with no access to a chat get the file?
3. Does the server check the tenant (`X-Pakka-Tenant`) and that the path's first folder matches, or is the storage policy the only check?
4. How long does a URL live, and may the browser cache it? What does the screen show when it has expired?
5. Which kinds are served inline: images only, or also documents and audio? (The job stores images and documents only; voice notes are `not_media`.)

## Dev 2: outbound webhooks (Settings → Integrations)

State today: five routes exist (`GET|PUT|DELETE /api/integrations/webhook`, `POST .../rotate-secret`, `POST .../test`), documented in `docs/contracts.md` (section on outbound webhooks) with types in `packages/types/src/integrations.ts`. `lib/api/backend-routes.test.ts` lists them as having no browser caller. No screen exists.

Answered by the repository (read in `backend/src/outbound-webhooks/endpoint.ts` and the contract; not run against a database):
- **Roles:** owner and admin only, for every operation including the read (`requireRole(context, ["owner", "admin"])`).
- **Pro gating:** `GET` returns `inPlan` and `sending`; `PUT` and `test` answer `plan_required` (403) when the plan lacks `outbound_webhooks`. Events are sent only while the plan includes it, the Features switch is on, the business is live and the endpoint is active.
- **Secret:** `whsec_...` is returned once, on create (`PUT` with `secret` set); a change answers `secret: null`; rotate returns a new `{ secret, secretHint }` and the old one stops at once. The read never returns it.
- **Test:** `{ delivered, status, error }`, a signed `ping`; changes nothing; `not_found` when there is no endpoint.
- **Validation:** `url` https, port 443 or 8443, no credentials, no private or reserved address (`validation_failed` with `fields.url`).

Still to confirm with Dev 2 before a screen is built:
1. Is the screen wanted now, and where (Settings → Integrations, owner and admin only, hidden or locked for staff)?
2. Is there any read of recent deliveries (status, attempts, last error)? The contract exposes only `lastSuccessAt`, `lastFailureAt` and `lastFailure` on the endpoint.
3. Is `test` rate limited, and does a failing test count toward `lastFailure`? (The code does not update the endpoint row; confirm that is intended.)
4. Wording for the locked state: show the form read-only for a non-Pro business, or an upgrade note only?

## Dev 1: Agent settings

State today: `features/agent/pakka-agent.tsx` is the sample-data prototype, reachable only at `/dashboard/preview?screen=agent`. Its Save wrote nothing but said "Saved. Maya uses this from the next message." Save is now off and the note says the settings are not saved. Persona, tone, hours and triggers on this screen are fixtures, not the business's own values.

What the backend reads from `tenants.agent_settings` (`backend/src/agent/pipeline/persona.ts`): `persona`, `tone`, `privacyNotice`, `bookingServiceId`, `handoffTriggers: [{ key, enabled }]`. The booking-service screen already updates that column from the browser under RLS (`features/settings/booking-service.ts`).

Questions:
1. Will Dev 1 build `PATCH /api/agent/settings` (docs/dashboard-screen-contracts.md marks it PROPOSED), or is the direct browser write under RLS approved for persona, tone and `handoffTriggers`?
2. If direct: confirm the key names (`handoffTriggers[].key` values: `kb_gap`, `asked_human`, `complaint`, `negotiation`, `hot_lead`) and that writes merge into the existing object, never replace it.
3. Where do languages, scoring weights and thresholds, and the takeover default live? The backend reads none of them from `agent_settings`; the contract lists them but no column or route exists. Until answered, the screen will not offer them as saved settings.
4. Business hours: `tenants.business_hours` is already edited under Settings; should the Agent screen link there and drop its own copy?

## Not verified (no Docker on this machine)

Migrations 0048, 0049 and 0050 and their SQL tests (`unpaid_trial_deletion`, `browser_write_audit`, `outbound_webhooks`, `isolation`) have been read, not run. RLS, the audit triggers, the webhook outbox and the storage deletion path need `pnpm db:reset` and `pnpm db:test` on a machine with Docker, and a staging check of the unpaid-trial deletion against real storage.
