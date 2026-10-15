# Team invitations: what was built, what is guaranteed, what is not yet proved (Dev 3, 15 Oct 2026)

Built from the approved contract in `2026-10-14-day6-dev3-team-invite-proposal.md` (decisions 1-7 approved by Dev 2). Email delivery is out of scope: the link is copied and passed on by hand.

## Pieces

| Piece | Where |
|---|---|
| Migration | `supabase/migrations/0052_team_invites.sql`: `memberships.display_name`; `team_invites`; `create_team_invite`, `resend_team_invite`, `cancel_team_invite`, `accept_team_invite` (service role only) |
| Shared contract | `packages/types/src/team.ts` |
| API | `backend/src/team/invites.ts`; routes in `backend/src/server/routes.ts` |
| Team screen | `frontend/features/team/members-section.tsx`, `team-api.ts` |
| Invitation page | `frontend/app/invite/[token]`, `frontend/features/invite/` |
| Sign-in / sign-up return to the invitation | `frontend/lib/auth/redirect.ts` (`inviteNext`), `lib/auth/actions.ts` (signup), `signup-form.tsx`, `signup/page.tsx` |

Routes: `GET /api/team`, `POST /api/team/invite`, `POST /api/team/invites/:id/resend`, `POST /api/team/invites/:id/cancel`, `GET /api/team/invites/:token` (public), `POST /api/team/invites/:token/accept`.

## Guarantees and where each is enforced

- **Roles.** Owner invites admin or staff; admin invites staff only; staff nothing; nobody invites an owner. Checked in the API (plain 403 first) and again in the SQL functions (`team_invite_actor_role`), and the table's role check refuses `owner`. The tenant is the caller's own membership (`requireTenant`); a tenant id in a body or path is never read.
- **Seats.** used = memberships + live (pending, unexpired) invitations. `create_team_invite` takes the business's row lock (`FOR NO KEY UPDATE`, the same lock as the 0027 trigger) before counting, so racing invitations take turns. Expired invitations stop counting by themselves (every count says `expires_at > now()`; no job). The API does **not** also call `assertSeatAvailable`, so nothing is counted twice, and `billing/plan-limits.ts` is untouched.
- **Token.** 32 random bytes, base64url, hashed with the connect-link helper (`lib/connect-link-token.ts`). Only the SHA-256 is stored (a check constraint refuses anything that is not 64 hex characters). The raw link is returned only by create and resend (`cache-control: no-store`) and is kept only in the component's memory. It is never audited, logged or stored; the audit rows hold role, expiry and ids.
- **Resend.** Rotates the hash (the old link stops working at once), resets the expiry to seven days, keeps the seat. At most 5 per 24 hours per invitation, counted under the invitation's row lock. Resending an *expired* invitation brings it back, so that case checks for a free seat.
- **Accept.** Needs a bearer token; the user id and email come from the verified token. The email must be confirmed and must equal the invited address (trimmed, lower-cased). In one transaction, under the business lock then the invitation's lock: re-check live, mark accepted, insert the membership with the invited role. A second use, an expired, cancelled or unknown token all give the same `not_found`. A member who already belongs keeps their role and the invitation is used up. If the plan was lowered since, the 0027 trigger refuses (409 `seat_limit`) and the whole statement is undone, so the invitation stays pending.
- **Browser.** `team_invites` is readable only by an owner or admin of the business, by a column grant that leaves out `token_hash`; no browser write.

## Decisions I made that need a yes from Dev 2 / Raja

1. **The public preview says why a link is dead** (`valid | expired | used | revoked`), where the proposal said expired should look like unknown. The task asked for distinct invalid / expired / already-used pages. A token is 256 random bits, so only someone who was given the link learns this; an unknown or malformed token is still one `not_found`, and the invited address is never returned. Say if you want the stricter answer.
2. **The 0027 seat trigger still counts memberships only.** A membership added by some path other than accepting an invitation (none exists today) could therefore take a seat an invitation holds. Accept is safe because it marks its own invitation accepted first. If you want the database to refuse that too, change the trigger to count live invitations; I did not, because it is shared schema.
3. **Cancel** (`POST .../cancel`, not in the seven decisions) is included, since "revoked" has to be possible. It is audited and follows the same role rules.
4. **`name` is required** on the invitation (it becomes `memberships.display_name`), as in the proposal. Phone is not collected.
5. **Resend limit is per invitation, rolling 24 hours** from the first resend in the window.
6. **Expired invitation for the same address** is deleted when a new one is made (its old link then reads as unknown).
7. **Sign-up from an invitation.** `safeNext` now accepts exactly `/invite/<43 chars>`; sign-up continues there instead of to onboarding. Email-confirmation links keep `next` through `/auth/callback`. This needs `/auth/callback?next=/invite/...` to be on Supabase's redirect allow list if the allow list is strict (not checked; no access).
8. **`display_name` is not editable by the member** (the 0002 grant is unchanged).

## Known gaps

- Email delivery, and showing the link again after it is lost (use "New link").
- `PATCH /api/team/:userId` (role changes, removing a member) is still proposed only.
- The Team screen's old contract (`phone` in `InviteInput`, 403 for `seat_limit`) in `docs/dashboard-screen-contracts.md` is updated to match.
