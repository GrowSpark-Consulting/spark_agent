# Team invites: what is missing, and a proposal for review (Dev 3, 14 Oct 2026)

**Status: proposal only. No code, no migration.** `POST /api/team/invite` is Dev 3's route (`docs/handover.md` line 949), but the contract
that exists is too thin to build it without inventing a schema, a login flow and a permission model. This note says exactly what is
missing and proposes answers, so Raja / Shaaz / Dev 1 can accept or change them in one pass. Nothing here has been built or approved.

## What exists today (checked on `origin/main` `aa69eca`)

| Piece | State |
|---|---|
| Route | Not registered. `routes.ts` has no `/api/team/*`. |
| Contract | `docs/dashboard-screen-contracts.md` ("Team"): `InviteInput { name, phone, role: 'admin' \| 'staff' }`, `POST /api/team/invite` "seat limit → 403 seat_limit", `PATCH /api/team/:userId` proposed. Member `status: 'active' \| 'invited'`. |
| Seat helpers | `billing/plan-limits.ts`: `seatUsage`, `assertSeatAvailable` (→ `seat_limit`, 409), `planLimitError`. They count **memberships only**. |
| Database | Migration 0027 trigger `memberships_seat_limit` (AFTER INSERT, locks the tenant row `for no key update`) refuses a membership past `plans.seats` with `PA413`. Concurrency script: `scripts/db/plan-limit-concurrency.sh`. |
| Tables | `memberships(tenant_id, user_id, role, whatsapp_phone, takeover_pref)`. **No invites table, no pending state, no name or email column.** Members cannot change roles or add members (0002 revokes UPDATE except two own columns). |
| Auth | Supabase Auth with **email + password** (`/login`, `/signup`, `/forgot-password`, `/auth/callback`). A person is an `auth.users` row. |
| Plan seats | Trial and Starter 2, Growth 5, Pro 999 (unlimited). |

## The gaps (each needs a decision)

1. **Who is the invitee?** The contract has `name` and `phone` but no email. Sign-in is by email, so an invite has to be tied to an email to be accepted by the right person. A phone alone cannot create or find a login.
2. **How is it accepted?** No accept route, no accept page, no token. Nothing says whether the invitee gets an email, a WhatsApp message or a link the admin passes on.
3. **Where is the invitee's name stored?** `memberships` has no name. `auth.users.raw_user_meta_data` is user-owned, and the Team contract's `name` / `initials` / `displayRole` need a home.
4. **What does a pending invite cost?** `seatUsage` counts memberships only, so ten pending invites on a 2-seat plan would all be sendable and then fail at acceptance.
5. **Who may invite whom?** `InviteInput.role` allows `admin` and `staff`; nothing says whether an admin may invite another admin.
6. **Duplicates, resend, cancel, expiry.** Unspecified.
7. **How are two simultaneous invites handled?** The trigger protects memberships, not invitations.

## Proposal

### Flow (no email infrastructure needed)

1. An owner (or admin, see "Roles") opens Team → Invite, enters **name, email, role** (phone optional: it becomes their alert number only after they accept and set it themselves, as today).
2. `POST /api/team/invite` creates a pending invite and returns **`{ invite, url }` once**. The URL is `/invite/<token>` (same single-reveal pattern as the assisted connect link). The inviter copies it and sends it by WhatsApp or email. A later PR can send the email from our domain; the token flow does not change.
3. The invitee opens `/invite/<token>` (public page, reads `GET /api/team/invites/:token` → `{ businessName, role, inviterName?, expiresAt }`), signs in or signs up **with the invited email**, and presses Accept.
4. `POST /api/team/invites/:token/accept` (bearer token required) checks the signed-in user's email equals the invite's email, then in one transaction consumes the invite and inserts the membership. The existing 0027 trigger remains the last seat gate.

Why not Supabase `inviteUserByEmail`: it creates the `auth.users` row up front and sends Supabase's own email, which needs SMTP configured and gives no way to attach a role, a seat reservation or an expiry we control, and an invite to an email that already has an account behaves differently. The token flow works for new and existing accounts the same way.

### Data (one append-only migration, e.g. `00NN_team_invites.sql`)

```
team_invites(
  id uuid pk, tenant_id uuid not null → tenants on delete cascade,
  email text not null (stored lower-cased), name text not null, role text check in ('admin','staff'),
  token_hash text not null unique,            -- SHA-256 of a 32-byte base64url token, like connect_links (0016); the raw token is never stored
  invited_by uuid not null → auth.users, created_at, expires_at (created + 7 days),
  accepted_at, accepted_by uuid, cancelled_at )
unique (tenant_id, email) where accepted_at is null and cancelled_at is null    -- one live invite per email per business
RLS: enabled; owner/admin of the tenant may SELECT (token_hash excluded via a view or column grant); no browser INSERT/UPDATE/DELETE (the API uses the service role).
memberships: add `display_name text` (set from the invite on accept; the member edits their own through the existing own-row UPDATE grant).
```

### Seats, including pending invites

- A pending, unexpired invite **reserves a seat**: `used = memberships + live invites`. `assertSeatAvailable` gains the second count (Dev 2 owns `plan-limits.ts`; the change is two lines and needs their OK, or the invite route computes it itself without touching their helper).
- The create itself is a SQL function `create_team_invite(...)` that takes the tenant row lock the 0027 trigger uses (`select ... from tenants where id = $1 for no key update`), counts memberships + live invites, refuses with `PA413` / `seat_limit`, and inserts. Two simultaneous invites therefore serialise on the tenant row, the same way two simultaneous memberships already do. Extend `plan-limit-concurrency.sh` with an invite case.
- Accepting converts the reservation into a membership (the invite stops being "live" in the same transaction), so the count does not change; the trigger still refuses if the plan was downgraded in between (the invite stays pending and the invitee is told the business has no free seat).

### Roles and permissions

- Owner: may invite `admin` or `staff`. Admin: may invite `staff` only (so an admin cannot create a peer or an owner). Staff: no access (403 `forbidden`). Nobody can invite as `owner`.
- Tenant comes from `X-Pakka-Tenant` + membership (`requireTenant`), never from the body. The invitee's existing memberships in other businesses do not matter: one person can belong to several.
- Cancel (`DELETE /api/team/invites/:id`) and resend: owner/admin of the same business only; an admin cannot cancel an invite an owner made for an admin.

### Duplicates, resend, expiry

| Case | Answer |
|---|---|
| Email is already a member of this business | `conflict` "That person is already on your team." |
| A live invite for that email exists | Default `conflict` with `fields.email`; `POST /api/team/invites/:id/resend` rotates the token (the old link stops working), resets the 7-day expiry, returns the new URL once. Resend does not change the reserved seat. At most 5 resends a day per invite. |
| Expired invite | `GET`/`accept` answer the same `not_found` as an unknown token (no oracle). The row stops counting as a seat after `expires_at`; a new invite for the email replaces it. |
| Wrong signed-in email on accept | `forbidden` "This invitation was sent to a different email address." (never reveals the invited address) |
| Accept twice / race | One conditional UPDATE (`where accepted_at is null and cancelled_at is null and expires_at > now()`), like the connect-link claim; the loser gets `not_found`. |
| Invite when the plan is `Trial`/`Starter` with 2 seats and 2 members | `seat_limit` (409) → the Team screen's upgrade dialog. (The screen contract says 403; `AppError seat_limit` is 409 today. Needs one line from Dev 2/Raja.) |

### Frontend (after the above is agreed)

Team screen: member list (name, role, `status: active | invited`, seats used / limit including pending), Invite form (name, email, role) with the seat-limit upgrade dialog, a one-time "Copy invite link" panel (same behaviour as the admin connect-link generator, PR #181), resend and cancel on pending rows, `/invite/:token` accept page. Loading, error, duplicate-press protection and no secret in storage, as elsewhere.

### Tests to write with it

Authorisation (owner, admin→staff only, staff refused, other business's id refused); tenant isolation (invite and member lists never cross businesses); seat limits with live invites counted, at the boundary, and the concurrent case (two invites racing for the last seat; an invite and a membership racing); duplicates (member, live invite, case-insensitive email); invalid input (email shape, role, name length); accept (wrong email, expired, used, cancelled, downgrade between invite and accept); no raw token in the database, logs or audit rows.

## Decisions needed

| # | Question | Proposed answer | Owner |
|---|---|---|---|
| 1 | Invite by email, with the link passed on by hand for now? | Yes | Raja |
| 2 | Add `email` to `InviteInput`; keep `phone` optional? | Yes | Raja / Dev 3 |
| 3 | Add `team_invites` and `memberships.display_name` (one migration)? | Yes | Dev 2 (schema owner) |
| 4 | Pending invites reserve seats? | Yes | Raja / Dev 2 |
| 5 | Admin may invite staff only? | Yes | Raja |
| 6 | Expiry 7 days; 5 resends a day? | Yes | Raja |
| 7 | `seat_limit` status 409 (as built) vs 403 (as in the screen contract)? | Keep 409; fix the contract text | Dev 2 |
| 8 | Who sends the email later (our domain / Resend)? | Out of scope for the first version | Raja |

## What Dev 3 will do once 1–7 are answered

Migration + `create_team_invite()` and `accept_team_invite()` SQL functions with pgTAP-style tests in `supabase/tests`; routes in `routes.ts`; `packages/types` contracts; the Team screen and `/invite/:token` page; Playwright at three widths. Until then nothing is built, and the Team screen keeps saying that members and invitations "will be added here later".
