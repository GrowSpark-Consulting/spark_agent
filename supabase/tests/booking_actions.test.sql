-- The calendar's staff actions (0026): complete, no-show, cancel and reschedule, each with its audit row, plus
-- bookings.status_changed_at and Realtime for bookings and leads. Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

-- Fixtures, as the migration owner. Times are relative to the transaction's now(); bookings that already started
-- are inserted directly (hold_slot refuses past times).
insert into public.tenants (id, name, vertical) values ('ba000000-0000-0000-0000-000000000001', 'Actions', 'test-pack');
insert into public.contacts (id, tenant_id, phone) values
  ('ba100000-0000-0000-0000-000000000001', 'ba000000-0000-0000-0000-000000000001', '+919800000301'),
  ('ba100000-0000-0000-0000-000000000002', 'ba000000-0000-0000-0000-000000000001', '+919800000302');
insert into public.leads (id, tenant_id, contact_id, stage) values
  ('ba200000-0000-0000-0000-000000000001', 'ba000000-0000-0000-0000-000000000001', 'ba100000-0000-0000-0000-000000000001', 'booked'),
  ('ba200000-0000-0000-0000-000000000002', 'ba000000-0000-0000-0000-000000000001', 'ba100000-0000-0000-0000-000000000002', 'won');
insert into public.resources (id, tenant_id, type, name) values
  ('ba300000-0000-0000-0000-000000000001', 'ba000000-0000-0000-0000-000000000001', 'staff', 'Asha');
insert into public.services (id, tenant_id, name, duration_min, resource_type) values
  ('ba400000-0000-0000-0000-000000000001', 'ba000000-0000-0000-0000-000000000001', 'Site visit', 60, 'staff');
insert into public.bookings (id, tenant_id, lead_id, resource_id, service_id, kind, start_at, end_at, status) values
  -- started an hour ago
  ('ba500000-0000-0000-0000-000000000001', 'ba000000-0000-0000-0000-000000000001', 'ba200000-0000-0000-0000-000000000001',
   'ba300000-0000-0000-0000-000000000001', 'ba400000-0000-0000-0000-000000000001', 'site_visit', now() - interval '1 hour', now(), 'confirmed'),
  -- tomorrow
  ('ba500000-0000-0000-0000-000000000002', 'ba000000-0000-0000-0000-000000000001', 'ba200000-0000-0000-0000-000000000001',
   'ba300000-0000-0000-0000-000000000001', 'ba400000-0000-0000-0000-000000000001', 'site_visit', now() + interval '1 day', now() + interval '1 day 1 hour', 'confirmed'),
  -- yesterday, for the no-show
  ('ba500000-0000-0000-0000-000000000003', 'ba000000-0000-0000-0000-000000000001', 'ba200000-0000-0000-0000-000000000001',
   'ba300000-0000-0000-0000-000000000001', 'ba400000-0000-0000-0000-000000000001', 'site_visit', now() - interval '1 day', now() - interval '23 hours', 'confirmed'),
  -- two days ago, a lead that is already won
  ('ba500000-0000-0000-0000-000000000004', 'ba000000-0000-0000-0000-000000000001', 'ba200000-0000-0000-0000-000000000002',
   'ba300000-0000-0000-0000-000000000001', 'ba400000-0000-0000-0000-000000000001', 'site_visit', now() - interval '2 days', now() - interval '47 hours', 'confirmed'),
  -- next week, to cancel and to move
  ('ba500000-0000-0000-0000-000000000005', 'ba000000-0000-0000-0000-000000000001', 'ba200000-0000-0000-0000-000000000001',
   'ba300000-0000-0000-0000-000000000001', 'ba400000-0000-0000-0000-000000000001', 'site_visit', now() + interval '7 days', now() + interval '7 days 1 hour', 'confirmed'),
  ('ba500000-0000-0000-0000-000000000006', 'ba000000-0000-0000-0000-000000000001', 'ba200000-0000-0000-0000-000000000001',
   'ba300000-0000-0000-0000-000000000001', 'ba400000-0000-0000-0000-000000000001', 'site_visit', now() + interval '8 days', now() + interval '8 days 1 hour', 'confirmed');

-- An older status time, to see the trigger move it (inside one transaction now() does not change).
update public.bookings set status_changed_at = now() - interval '3 days' where id = 'ba500000-0000-0000-0000-000000000005';

-- Only the server -----------------------------------------------------------------------------------------------

set local role authenticated;
select throws_ok($$select public.complete_booking('ba000000-0000-0000-0000-000000000001', 'ba500000-0000-0000-0000-000000000001', 'x')$$,
  '42501', null, 'a signed-in user cannot call complete_booking (server only)');
reset role;

-- complete ------------------------------------------------------------------------------------------------------

select throws_ok($$select public.complete_booking('ba000000-0000-0000-0000-000000000001', 'ba500000-0000-0000-0000-000000000002', 'e1000000-0000-0000-0000-00000000000a')$$,
  'PA409', 'complete_booking: this booking has not started yet', 'a booking that has not started cannot be marked visited');
select is((public.complete_booking('ba000000-0000-0000-0000-000000000001', 'ba500000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-00000000000a')).status,
  'completed', 'a confirmed booking that has started is marked visited');
select is((select details ->> 'completed_by' from public.bookings where id = 'ba500000-0000-0000-0000-000000000001'),
  'e1000000-0000-0000-0000-00000000000a', 'and who did it is kept');
select is((select stage from public.leads where id = 'ba200000-0000-0000-0000-000000000001'), 'visited', 'its lead moves to visited');
select is((select count(*)::int from public.audit_logs where entity_id = 'ba500000-0000-0000-0000-000000000001' and action = 'booking.completed'
            and actor = 'e1000000-0000-0000-0000-00000000000a'), 1, 'the change is audited with who made it');
select is((public.complete_booking('ba000000-0000-0000-0000-000000000001', 'ba500000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-00000000000a')).status,
  'completed', 'marking it visited again is harmless');
select is((select count(*)::int from public.audit_logs where entity_id = 'ba500000-0000-0000-0000-000000000001'), 1, 'and writes no second audit row');
select public.complete_booking('ba000000-0000-0000-0000-000000000001', 'ba500000-0000-0000-0000-000000000004', 'e1000000-0000-0000-0000-00000000000a');
select is((select stage from public.leads where id = 'ba200000-0000-0000-0000-000000000002'), 'won', 'a won lead stays won');

-- no-show -------------------------------------------------------------------------------------------------------

select is((public.mark_booking_no_show('ba000000-0000-0000-0000-000000000001', 'ba500000-0000-0000-0000-000000000003', 'e1000000-0000-0000-0000-00000000000a')).status,
  'no_show', 'a confirmed booking that has started is marked no-show');
select results_eq($$select details ->> 'no_show_by', (select action from public.audit_logs where entity_id = b.id) from public.bookings b
                    where b.id = 'ba500000-0000-0000-0000-000000000003'$$,
  $$values ('e1000000-0000-0000-0000-00000000000a', 'booking.no_show')$$, 'with who did it, and audited');
select throws_ok($$select public.mark_booking_no_show('ba000000-0000-0000-0000-000000000001', 'ba500000-0000-0000-0000-000000000001', 'x')$$,
  'PA409', 'mark_booking_no_show: a completed booking cannot be marked no-show', 'a visited booking cannot be marked no-show');

-- cancel --------------------------------------------------------------------------------------------------------

select is((public.staff_cancel_booking('ba000000-0000-0000-0000-000000000001', 'ba500000-0000-0000-0000-000000000005', 'Customer called', 'e1000000-0000-0000-0000-00000000000a')).status,
  'cancelled', 'staff cancel a confirmed booking');
select results_eq($$select details ->> 'cancelled_by', details ->> 'cancel_reason', status_changed_at = now() from public.bookings
                    where id = 'ba500000-0000-0000-0000-000000000005'$$,
  $$values ('e1000000-0000-0000-0000-00000000000a', 'Customer called', true)$$, 'with who did it, why, and when the status changed');
select results_eq($$select diff from public.audit_logs where entity_id = 'ba500000-0000-0000-0000-000000000005'$$,
  $$values ('{"from": "confirmed", "to": "cancelled", "reason": "Customer called"}'::jsonb)$$, 'the cancel is audited');
select public.staff_cancel_booking('ba000000-0000-0000-0000-000000000001', 'ba500000-0000-0000-0000-000000000005', 'Again', 'e1000000-0000-0000-0000-00000000000a');
select is((select count(*)::int from public.audit_logs where entity_id = 'ba500000-0000-0000-0000-000000000005'), 1, 'cancelling again writes nothing');
select throws_ok($$select public.staff_cancel_booking('ba000000-0000-0000-0000-000000000001', 'ba500000-0000-0000-0000-0000000000ff', null, 'x')$$,
  'PA404', null, 'an unknown booking is not_found');

-- reschedule ----------------------------------------------------------------------------------------------------

select results_eq(
  $$select status, details ->> 'rescheduled_by', details ->> 'rescheduled_from'
      from public.staff_reschedule_booking('ba000000-0000-0000-0000-000000000001', 'ba500000-0000-0000-0000-000000000006',
             date_trunc('hour', now()) + interval '9 days', date_trunc('hour', now()) + interval '9 days 1 hour', null, 'e1000000-0000-0000-0000-00000000000a')$$,
  $$values ('confirmed'::text, 'e1000000-0000-0000-0000-00000000000a', 'ba500000-0000-0000-0000-000000000006')$$,
  'staff move a booking: a new confirmed booking, with who moved it and where from');
select is((select action from public.audit_logs where entity_id = 'ba500000-0000-0000-0000-000000000006'), 'booking.rescheduled', 'the move is audited on the old booking');

-- Realtime --------------------------------------------------------------------------------------------------------

select is((select array_agg(tablename::text order by tablename) from pg_publication_tables
            where pubname = 'supabase_realtime' and tablename in ('bookings', 'leads')),
  array['bookings', 'leads'], 'bookings and leads are in the Realtime publication');

select * from finish();
rollback;
