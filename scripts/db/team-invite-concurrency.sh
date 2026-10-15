#!/usr/bin/env bash
# Team invitations under a race (0052): 10 invitations for the same business at the same moment, and 10 resends of one invitation
# at the same moment, each on its own connection.
#   * Seats: a Trial business (2 seats) has its owner, so exactly 1 of the 10 invitations may be made; the other 9 must be refused
#     with seat_limit, and the business ends with 1 live invitation.
#   * Resends: one invitation, 10 resends together: exactly 5 may pass (five a day); the other 5 must be refused with resend_limit.
# Needs psql and the local Supabase database (pnpm db:start); runs in CI.
set -euo pipefail

DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
SEATS_TENANT="0e000000-0000-0000-0000-0000000000a1"
RESEND_TENANT="0e000000-0000-0000-0000-0000000000b1"
OWNER="0e200000-0000-0000-0000-0000000000a1"
OWNER_B="0e200000-0000-0000-0000-0000000000b1"
TRIES=10

q() { psql "$DB_URL" -v ON_ERROR_STOP=1 -qtAX -c "$1"; }
hash() { printf '%064x' "$1"; }

cleanup() {
  q "delete from public.tenants where id in ('$SEATS_TENANT', '$RESEND_TENANT');
     delete from auth.users where email like 'invite-race-%@test.local';"
}
cleanup
q "insert into auth.users (id, email) values ('$OWNER', 'invite-race-a@test.local'), ('$OWNER_B', 'invite-race-b@test.local');
   insert into public.tenants (id, name, vertical, plan_key) values
     ('$SEATS_TENANT', 'Invite Seat Race', 'test-pack', 'trial'), ('$RESEND_TENANT', 'Invite Resend Race', 'test-pack', 'growth');
   insert into public.memberships (tenant_id, user_id, role) values ('$SEATS_TENANT', '$OWNER', 'owner'), ('$RESEND_TENANT', '$OWNER_B', 'owner');"
INVITE_ID=$(q "select invite_id from public.create_team_invite('$RESEND_TENANT', 'resend-race@test.local', 'Resend Race', 'staff', '$OWNER_B', '$(hash 999)');")

out=$(mktemp -d)
for i in $(seq 1 "$TRIES"); do
  # Each attempt keeps its transaction open briefly, so the attempts overlap and wait on the business's row lock.
  psql "$DB_URL" -v ON_ERROR_STOP=1 -qtAX \
    -c "begin; select invite_id from public.create_team_invite('$SEATS_TENANT', 'invitee-$i@test.local', 'Invitee $i', 'staff', '$OWNER', '$(hash "$i")'); select pg_sleep(0.05); commit;" \
    > "$out/seat-$i" 2>&1 &
  psql "$DB_URL" -v ON_ERROR_STOP=1 -qtAX \
    -c "begin; select invite_id from public.resend_team_invite('$RESEND_TENANT', '$INVITE_ID', '$OWNER_B', '$(hash "$((1000 + i))")'); select pg_sleep(0.05); commit;" \
    > "$out/resend-$i" 2>&1 &
done
wait

# `|| true` inside the pipelines: a count of 0 must reach the check below, not stop the script silently.
live=$(q "select count(*) from public.team_invites where tenant_id = '$SEATS_TENANT' and accepted_at is null and cancelled_at is null and expires_at > now();")
seat_refused=$({ grep -l "seat_limit" "$out"/seat-* || true; } | wc -l | tr -d ' ')
resends=$(q "select resend_count from public.team_invites where id = '$INVITE_ID';")
resend_refused=$({ grep -l "resend_limit" "$out"/resend-* || true; } | wc -l | tr -d ' ')
cleanup

echo "invites: tries=$TRIES live=$live refused=$seat_refused; resends: tries=$TRIES passed=$resends refused=$resend_refused"
if [ "$live" = 1 ] && [ "$seat_refused" = "$((TRIES - 1))" ] && [ "$resends" = 5 ] && [ "$resend_refused" = "$((TRIES - 5))" ]; then
  echo "PASS invitations never reserve more seats than the plan has, and resends stop at five, even at the same moment"
else
  echo "FAIL team invite race"
  grep -h -i error "$out"/* | grep -v -E "seat_limit|resend_limit" | head -5 || true
  exit 1
fi
