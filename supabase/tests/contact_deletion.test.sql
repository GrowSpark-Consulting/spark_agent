-- A customer's request to delete their data (0043). Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(22);

insert into public.tenants (id, name, vertical) values
  ('0f000000-0000-0000-0000-00000000000a', 'Deletes A', 'test-pack'),
  ('0f000000-0000-0000-0000-00000000000b', 'Other B', 'test-pack');
insert into public.contacts (id, tenant_id, phone, name, language, tags) values
  ('0f100000-0000-0000-0000-0000000000a1', '0f000000-0000-0000-0000-00000000000a', '+919800000201', 'Ravi', 'ta', array['vip']),
  ('0f100000-0000-0000-0000-0000000000a2', '0f000000-0000-0000-0000-00000000000a', '+919800000202', 'Booked ahead', 'en', '{}'),
  ('0f100000-0000-0000-0000-0000000000a3', '0f000000-0000-0000-0000-00000000000a', '+919800000203', 'Stays', 'en', '{}'),
  ('0f100000-0000-0000-0000-0000000000b1', '0f000000-0000-0000-0000-00000000000b', '+919800000201', 'Ravi at B', 'ta', '{}');
insert into public.channels (id, tenant_id, type) values
  ('0f200000-0000-0000-0000-00000000000a', '0f000000-0000-0000-0000-00000000000a', 'whatsapp');
insert into public.conversations (id, tenant_id, contact_id, channel_id) values
  ('0f300000-0000-0000-0000-0000000000a1', '0f000000-0000-0000-0000-00000000000a', '0f100000-0000-0000-0000-0000000000a1', '0f200000-0000-0000-0000-00000000000a'),
  ('0f300000-0000-0000-0000-0000000000a3', '0f000000-0000-0000-0000-00000000000a', '0f100000-0000-0000-0000-0000000000a3', '0f200000-0000-0000-0000-00000000000a');
insert into public.messages (tenant_id, conversation_id, direction, sender, body) values
  ('0f000000-0000-0000-0000-00000000000a', '0f300000-0000-0000-0000-0000000000a1', 'in', 'customer', 'My address is 12 Gandhi St'),
  ('0f000000-0000-0000-0000-00000000000a', '0f300000-0000-0000-0000-0000000000a1', 'out', 'ai', 'Thanks Ravi'),
  ('0f000000-0000-0000-0000-00000000000a', '0f300000-0000-0000-0000-0000000000a3', 'in', 'customer', 'Hello');
insert into public.handoffs (tenant_id, conversation_id, trigger, priority) values
  ('0f000000-0000-0000-0000-00000000000a', '0f300000-0000-0000-0000-0000000000a1', 'asked_human', 'high');
insert into public.leads (id, tenant_id, contact_id, stage, fields) values
  ('0f400000-0000-0000-0000-0000000000a1', '0f000000-0000-0000-0000-00000000000a', '0f100000-0000-0000-0000-0000000000a1', 'booked', '{"budget": "80L"}'),
  ('0f400000-0000-0000-0000-0000000000a2', '0f000000-0000-0000-0000-00000000000a', '0f100000-0000-0000-0000-0000000000a2', 'booked', '{}');
insert into public.resources (id, tenant_id, type, name) values
  ('0f500000-0000-0000-0000-00000000000a', '0f000000-0000-0000-0000-00000000000a', 'staff', 'Staff');
insert into public.bookings (tenant_id, lead_id, resource_id, kind, start_at, end_at, status, calendar_event_id) values
  ('0f000000-0000-0000-0000-00000000000a', '0f400000-0000-0000-0000-0000000000a1', '0f500000-0000-0000-0000-00000000000a', 'site_visit',
   now() - interval '3 days', now() - interval '3 days' + interval '1 hour', 'completed', 'pakkaevent1'),
  ('0f000000-0000-0000-0000-00000000000a', '0f400000-0000-0000-0000-0000000000a1', '0f500000-0000-0000-0000-00000000000a', 'site_visit',
   now() + interval '2 days', now() + interval '2 days 1 hour', 'cancelled', null),
  ('0f000000-0000-0000-0000-00000000000a', '0f400000-0000-0000-0000-0000000000a2', '0f500000-0000-0000-0000-00000000000a', 'site_visit',
   now() + interval '1 day', now() + interval '1 day 1 hour', 'confirmed', 'pakkaevent2');
insert into public.kb_gaps (tenant_id, question, question_norm, last_contact_id) values
  ('0f000000-0000-0000-0000-00000000000a', 'Is there parking?', 'is there parking', '0f100000-0000-0000-0000-0000000000a1');

-- What it would remove ----------------------------------------------------------------------------------------------------
select results_eq($$select deleted_at, conversations, messages, leads, bookings, upcoming_bookings
                    from public.contact_deletion_preview('0f000000-0000-0000-0000-00000000000a', '0f100000-0000-0000-0000-0000000000a1')$$,
  $$values (null::timestamptz, 1, 2, 1, 2, 0)$$, 'the preview counts the chats, messages, leads and bookings');
select is((select count(*)::int from public.contact_deletion_preview('0f000000-0000-0000-0000-00000000000a', '0f100000-0000-0000-0000-0000000000b1')), 0,
  'another business''s contact has no preview here');

-- Refused while a booking is coming up --------------------------------------------------------------------------------
select throws_ok($$select * from public.delete_contact_data('0f000000-0000-0000-0000-00000000000a', '0f100000-0000-0000-0000-0000000000a2', 'u-1')$$,
  'PA409', null, 'a contact with an upcoming confirmed booking is not deleted: cancel it first');
select is((select phone from public.contacts where id = '0f100000-0000-0000-0000-0000000000a2'), '+919800000202', 'and nothing about it changed');
select throws_ok($$select * from public.delete_contact_data('0f000000-0000-0000-0000-00000000000a', '0f100000-0000-0000-0000-0000000000b1', 'u-1')$$,
  'PA404', null, 'a business cannot delete another business''s contact');

-- The deletion ----------------------------------------------------------------------------------------------------------
select results_eq($$select outcome, conversations, messages, leads, bookings, calendar_events
                    from public.delete_contact_data('0f000000-0000-0000-0000-00000000000a', '0f100000-0000-0000-0000-0000000000a1', 'u-1')$$,
  $$values ('deleted'::text, 1, 2, 1, 2, '[{"event_id": "pakkaevent1", "resource_id": "0f500000-0000-0000-0000-00000000000a"}]'::jsonb)$$,
  'it removes the data and names the Google Calendar event to take down');
select is((select count(*)::int from public.conversations where contact_id = '0f100000-0000-0000-0000-0000000000a1'), 0, 'its chats are gone');
select is((select count(*)::int from public.messages where conversation_id = '0f300000-0000-0000-0000-0000000000a1'), 0, 'with their messages');
select is((select count(*)::int from public.handoffs where conversation_id = '0f300000-0000-0000-0000-0000000000a1'), 0, 'and handoffs');
select is((select count(*)::int from public.leads where contact_id = '0f100000-0000-0000-0000-0000000000a1'), 0, 'its lead is gone');
select is((select count(*)::int from public.bookings where lead_id = '0f400000-0000-0000-0000-0000000000a1'), 0, 'with its bookings');
select results_eq($$select phone, name, language, tags, deleted_at is not null from public.contacts where id = '0f100000-0000-0000-0000-0000000000a1'$$,
  $$values ('deleted:0f100000-0000-0000-0000-0000000000a1'::text, null::text, null::text, '{}'::text[], true)$$,
  'the contact row stays, with nothing that identifies the person');
select results_eq($$select event, source from public.consent_logs where contact_id = '0f100000-0000-0000-0000-0000000000a1' order by id$$,
  $$values ('deletion_requested'::text, 'dashboard'::text), ('deleted', 'dashboard')$$, 'consent_logs records the request and the deletion');
select results_eq($$select actor, diff from public.audit_logs where action = 'contact.deleted' and entity_id = '0f100000-0000-0000-0000-0000000000a1'$$,
  $$values ('u-1'::text, '{"conversations": 1, "messages": 2, "leads": 1, "bookings": 2}'::jsonb)$$, 'the audit names the member, with counts only');
select is((select last_contact_id from public.kb_gaps where question = 'Is there parking?'), null, 'the knowledge-base gap forgets who asked');
select is((select count(*)::int from public.messages where conversation_id = '0f300000-0000-0000-0000-0000000000a3'), 1, 'another customer''s chat is untouched');
select is((select name from public.contacts where id = '0f100000-0000-0000-0000-0000000000b1'), 'Ravi at B', 'and so is the same number at another business');

-- Again, and afterwards -------------------------------------------------------------------------------------------------
select results_eq($$select outcome from public.delete_contact_data('0f000000-0000-0000-0000-00000000000a', '0f100000-0000-0000-0000-0000000000a1', 'u-1')$$,
  $$values ('already_deleted'::text)$$, 'asking again changes nothing');
select is((select count(*)::int from public.consent_logs where contact_id = '0f100000-0000-0000-0000-0000000000a1'), 2, 'and logs nothing more');
select lives_ok($$insert into public.contacts (tenant_id, phone) values ('0f000000-0000-0000-0000-00000000000a', '+919800000201')$$,
  'the same number writing again later is a new contact');

select ok(not has_function_privilege('authenticated', 'public.delete_contact_data(uuid, uuid, text)', 'execute')
          and not has_function_privilege('anon', 'public.delete_contact_data(uuid, uuid, text)', 'execute'), 'the browser cannot delete');
select ok(not has_function_privilege('authenticated', 'public.contact_deletion_preview(uuid, uuid)', 'execute'), 'or preview: the server checks the role first');

select * from finish();
rollback;
