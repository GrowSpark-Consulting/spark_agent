#!/usr/bin/env bash
# Two people grab the same slot at the same moment (9-day plan, Day 3 exit test 3): 20 parallel hold_slot
# calls for one time with one person, each for a different lead, on separate connections. Exactly one must
# win and the other 19 must be refused by the exclusion constraint; 5 parallel callbacks with no person at the
# same time must all succeed. Needs psql and the local Supabase database (pnpm db:start); runs in CI.
set -euo pipefail

DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
TENANT="cc000000-0000-0000-0000-0000000000b1"
RESOURCE="cc300000-0000-0000-0000-0000000000b1"
SERVICE="cc400000-0000-0000-0000-0000000000b1"
HOLDS=20
CALLBACKS=5
START="date_trunc('hour', now()) + interval '2 days'"

q() { psql "$DB_URL" -v ON_ERROR_STOP=1 -qtAX -c "$1"; }
lead() { printf 'cc200000-0000-0000-0000-0000000000%02d' "$1"; }

q "delete from public.tenants where id = '$TENANT';"
q "insert into public.tenants (id, name, vertical) values ('$TENANT', 'Hold Race', 'test-pack');
   insert into public.resources (id, tenant_id, type, name) values ('$RESOURCE', '$TENANT', 'staff', 'Only Staff');
   insert into public.services (id, tenant_id, name, duration_min, resource_type) values ('$SERVICE', '$TENANT', 'Visit', 60, 'staff');
   insert into public.contacts (id, tenant_id, phone)
     select ('cc100000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid, '$TENANT', '+9198000005' || lpad(n::text, 2, '0')
     from generate_series(1, $((HOLDS + CALLBACKS))) n;
   insert into public.leads (id, tenant_id, contact_id)
     select ('cc200000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid, '$TENANT',
            ('cc100000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid
     from generate_series(1, $((HOLDS + CALLBACKS))) n;"

out=$(mktemp -d)
for i in $(seq 1 "$HOLDS"); do
  # Each call keeps its transaction open briefly, so the calls overlap and wait on each other's exclusion check.
  psql "$DB_URL" -v ON_ERROR_STOP=1 -qtAX \
    -c "begin; select (public.hold_slot('$TENANT', '$(lead "$i")', 'site_visit', $START, $START + interval '1 hour', '$RESOURCE', '$SERVICE')).id is not null; select pg_sleep(0.05); commit;" \
    > "$out/hold-$i" 2>&1 &
done
for i in $(seq 1 "$CALLBACKS"); do
  psql "$DB_URL" -v ON_ERROR_STOP=1 -qtAX \
    -c "begin; select (public.hold_slot('$TENANT', '$(lead $((HOLDS + i)))', 'callback', $START, $START + interval '1 hour')).id is not null; select pg_sleep(0.05); commit;" \
    > "$out/callback-$i" 2>&1 &
done
wait

# Counted with `|| true` inside the pipelines: a count of 0 must reach the check below, not stop the script silently.
won=$(cat "$out"/hold-* | grep -cx t || true)
refused=$({ grep -l "violates exclusion constraint" "$out"/hold-* || true; } | wc -l | tr -d ' ')
deadlocks=$({ grep -l "deadlock detected" "$out"/hold-* "$out"/callback-* || true; } | wc -l | tr -d ' ')
callbacks=$(cat "$out"/callback-* | grep -cx t || true)
held=$(q "select count(*) from public.bookings where tenant_id = '$TENANT' and resource_id = '$RESOURCE' and status = 'held';")
q "delete from public.tenants where id = '$TENANT';"

echo "holds=$HOLDS won=$won refused=$refused deadlocks=$deadlocks held_rows=$held callbacks=$CALLBACKS callbacks_ok=$callbacks"
if [ "$won" = 1 ] && [ "$refused" = "$((HOLDS - 1))" ] && [ "$held" = 1 ] && [ "$callbacks" = "$CALLBACKS" ]; then
  echo "PASS exactly one hold wins the race; callbacks with no person never clash"
else
  echo "FAIL hold race"
  grep -h -i error "$out"/* | grep -v "violates exclusion constraint" | head -5 || true
  exit 1
fi
