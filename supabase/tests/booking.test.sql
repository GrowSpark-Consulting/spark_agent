-- Booking engine (0015): holds, the exclusion constraint, confirm, reschedule, cancel and the release of
-- expired holds. Run: pnpm db:test. True concurrency (two holds at the same moment) is
-- scripts/db/hold-slot-concurrency.sh. A lead holds one time at a time, so each scenario uses its own lead.
begin;
create extension if not exists pgtap with schema extensions;
select plan(43);

-- Times relative to now(), which is fixed for the whole transaction: base is the day after tomorrow, 10:00 UTC.
create function pg_temp.at(p_hours numeric) returns timestamptz language sql stable as $$
  select date_trunc('day', now()) + interval '2 days 10 hours' + make_interval(secs => p_hours * 3600)
$$;

-- Fixtures, inserted as the migration owner: business A (two staff, a designer, a service, five leads),
-- business B (one staff member, one lead).
insert into public.tenants (id, name, vertical) values
  ('7d000000-0000-0000-0000-00000000000a', 'Book A', 'test-pack'),
  ('7d000000-0000-0000-0000-00000000000b', 'Book B', 'test-pack');
insert into public.contacts (id, tenant_id, phone)
  select ('7d100000-0000-0000-0000-0000000000a' || n)::uuid, '7d000000-0000-0000-0000-00000000000a', '+91980000040' || n
  from generate_series(1, 5) n;
insert into public.contacts (id, tenant_id, phone) values
  ('7d100000-0000-0000-0000-0000000000b1', '7d000000-0000-0000-0000-00000000000b', '+919800000499');
insert into public.leads (id, tenant_id, contact_id, stage)
  select ('7d200000-0000-0000-0000-0000000000a' || n)::uuid, '7d000000-0000-0000-0000-00000000000a',
         ('7d100000-0000-0000-0000-0000000000a' || n)::uuid, case n when 1 then 'qualified' when 2 then 'won' else 'new' end
  from generate_series(1, 5) n;
insert into public.leads (id, tenant_id, contact_id, stage) values
  ('7d200000-0000-0000-0000-0000000000b1', '7d000000-0000-0000-0000-00000000000b', '7d100000-0000-0000-0000-0000000000b1', 'new');
insert into public.resources (id, tenant_id, type, name) values
  ('7d300000-0000-0000-0000-0000000000a1', '7d000000-0000-0000-0000-00000000000a', 'staff', 'Staff 1'),
  ('7d300000-0000-0000-0000-0000000000a2', '7d000000-0000-0000-0000-00000000000a', 'staff', 'Staff 2'),
  ('7d300000-0000-0000-0000-0000000000a3', '7d000000-0000-0000-0000-00000000000a', 'designer', 'Designer'),
  ('7d300000-0000-0000-0000-0000000000b1', '7d000000-0000-0000-0000-00000000000b', 'staff', 'B Staff');
insert into public.services (id, tenant_id, name, duration_min, resource_type) values
  ('7d400000-0000-0000-0000-0000000000a1', '7d000000-0000-0000-0000-00000000000a', 'Site visit', 60, 'staff');

-- hold(lead n of business A, from, to, resource): a site visit with Staff 1 unless said otherwise.
create function pg_temp.lead(n int) returns uuid language sql immutable as $$
  select ('7d200000-0000-0000-0000-0000000000a' || n)::uuid
$$;
create function pg_temp.hold(p_lead uuid, p_from numeric, p_to numeric, p_resource uuid default '7d300000-0000-0000-0000-0000000000a1',
                             p_kind text default 'site_visit', p_service uuid default '7d400000-0000-0000-0000-0000000000a1')
returns public.bookings language sql as $$
  select public.hold_slot('7d000000-0000-0000-0000-00000000000a', p_lead, p_kind, pg_temp.at(p_from), pg_temp.at(p_to),
                          p_resource, p_service)
$$;

-- services: the new settings ---------------------------------------------------------------------------

select results_eq(
  $$select buffer_min, min_notice_min from public.services where id = '7d400000-0000-0000-0000-0000000000a1'$$,
  $$values (0, 60)$$, 'a service has no buffer and one hour of notice by default');
select throws_ok($$update public.services set buffer_min = -5 where id = '7d400000-0000-0000-0000-0000000000a1'$$,
  '23514', null, 'a buffer cannot be negative');

-- hold_slot -------------------------------------------------------------------------------------------

create temp table first_hold as select * from pg_temp.hold(pg_temp.lead(1), 0, 1);
select results_eq(
  $$select status, kind, hold_expires_at = now() + interval '10 minutes', start_at = pg_temp.at(0) from first_hold$$,
  $$values ('held'::text, 'site_visit'::text, true, true)$$, 'a hold lasts 10 minutes');

select throws_ok($$select pg_temp.hold(pg_temp.lead(2), 0, 1)$$,
  '23P01', null, 'the same time with the same person is refused by the database');
select throws_ok($$select pg_temp.hold(pg_temp.lead(2), 0.5, 1.5)$$,
  '23P01', null, 'an overlapping time is refused');
select lives_ok($$select pg_temp.hold(pg_temp.lead(2), 1, 2)$$,
  'a time that only touches another (ends when it starts) is fine');
select lives_ok($$select pg_temp.hold(pg_temp.lead(3), 0, 1, '7d300000-0000-0000-0000-0000000000a2')$$,
  'the same time with another person is fine');
select lives_ok(
  $$select pg_temp.hold(pg_temp.lead(4), 0, 1, null, 'callback', null);
    select pg_temp.hold(pg_temp.lead(5), 0, 1, null, 'callback', null)$$,
  'callbacks with no person never clash, with each other or with booked people');

select throws_ok($$select pg_temp.hold(pg_temp.lead(1), 3, 4, null)$$,
  'P0001', null, 'a site visit needs a person');
select throws_ok(
  $$select public.hold_slot('7d000000-0000-0000-0000-00000000000a', '7d200000-0000-0000-0000-0000000000b1', 'site_visit',
      pg_temp.at(3), pg_temp.at(4), '7d300000-0000-0000-0000-0000000000a1', '7d400000-0000-0000-0000-0000000000a1')$$,
  'PA404', null, 'a lead from another business is not_found');
select throws_ok($$select pg_temp.hold(pg_temp.lead(1), 3, 4, '7d300000-0000-0000-0000-0000000000b1')$$,
  'PA404', null, 'a person from another business is not_found');
select throws_ok($$select pg_temp.hold(pg_temp.lead(1), 3, 4, '7d300000-0000-0000-0000-0000000000a3')$$,
  'P0001', null, 'a person who does not do this service is refused');
select throws_ok(
  $$select public.hold_slot('7d000000-0000-0000-0000-00000000000a', pg_temp.lead(1), 'site_visit',
      now() - interval '1 hour', now(), '7d300000-0000-0000-0000-0000000000a1', '7d400000-0000-0000-0000-0000000000a1')$$,
  'P0001', null, 'a time in the past is refused');
select throws_ok($$select pg_temp.hold(pg_temp.lead(1), 4, 3)$$,
  'P0001', null, 'a booking must end after it starts');
select throws_ok($$select pg_temp.hold(pg_temp.lead(1), 3, 4, p_kind => 'party')$$,
  'P0001', null, 'an unknown booking kind is refused');

-- Lead 1 picks another time: its first hold is released.
create temp table second_hold as select * from pg_temp.hold(pg_temp.lead(1), 5, 6);
select results_eq(
  $$select status, details->>'cancel_reason' from public.bookings where id = (select id from first_hold)$$,
  $$values ('cancelled'::text, 'replaced'::text)$$, 'a lead holds one time at a time: a new hold releases the earlier one');

-- An expired hold that release-holds has not reached yet no longer blocks.
insert into public.bookings (id, tenant_id, lead_id, resource_id, service_id, kind, start_at, end_at, status, hold_expires_at) values
  ('7d500000-0000-0000-0000-0000000000e1', '7d000000-0000-0000-0000-00000000000a', pg_temp.lead(2),
   '7d300000-0000-0000-0000-0000000000a2', '7d400000-0000-0000-0000-0000000000a1', 'site_visit', pg_temp.at(8), pg_temp.at(9),
   'held', now() - interval '1 minute');
select lives_ok($$select pg_temp.hold(pg_temp.lead(3), 8, 9, '7d300000-0000-0000-0000-0000000000a2')$$,
  'an expired hold gives way to a new one');
select is((select status from public.bookings where id = '7d500000-0000-0000-0000-0000000000e1'), 'expired',
  'and is marked expired');

-- confirm_booking -------------------------------------------------------------------------------------

create temp table to_confirm as select * from pg_temp.hold(pg_temp.lead(4), 10, 11);
create temp table confirmed as
  select * from public.confirm_booking('7d000000-0000-0000-0000-00000000000a', (select id from to_confirm));
select results_eq('select status, hold_expires_at from confirmed',
  $$values ('confirmed'::text, null::timestamptz)$$, 'confirm turns a hold into a booking');
select is((select stage from public.leads where id = pg_temp.lead(4)), 'booked', 'and moves the lead to booked');
select is(
  (select status from public.confirm_booking('7d000000-0000-0000-0000-00000000000a', (select id from to_confirm))),
  'confirmed', 'a repeat confirm changes nothing');
select throws_ok(
  $$select public.confirm_booking('7d000000-0000-0000-0000-00000000000a', (select id from first_hold))$$,
  'PA409', null, 'a released hold cannot be confirmed');
select throws_ok(
  $$select public.confirm_booking('7d000000-0000-0000-0000-00000000000b', (select id from to_confirm))$$,
  'PA404', null, 'another business''s booking is not_found');

create temp table won_hold as select * from pg_temp.hold(pg_temp.lead(2), 12, 13, '7d300000-0000-0000-0000-0000000000a2');
select lives_ok($$select public.confirm_booking('7d000000-0000-0000-0000-00000000000a', (select id from won_hold))$$,
  'a lead further along can still book');
select is((select stage from public.leads where id = pg_temp.lead(2)), 'won', 'without moving its stage back');

-- reschedule_booking ----------------------------------------------------------------------------------

-- Move the 10–11 booking by half an hour: it overlaps its own old time, which is freed first.
create temp table moved as
  select * from public.reschedule_booking('7d000000-0000-0000-0000-00000000000a', (select id from to_confirm),
                                          pg_temp.at(10.5), pg_temp.at(11.5));
select results_eq(
  $$select status, start_at = pg_temp.at(10.5), (details->>'rescheduled_from')::uuid = (select id from to_confirm) from moved$$,
  $$values ('confirmed'::text, true, true)$$, 'a move confirms a new booking that points to the old one');
select is((select status from public.bookings where id = (select id from to_confirm)), 'rescheduled',
  'and marks the old one rescheduled');

-- Lead 1 still holds 5–6 with Staff 1.
select throws_ok(
  $$select public.reschedule_booking('7d000000-0000-0000-0000-00000000000a', (select id from moved), pg_temp.at(5), pg_temp.at(6))$$,
  '23P01', null, 'a move onto a taken time is refused');
select is((select status from public.bookings where id = (select id from moved)), 'confirmed',
  'and the booking stays where it was');
select throws_ok(
  $$select public.reschedule_booking('7d000000-0000-0000-0000-00000000000a', (select id from second_hold), pg_temp.at(20), pg_temp.at(21))$$,
  'PA409', null, 'only a confirmed booking can be moved');
select throws_ok(
  $$select public.reschedule_booking('7d000000-0000-0000-0000-00000000000a', (select id from moved), pg_temp.at(20), pg_temp.at(21),
                                     '7d300000-0000-0000-0000-0000000000a3')$$,
  'P0001', null, 'a move to someone who does not do the service is refused');

-- cancel_booking --------------------------------------------------------------------------------------

create temp table cancelled as
  select * from public.cancel_booking('7d000000-0000-0000-0000-00000000000a', (select id from moved), 'customer asked');
select results_eq($$select status, details->>'cancel_reason' from cancelled$$,
  $$values ('cancelled'::text, 'customer asked'::text)$$, 'cancel keeps the reason');
create temp table rehold as select * from pg_temp.hold(pg_temp.lead(5), 10.5, 11.5);
select is((select status from rehold), 'held', 'a cancelled booking frees its time');
select is(
  (select status from public.cancel_booking('7d000000-0000-0000-0000-00000000000a', (select id from moved))),
  'cancelled', 'a repeat cancel changes nothing');
select throws_ok(
  $$select public.cancel_booking('7d000000-0000-0000-0000-00000000000a', (select id from to_confirm))$$,
  'PA409', null, 'a booking that was moved cannot be cancelled');
select throws_ok(
  $$select public.cancel_booking('7d000000-0000-0000-0000-00000000000a', (select id from second_hold), repeat('x', 501))$$,
  'P0001', null, 'the reason is at most 500 characters');

-- release_expired_holds -------------------------------------------------------------------------------

update public.bookings set hold_expires_at = now() - interval '1 second' where id = (select id from second_hold);
select is(public.release_expired_holds(), 1, 'release-holds expires the holds past their time');
select results_eq(
  $$select (select status from public.bookings where id = (select id from second_hold)),
           (select status from public.bookings where id = (select id from rehold))$$,
  $$values ('expired'::text, 'held'::text)$$, 'and leaves live holds alone');
select is(public.release_expired_holds(), 0, 'a second run (a replay of the minute) expires nothing more');

-- Constraints and access --------------------------------------------------------------------------------

select throws_ok(
  $$insert into public.bookings (tenant_id, lead_id, kind, start_at, end_at, status)
    values ('7d000000-0000-0000-0000-00000000000a', pg_temp.lead(1), 'callback', pg_temp.at(30), pg_temp.at(30), 'held')$$,
  '23514', null, 'a booking must end after it starts, in the table too');
select throws_ok(
  $$insert into public.bookings (tenant_id, lead_id, kind, start_at, end_at, status)
    values ('7d000000-0000-0000-0000-00000000000a', pg_temp.lead(1), 'slot', pg_temp.at(30), pg_temp.at(31), 'held')$$,
  '23514', null, 'a slot booking needs a resource, in the table too');
select ok(
  not has_function_privilege('authenticated', 'public.hold_slot(uuid, uuid, text, timestamptz, timestamptz, uuid, uuid, jsonb, integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.confirm_booking(uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.reschedule_booking(uuid, uuid, timestamptz, timestamptz, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.cancel_booking(uuid, uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.release_expired_holds()', 'execute'),
  'members cannot call the booking functions directly');
select ok(
  has_function_privilege('service_role', 'public.hold_slot(uuid, uuid, text, timestamptz, timestamptz, uuid, uuid, jsonb, integer)', 'execute')
  and has_function_privilege('service_role', 'public.release_expired_holds()', 'execute'),
  'server code can');

select * from finish();
rollback;
