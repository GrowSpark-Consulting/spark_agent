# Dev 3: Day 5 audit (12 Oct 2026)

Branch `feat/dev3-day2-4-closure`, all work uncommitted. Nothing committed, pushed, merged, migrated or deployed. No backend, migration or shared-type file changed. Builds on `dev-3-day2-4-closure-and-integration-audit.md` (Day 2–4 matrix stays valid except where noted).

Evidence: unit and mocked E2E only. No staging, real Supabase, Meta, Realtime or Docker run.

## Day 5 matrix

| Task | Status | Evidence | Remaining |
|---|---|---|---|
| Features screen from `GET /api/features`; locked rows show Upgrade; credits per toggle; locked never shown as enabled | DONE (mocked) | `features/toggles/*`, `app/(dashboard)/dashboard/(app)/features`; `feature-api.test`, `features.spec`. Schemas now imported from `@pakka/types` (this run), which match backend `toggles.ts` | Not seen against the real route or a Starter tenant (exit test 1) |
| WhatsApp connection screen: method, name, limit, quality, six checks, template status, recheck, disconnect | DONE (mocked) | `whatsapp-connection-panel`, `whatsapp-template-status`, `lib/whatsapp/*`; `whatsapp.spec`, `last-check.test`, `templates.test` | Real Meta unseen; wording provisional (Raja) |
| Admin manual form → `POST /api/admin/whatsapp/manual` | DONE (mocked) | `admin-manual-connect-form`, `lib/whatsapp/admin-connect`; `admin-connect.test`, `admin-whatsapp.spec` | Platform-admin gate is server-side; all six checks need a live Meta test number (exit test 2) |
| Calendar actions → booking routes | DONE (mocked) | `features/calendar/booking-actions*`; request/response checked this run against `backend/src/booking/actions.ts` and `bookings.ts` (Booking, Slot shapes match); `booking-actions.test`, `calendar-actions.spec` | Customer is not messaged on cancel/move (backend contract; open question for Raja) |
| Home v1: credit meter as leads, month summary, after-hours | PARTIAL / BLOCKED | `features/home/*`; `home-api.test`, `home-overview.spec` | `GET /api/dashboard/summary` and `GET /api/billing/balance` are **not registered** in `routes.ts`. Home says "not available yet" and shows no invented numbers. Owner: Dev 2 |

## Changes this run

- `frontend/lib/api/backend-routes.test.ts`: the drift guard correctly failed because Dev 2's features and booking routes reached `main`. Moved those 7 routes into `FRONTEND_CALLS`; only the two Home routes remain "awaiting".
- `frontend/features/toggles/feature-api.ts`: dropped the hand-mirrored zod schemas and re-exports the shared ones from `@pakka/types`.
- `frontend/features/calendar/booking-actions.ts`: header comment corrected (routes are on main).

## Verification (frontend only)

| Command | Result |
|---|---|
| `tsc --noEmit` | pass |
| `eslint .` | pass |
| `vitest run` | 54 files, 930 passed, 4 todo (before the fix: 2 failed in the drift guard) |
| `playwright test` features, admin-whatsapp, calendar-actions, home-overview, whatsapp (2 workers, 3 widths) | 157 passed, 0 failed |
| `git diff --check` | clean |
| Full Playwright suite, backend tests, `pnpm db:test` | not run in this pass; Docker is off, so database tests are NOT RUN |

## Blockers

1. Home summary and balance routes: Dev 2.
2. Unchanged from the Day 2–4 report: staff-alert buttons (AH-1), own-number return (XM-1), plan entitlement for Team (OW-1), role-aware RLS, Realtime publication of `leads`/`bookings`.
3. Exit tests 2–5 (live Meta, wrong-token message, isolation suite, 20 chats in CI, recheck/disconnect pausing the AI) need staging or backend CI: Dev 1/Dev 2/ops.

## Next actions

1. The inbox template picker is built (see the addendum below, PR P2). Next: split or review the remaining work, then ask Dev 2 for the Home routes.
2. Ask Dev 2 for the Home routes, or a decision to read Supabase directly.
3. Split and commit this uncommitted work into small PRs.

## Addendum: inbox template picker (12 Oct 2026)

Contract verified in code: `POST /api/conversations/:id/messages` accepts `{ template: { name, language, params } }` (`SendStaffTemplateInput`, packages/types/src/whatsapp.ts; `backend/src/conversations/staff-reply.ts`), answers `{ messageId, providerMsgId, status: "accepted" }`, refuses unapproved templates (`not_found`) and a wrong value count (`validation_failed`). Built: `features/inbox/template-reply.ts`, `template-reply-panel.tsx`, `sendStaffTemplate` in `staff-reply.ts`, panel mounted in the closed-window strip of `chat-view.tsx`. Tests: 159 inbox unit tests pass; `inbox-template-reply.spec.ts` plus inbox, inbox-limits and inbox-lead-card specs: 211 passed, 6 skipped, 0 failed (mocked). Limit: a chat has no connection id on the frontend, so with several numbers the list can include a template approved on another number; the API then refuses it and the screen says so.
