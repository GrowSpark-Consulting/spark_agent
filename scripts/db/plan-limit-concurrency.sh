#!/usr/bin/env bash
# Plan limits under a race (0027; 9-day plan, Day 5): 10 members added to an empty Trial business (2 seats) at the
# same moment, and 10 numbers connected to a Starter business (1 number) at the same moment, each on its own
# connection. Exactly 2 members and 1 number must get in; every other attempt must be refused by the limit. Needs psql
# and the local Supabase database (pnpm db:start); runs in CI.
set -euo pipefail

DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
SEATS_TENANT="0d000000-0000-0000-0000-0000000000a1"
NUMBERS_TENANT="0d000000-0000-0000-0000-0000000000b1"
CHANNEL="0d100000-0000-0000-0000-0000000000b1"
TRIES=10

q() { psql "$DB_URL" -v ON_ERROR_STOP=1 -qtAX -c "$1"; }
user() { printf '0d200000-0000-0000-0000-0000000000%02d' "$1"; }

cleanup() {
  q "delete from public.tenants where id in ('$SEATS_TENANT', '$NUMBERS_TENANT');
     delete from auth.users where email like 'race-%@test.local';"
}
cleanup
q "insert into public.tenants (id, name, vertical, plan_key) values
     ('$SEATS_TENANT', 'Seat Race', 'test-pack', 'trial'), ('$NUMBERS_TENANT', 'Number Race', 'test-pack', 'starter');
   insert into public.channels (id, tenant_id, type) values ('$CHANNEL', '$NUMBERS_TENANT', 'whatsapp');
   insert into auth.users (id, email)
     select ('0d200000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'race-' || n || '@test.local'
     from generate_series(1, $TRIES) n;"

out=$(mktemp -d)
for i in $(seq 1 "$TRIES"); do
  # Each attempt keeps its transaction open briefly, so the attempts overlap and wait on the business's row lock.
  psql "$DB_URL" -v ON_ERROR_STOP=1 -qtAX \
    -c "begin; insert into public.memberships (tenant_id, user_id, role) values ('$SEATS_TENANT', '$(user "$i")', 'staff'); select pg_sleep(0.05); commit;" \
    > "$out/seat-$i" 2>&1 &
  psql "$DB_URL" -v ON_ERROR_STOP=1 -qtAX \
    -c "begin; insert into public.whatsapp_connections (tenant_id, channel_id, method, waba_id, phone_number_id, token_enc, token_type, connected_by)
        values ('$NUMBERS_TENANT', '$CHANNEL', 'manual_byo', 'race-waba', 'race-pn-$i', 'placeholder', 'system_user', 'system'); select pg_sleep(0.05); commit;" \
    > "$out/number-$i" 2>&1 &
done
wait

# Counted with `|| true` inside the pipelines: a count of 0 must reach the check below, not stop the script silently.
seats=$(q "select count(*) from public.memberships where tenant_id = '$SEATS_TENANT';")
numbers=$(q "select count(*) from public.whatsapp_connections where tenant_id = '$NUMBERS_TENANT';")
seat_refused=$({ grep -l "seat_limit" "$out"/seat-* || true; } | wc -l | tr -d ' ')
number_refused=$({ grep -l "whatsapp_number_limit" "$out"/number-* || true; } | wc -l | tr -d ' ')
cleanup

echo "seats: tries=$TRIES in=$seats refused=$seat_refused; numbers: tries=$TRIES in=$numbers refused=$number_refused"
if [ "$seats" = 2 ] && [ "$seat_refused" = "$((TRIES - 2))" ] && [ "$numbers" = 1 ] && [ "$number_refused" = "$((TRIES - 1))" ]; then
  echo "PASS a business never gets past its plan's seats or numbers, even at the same moment"
else
  echo "FAIL plan limit race"
  grep -h -i error "$out"/* | grep -v -E "seat_limit|whatsapp_number_limit" | head -5 || true
  exit 1
fi
