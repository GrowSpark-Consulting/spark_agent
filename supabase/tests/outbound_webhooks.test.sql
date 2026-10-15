-- Outbound webhooks (0050): the outbox trigger, the endpoint functions and the job's claim and record. Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(46);

-- Two businesses: W has an endpoint (once saved below), N never has one.
insert into auth.users (id, email) values
  ('0f000000-0000-0000-0000-0000000000a1', 'owner@hooks.test'),
  ('0f000000-0000-0000-0000-0000000000a2', 'staff@hooks.test');
insert into public.tenants (id, name, vertical) values
  ('0f100000-0000-0000-0000-00000000000a', 'Hooks W', 'test-pack'),
  ('0f100000-0000-0000-0000-00000000000b', 'Hooks N', 'test-pack');
insert into public.memberships (tenant_id, user_id, role) values
  ('0f100000-0000-0000-0000-00000000000a', '0f000000-0000-0000-0000-0000000000a1', 'owner'),
  ('0f100000-0000-0000-0000-00000000000a', '0f000000-0000-0000-0000-0000000000a2', 'staff');
insert into public.channels (id, tenant_id, type) values ('0f200000-0000-0000-0000-00000000000a', '0f100000-0000-0000-0000-00000000000a', 'whatsapp');
insert into public.contacts (id, tenant_id, phone) values
  ('0f300000-0000-0000-0000-00000000000a', '0f100000-0000-0000-0000-00000000000a', '+919800000801'),
  ('0f300000-0000-0000-0000-00000000000b', '0f100000-0000-0000-0000-00000000000b', '+919800000802');
insert into public.conversations (id, tenant_id, contact_id, channel_id) values
  ('0f400000-0000-0000-0000-00000000000a', '0f100000-0000-0000-0000-00000000000a', '0f300000-0000-0000-0000-00000000000a', '0f200000-0000-0000-0000-00000000000a');
insert into public.resources (id, tenant_id, type, name) values ('0f500000-0000-0000-0000-00000000000a', '0f100000-0000-0000-0000-00000000000a', 'staff', 'Asha');

create function pg_temp.queued(p_tenant uuid) returns text[] language sql as $$
  select coalesce(array_agg(event || ':' || entity_id order by event, entity_id), '{}') from public.webhook_deliveries where tenant_id = p_tenant;
$$;
create function pg_temp.events(p_entity uuid) returns text[] language sql as $$
  select coalesce(array_agg(event order by event), '{}') from public.webhook_deliveries where entity_id = p_entity;
$$;

-- Server only ------------------------------------------------------------------------------------------------------------
select ok(not has_table_privilege('authenticated', 'public.webhook_endpoints', 'select')
          and not has_table_privilege('anon', 'public.webhook_endpoints', 'select')
          and not has_table_privilege('authenticated', 'public.webhook_deliveries', 'select'),
  'the browser cannot read endpoints (their secrets) or deliveries');
select ok(not has_function_privilege('authenticated', 'public.save_webhook_endpoint(uuid, text, text[], text, text, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.claim_webhook_deliveries(text, int, timestamptz)', 'execute')
          and not has_function_privilege('authenticated', 'public.record_webhook_attempt(uuid, text, text, int, text, timestamptz)', 'execute')
          and not has_function_privilege('anon', 'public.delete_webhook_endpoint(uuid, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.queue_webhook_events()', 'execute'),
  'and calls none of the functions');

-- No endpoint, no events --------------------------------------------------------------------------------------------------
insert into public.leads (id, tenant_id, contact_id) values ('0f600000-0000-0000-0000-0000000000b1', '0f100000-0000-0000-0000-00000000000b', '0f300000-0000-0000-0000-00000000000b');
select is((select count(*)::int from public.webhook_deliveries), 0, 'a business with no endpoint queues nothing');

-- The endpoint --------------------------------------------------------------------------------------------------------------
select is((select created from public.save_webhook_endpoint('0f100000-0000-0000-0000-00000000000a', 'https://hooks.zapier.com/hooks/catch/123/s3cr3tpath/',
           array['lead.created', 'lead.qualified', 'booking.confirmed', 'booking.cancelled', 'handoff.opened'], 'v1:first', 'AAAA', '0f000000-0000-0000-0000-0000000000a1')),
  true, 'saving the first endpoint creates it');
select results_eq($$select actor, action, diff from public.audit_logs where tenant_id = '0f100000-0000-0000-0000-00000000000a' order by id desc limit 1$$,
  $$values ('0f000000-0000-0000-0000-0000000000a1'::text, 'webhook_endpoint.created'::text,
            '{"host": "hooks.zapier.com", "events": ["lead.created", "lead.qualified", "booking.confirmed", "booking.cancelled", "handoff.opened"]}'::jsonb)$$,
  'audited with the owner, the host and the events: never the path (it can hold the receiver''s key)');
select ok((select diff::text not like '%s3cr3tpath%' from public.audit_logs where action = 'webhook_endpoint.created'), 'the path is not in the audit');

-- Leads ---------------------------------------------------------------------------------------------------------------------
insert into public.leads (id, tenant_id, contact_id) values ('0f600000-0000-0000-0000-0000000000a1', '0f100000-0000-0000-0000-00000000000a', '0f300000-0000-0000-0000-00000000000a');
select is(pg_temp.events('0f600000-0000-0000-0000-0000000000a1'), array['lead.created'], 'a new lead queues lead.created');
update public.leads set stage = 'engaged' where id = '0f600000-0000-0000-0000-0000000000a1';
select is(pg_temp.events('0f600000-0000-0000-0000-0000000000a1'), array['lead.created'], 'another stage queues nothing');
update public.leads set stage = 'qualified' where id = '0f600000-0000-0000-0000-0000000000a1';
select is(pg_temp.events('0f600000-0000-0000-0000-0000000000a1'), array['lead.created', 'lead.qualified'], 'reaching qualified queues lead.qualified');
update public.leads set stage = 'engaged' where id = '0f600000-0000-0000-0000-0000000000a1';
update public.leads set stage = 'qualified' where id = '0f600000-0000-0000-0000-0000000000a1';
select is((select count(*)::int from public.webhook_deliveries where entity_id = '0f600000-0000-0000-0000-0000000000a1'), 2, 'qualified again: one event per lead');
insert into public.leads (id, tenant_id, contact_id, stage) values ('0f600000-0000-0000-0000-0000000000a2', '0f100000-0000-0000-0000-00000000000a', '0f300000-0000-0000-0000-00000000000a', 'qualified');
select is(pg_temp.events('0f600000-0000-0000-0000-0000000000a2'), array['lead.created', 'lead.qualified'], 'a lead that starts qualified queues both');

insert into public.leads (id, tenant_id, contact_id, owner_user_id) values
  ('0f600000-0000-0000-0000-0000000000a3', '0f100000-0000-0000-0000-00000000000a', '0f300000-0000-0000-0000-00000000000a', '0f000000-0000-0000-0000-0000000000a2');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "0f000000-0000-0000-0000-0000000000a2", "role": "authenticated"}', true);
update public.leads set stage = 'qualified' where id = '0f600000-0000-0000-0000-0000000000a3';
reset role;
select is(pg_temp.events('0f600000-0000-0000-0000-0000000000a3'), array['lead.created', 'lead.qualified'], 'staff qualifying their lead from the dashboard queues it too');

-- Bookings ------------------------------------------------------------------------------------------------------------------
insert into public.bookings (id, tenant_id, lead_id, resource_id, kind, start_at, end_at, status, hold_expires_at) values
  ('0f700000-0000-0000-0000-0000000000a1', '0f100000-0000-0000-0000-00000000000a', '0f600000-0000-0000-0000-0000000000a1', '0f500000-0000-0000-0000-00000000000a', 'slot',
   date_trunc('hour', now()) + interval '2 days', date_trunc('hour', now()) + interval '2 days 1 hour', 'held', now() + interval '10 minutes'),
  ('0f700000-0000-0000-0000-0000000000a2', '0f100000-0000-0000-0000-00000000000a', '0f600000-0000-0000-0000-0000000000a1', '0f500000-0000-0000-0000-00000000000a', 'slot',
   date_trunc('hour', now()) + interval '3 days', date_trunc('hour', now()) + interval '3 days 1 hour', 'held', now() + interval '10 minutes');
select is(pg_temp.events('0f700000-0000-0000-0000-0000000000a1'), '{}'::text[], 'a hold is not a booking yet');
update public.bookings set status = 'confirmed', hold_expires_at = null where id = '0f700000-0000-0000-0000-0000000000a1';
select is(pg_temp.events('0f700000-0000-0000-0000-0000000000a1'), array['booking.confirmed'], 'confirming queues booking.confirmed');
update public.bookings set status = 'cancelled' where id = '0f700000-0000-0000-0000-0000000000a1';
select is(pg_temp.events('0f700000-0000-0000-0000-0000000000a1'), array['booking.cancelled', 'booking.confirmed'], 'cancelling a confirmed booking queues booking.cancelled');
update public.bookings set status = 'expired' where id = '0f700000-0000-0000-0000-0000000000a2';
select is(pg_temp.events('0f700000-0000-0000-0000-0000000000a2'), '{}'::text[], 'a hold that lapsed queues nothing');

-- Handoffs --------------------------------------------------------------------------------------------------------------------
insert into public.handoffs (id, tenant_id, conversation_id, trigger, priority) values
  ('0f800000-0000-0000-0000-0000000000a1', '0f100000-0000-0000-0000-00000000000a', '0f400000-0000-0000-0000-00000000000a', 'asked_human', 'normal');
select is(pg_temp.events('0f800000-0000-0000-0000-0000000000a1'), array['handoff.opened'], 'a new handoff queues handoff.opened');

-- Changing the endpoint ---------------------------------------------------------------------------------------------------------
select is((select created from public.save_webhook_endpoint('0f100000-0000-0000-0000-00000000000a', 'https://crm.example.in/in',
           array['booking.confirmed'], 'v1:ignored', 'BBBB', '0f000000-0000-0000-0000-0000000000a1')),
  false, 'saving again changes the endpoint');
select results_eq($$select secret_enc, secret_hint, url from public.webhook_endpoints where tenant_id = '0f100000-0000-0000-0000-00000000000a'$$,
  $$values ('v1:first'::text, 'AAAA'::text, 'https://crm.example.in/in'::text)$$, 'the secret stays; the URL changes');
select is((select diff from public.audit_logs where tenant_id = '0f100000-0000-0000-0000-00000000000a' order by id desc limit 1),
  '{"host": "crm.example.in", "events": ["booking.confirmed"], "url_changed": true}'::jsonb, 'audited as updated, saying the URL changed');
insert into public.leads (id, tenant_id, contact_id) values ('0f600000-0000-0000-0000-0000000000a4', '0f100000-0000-0000-0000-00000000000a', '0f300000-0000-0000-0000-00000000000a');
select is(pg_temp.events('0f600000-0000-0000-0000-0000000000a4'), '{}'::text[], 'an event the endpoint does not want is not queued');
update public.webhook_endpoints set active = false where tenant_id = '0f100000-0000-0000-0000-00000000000a';
update public.bookings set status = 'confirmed' where id = '0f700000-0000-0000-0000-0000000000a2';
select is(pg_temp.events('0f700000-0000-0000-0000-0000000000a2'), '{}'::text[], 'a switched-off endpoint gets nothing');
update public.webhook_endpoints set active = true where tenant_id = '0f100000-0000-0000-0000-00000000000a';

select is(public.rotate_webhook_secret('0f100000-0000-0000-0000-00000000000a', 'v1:second', 'CCCC', '0f000000-0000-0000-0000-0000000000a1'), true, 'rotating the secret');
select results_eq($$select secret_enc, secret_hint from public.webhook_endpoints where tenant_id = '0f100000-0000-0000-0000-00000000000a'$$,
  $$values ('v1:second'::text, 'CCCC'::text)$$, 'replaces it');
select is((select action from public.audit_logs where tenant_id = '0f100000-0000-0000-0000-00000000000a' order by id desc limit 1), 'webhook_endpoint.secret_rotated', 'and is audited');
select is(public.rotate_webhook_secret('0f100000-0000-0000-0000-00000000000b', 'v1:x', 'DDDD', '0f000000-0000-0000-0000-0000000000a1'), false, 'no endpoint, nothing to rotate');

-- The job: claim ----------------------------------------------------------------------------------------------------------------
select is((select count(*)::int from public.claim_webhook_deliveries('run-1', 3)), 3, 'a run claims due deliveries, up to its limit');
select is((select count(*)::int from public.claim_webhook_deliveries('run-2', 50)), 6, 'another run gets only the rest');
select is((select count(*)::int from public.claim_webhook_deliveries('run-3', 50)), 0, 'and nothing is handed out twice');
select is((select count(*)::int from public.claim_webhook_deliveries('run-4', 50, now() + interval '6 minutes')), 9, 'a claim a run did not finish in 5 minutes is taken over');
select throws_ok($$select * from public.claim_webhook_deliveries('  ')$$, '22023', null, 'a run id is required');

-- The job: record ---------------------------------------------------------------------------------------------------------------
create temp table d as select id, row_number() over (order by occurred_at, event) as n from public.webhook_deliveries where tenant_id = '0f100000-0000-0000-0000-00000000000a';
select is(public.record_webhook_attempt((select id from d where n = 1), 'run-1', 'delivered', 200), null, 'a run that lost its claim records nothing');
select is(public.record_webhook_attempt((select id from d where n = 1), 'run-4', 'delivered', 200), 'delivered', 'the run holding the claim records the delivery');
select ok((select last_success_at is not null from public.webhook_endpoints where tenant_id = '0f100000-0000-0000-0000-00000000000a'), 'the endpoint shows its last success');
select is(public.record_webhook_attempt((select id from d where n = 1), 'run-4', 'delivered', 200), null, 'recording it again changes nothing');

select is(public.record_webhook_attempt((select id from d where n = 2), 'run-4', 'failed', 500, 'http_500'), 'pending', 'a failure is tried again');
select results_eq($$select attempts, next_attempt_at > now() + interval '59 seconds' and next_attempt_at < now() + interval '61 seconds', claimed_by is null
                    from public.webhook_deliveries where id = (select id from d where n = 2)$$,
  $$values (1, true, true)$$, 'a minute later, unclaimed');
select is((select last_failure from public.webhook_endpoints where tenant_id = '0f100000-0000-0000-0000-00000000000a'), 'http_500', 'and the endpoint shows why');
update public.webhook_deliveries set attempts = 7, claimed_by = 'run-5' where id = (select id from d where n = 2);
select is(public.record_webhook_attempt((select id from d where n = 2), 'run-5', 'failed', null, 'timeout'), 'failed', 'the 8th failure gives up');
select is(public.record_webhook_attempt((select id from d where n = 3), 'run-4', 'dropped', null, 'gone'), 'dropped', 'a record that is gone is dropped');
select throws_ok($$select public.record_webhook_attempt(gen_random_uuid(), 'run-4', 'sent')$$, '22023', null, 'an unknown outcome is refused');

-- Pruning and deleting --------------------------------------------------------------------------------------------------------
update public.webhook_deliveries set occurred_at = now() - interval '31 days' where id = (select id from d where n = 1);
select ok((select count(*) >= 0 from public.claim_webhook_deliveries('run-6', 1)), 'a run claims as usual');
select is((select count(*)::int from public.webhook_deliveries where id = (select id from d where n = 1)), 0, 'a delivery done over 30 days ago is removed');

select is(public.delete_webhook_endpoint('0f100000-0000-0000-0000-00000000000a', '0f000000-0000-0000-0000-0000000000a1'), true, 'deleting the endpoint');
select is((select count(*)::int from public.webhook_deliveries where tenant_id = '0f100000-0000-0000-0000-00000000000a'), 0, 'takes everything queued for it');

-- A webhook never costs a lead: with the outbox broken, the lead is still saved (and the event is lost, with a warning).
insert into public.webhook_endpoints (tenant_id, url, events, secret_enc, secret_hint)
  values ('0f100000-0000-0000-0000-00000000000a', 'https://crm.example.in/in', array['lead.created'], 'v1:x', 'EEEE');
alter table public.webhook_deliveries add constraint broken_for_the_test check (false) not valid;
insert into public.leads (id, tenant_id, contact_id) values ('0f600000-0000-0000-0000-0000000000a9', '0f100000-0000-0000-0000-00000000000a', '0f300000-0000-0000-0000-00000000000a');
select results_eq($$select (select count(*)::int from public.leads where id = '0f600000-0000-0000-0000-0000000000a9'),
                           (select count(*)::int from public.webhook_deliveries where entity_id = '0f600000-0000-0000-0000-0000000000a9')$$,
  $$values (1, 0)$$, 'a failure in the outbox never fails the write that fired it');

select * from finish();
rollback;
