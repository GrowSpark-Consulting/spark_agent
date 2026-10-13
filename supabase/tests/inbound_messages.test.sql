-- Inbound WhatsApp messages (0013): store_inbound_message, apply_message_status, the one-open-conversation
-- index and the new messages columns. Run: pnpm db:test
-- Concurrency (two messages for a new contact at the same time) cannot be shown in one transaction; it
-- is checked by hand with two sessions and relies on conversations_one_open_idx.
begin;
create extension if not exists pgtap with schema extensions;
select plan(68);

insert into public.tenants (id, name, vertical) values
  ('d0000000-0000-0000-0000-00000000000a', 'Inbound A', 'test-pack'),
  ('d0000000-0000-0000-0000-00000000000b', 'Inbound B', 'test-pack');
insert into public.channels (id, tenant_id, type) values
  ('d2000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-00000000000a', 'whatsapp'),
  ('d2000000-0000-0000-0000-00000000000b', 'd0000000-0000-0000-0000-00000000000b', 'whatsapp');

create function pg_temp.inbound(
  p_tenant uuid, p_channel uuid, p_phone text, p_name text, p_wamid text, p_sent timestamptz,
  p_kind text default 'text', p_body text default 'hello'
) returns table (conversation_id uuid, message_id uuid, inserted boolean)
  language sql
as $$
  select * from public.store_inbound_message(p_tenant, p_channel, p_phone, p_name, p_wamid, p_kind, p_body, null, '{}'::jsonb, p_sent)
$$;

-- Access and schema -----------------------------------------------------------------------------------

select ok(has_function_privilege('service_role',
  'public.store_inbound_message(uuid, uuid, text, text, text, text, text, jsonb, jsonb, timestamp with time zone)', 'execute'),
  'server code can store inbound messages');
select ok(not has_function_privilege('authenticated',
  'public.store_inbound_message(uuid, uuid, text, text, text, text, text, jsonb, jsonb, timestamp with time zone)', 'execute'),
  'members cannot call store_inbound_message');
select ok(not has_function_privilege('anon',
  'public.store_inbound_message(uuid, uuid, text, text, text, text, text, jsonb, jsonb, timestamp with time zone)', 'execute'),
  'signed-out visitors cannot call store_inbound_message');
select ok(has_function_privilege('service_role', 'public.apply_message_status(uuid, text, text)', 'execute'),
  'server code can apply delivery statuses');
select ok(not has_function_privilege('authenticated', 'public.apply_message_status(uuid, text, text)', 'execute'),
  'members cannot call apply_message_status');
select has_column('public', 'messages', 'kind', 'messages has a kind');
select has_column('public', 'messages', 'meta', 'messages has a meta');
select ok(exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'conversations_one_open_idx'),
  'one open conversation per contact and channel is enforced by an index');

-- The first message of a new contact -------------------------------------------------------------------

create temp table r1 as
  select * from pg_temp.inbound('d0000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-00000000000a',
    '+919800000301', 'Asha', 'wamid.pg1', '2026-10-06 09:30:00+00');

select is((select inserted from r1), true, 'a first message is inserted');
select is((select count(*) from public.contacts where tenant_id = 'd0000000-0000-0000-0000-00000000000a' and phone = '+919800000301'),
  1::bigint, 'the contact is created');
select is((select name from public.contacts where tenant_id = 'd0000000-0000-0000-0000-00000000000a' and phone = '+919800000301'),
  'Asha', 'the profile name is stored on a new contact');
select is((select count(*) from public.conversations c join public.contacts ct on ct.id = c.contact_id
           where ct.phone = '+919800000301' and ct.tenant_id = 'd0000000-0000-0000-0000-00000000000a' and c.status = 'open'),
  1::bigint, 'one open conversation is created');
select results_eq(
  $$select direction, sender, kind, body, created_at from public.messages where id = (select message_id from r1)$$,
  $$values ('in'::text, 'customer'::text, 'text'::text, 'hello'::text, '2026-10-06 09:30:00+00'::timestamptz)$$,
  'the message is stored as an inbound customer message at the time Meta gave');
select is((select last_customer_msg_at from public.conversations where id = (select conversation_id from r1)),
  '2026-10-06 09:30:00+00'::timestamptz, 'last_customer_msg_at is set');

-- The same message again (Meta retries) ---------------------------------------------------------------

create temp table r2 as
  select * from pg_temp.inbound('d0000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-00000000000a',
    '+919800000301', 'Asha', 'wamid.pg1', '2026-10-06 09:30:00+00');

select is((select inserted from r2), false, 'a replay is reported as not inserted');
select is((select message_id from r2), (select message_id from r1), 'a replay returns the stored message id');
select is((select count(*) from public.messages where provider_msg_id = 'wamid.pg1'), 1::bigint, 'a replay creates no second message');
select is((select count(*) from public.conversations where tenant_id = 'd0000000-0000-0000-0000-00000000000a'), 1::bigint,
  'a replay creates no second conversation');

-- Later and earlier messages from the same customer ---------------------------------------------------

create temp table r3 as
  select * from pg_temp.inbound('d0000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-00000000000a',
    '+919800000301', 'Asha', 'wamid.pg2', '2026-10-06 09:31:00+00');

select is((select conversation_id from r3), (select conversation_id from r1), 'the next message joins the same open conversation');
select is((select last_customer_msg_at from public.conversations where id = (select conversation_id from r1)),
  '2026-10-06 09:31:00+00'::timestamptz, 'last_customer_msg_at moves forward');
select is((select count(*) from public.contacts where tenant_id = 'd0000000-0000-0000-0000-00000000000a' and phone = '+919800000301'),
  1::bigint, 'the contact is reused');

create temp table r4 as
  select * from pg_temp.inbound('d0000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-00000000000a',
    '+919800000301', 'Asha', 'wamid.pg3', '2026-10-06 08:30:00+00');
select is((select last_customer_msg_at from public.conversations where id = (select conversation_id from r1)),
  '2026-10-06 09:31:00+00'::timestamptz, 'a late older message does not move last_customer_msg_at back');

-- Names are only ever filled in, never overwritten ----------------------------------------------------

select pg_temp.inbound('d0000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-00000000000a',
  '+919800000302', null, 'wamid.pg-n1', '2026-10-06 09:30:00+00');
select is((select name from public.contacts where tenant_id = 'd0000000-0000-0000-0000-00000000000a' and phone = '+919800000302'),
  null, 'a contact with no profile name has none');
select pg_temp.inbound('d0000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-00000000000a',
  '+919800000302', 'Bala', 'wamid.pg-n2', '2026-10-06 09:31:00+00');
select is((select name from public.contacts where tenant_id = 'd0000000-0000-0000-0000-00000000000a' and phone = '+919800000302'),
  'Bala', 'a name is set when the contact has none');
select pg_temp.inbound('d0000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-00000000000a',
  '+919800000302', 'Someone Else', 'wamid.pg-n3', '2026-10-06 09:32:00+00');
select is((select name from public.contacts where tenant_id = 'd0000000-0000-0000-0000-00000000000a' and phone = '+919800000302'),
  'Bala', 'an existing name is not overwritten');
select pg_temp.inbound('d0000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-00000000000a',
  '+919800000301', null, 'wamid.pg-n4', '2026-10-06 09:33:00+00');
select is((select name from public.contacts where tenant_id = 'd0000000-0000-0000-0000-00000000000a' and phone = '+919800000301'),
  'Asha', 'a message with no profile name keeps the name');

-- Closed conversations are not reused -----------------------------------------------------------------

update public.conversations set status = 'closed' where id = (select conversation_id from r1);
create temp table r5 as
  select * from pg_temp.inbound('d0000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-00000000000a',
    '+919800000301', 'Asha', 'wamid.pg5', '2026-10-06 10:00:00+00');

select isnt((select conversation_id from r5), (select conversation_id from r1), 'a closed conversation is not reused');
select is((select status from public.conversations where id = (select conversation_id from r1)), 'closed', 'the closed conversation stays closed');
select is((select count(*) from public.conversations c join public.contacts ct on ct.id = c.contact_id
           where ct.phone = '+919800000301' and ct.tenant_id = 'd0000000-0000-0000-0000-00000000000a' and c.status = 'open'),
  1::bigint, 'the contact has exactly one open conversation again');

select throws_ok(
  $$insert into public.conversations (tenant_id, contact_id, channel_id)
    select tenant_id, contact_id, channel_id from public.conversations where id = (select conversation_id from r5)$$,
  '23505', null, 'a second open conversation for the same contact and channel is refused');
select lives_ok(
  $$insert into public.conversations (tenant_id, contact_id, channel_id, status)
    select tenant_id, contact_id, channel_id, 'closed' from public.conversations where id = (select conversation_id from r5)$$,
  'any number of closed conversations is fine');

-- Kinds, media, meta and timestamps -------------------------------------------------------------------

select public.store_inbound_message('d0000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-00000000000a', '+919800000303', null,
  'wamid.pg-image', 'image', 'Kitchen photo', '{"id": "m1", "mime": "image/jpeg"}'::jsonb, '{}'::jsonb, '2026-10-06 09:30:00+00');
select results_eq(
  $$select kind, body, media->>'id', media->>'mime' from public.messages where provider_msg_id = 'wamid.pg-image'$$,
  $$values ('image'::text, 'Kitchen photo'::text, 'm1'::text, 'image/jpeg'::text)$$, 'an image keeps its caption and media id');

select public.store_inbound_message('d0000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-00000000000a', '+919800000303', null,
  'wamid.pg-audio', 'audio', null, '{"id": "m2", "mime": "audio/ogg"}'::jsonb, '{}'::jsonb, '2026-10-06 09:31:00+00');
select is((select kind from public.messages where provider_msg_id = 'wamid.pg-audio'), 'audio', 'a voice note is stored as audio');

select public.store_inbound_message('d0000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-00000000000a', '+919800000303', null,
  'wamid.pg-sticker', 'unsupported', null, null, '{"unsupportedType": "sticker"}'::jsonb, '2026-10-06 09:32:00+00');
select results_eq(
  $$select kind, body, meta->>'unsupportedType' from public.messages where provider_msg_id = 'wamid.pg-sticker'$$,
  $$values ('unsupported'::text, null::text, 'sticker'::text)$$, 'an unsupported message has no body and keeps its original type');

create temp table r6 as
  select * from public.store_inbound_message('d0000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-00000000000a', '+919800000304',
    null, 'wamid.pg-future', 'text', 'from the future', null, '{}'::jsonb, now() + interval '1 day');
select ok((select created_at <= now() from public.messages where provider_msg_id = 'wamid.pg-future'),
  'a message dated in the future is stored no later than now');
select ok((select last_customer_msg_at <= now() from public.conversations where id = (select conversation_id from r6)),
  'a future date cannot stretch the 24-hour window');

-- Bad input -------------------------------------------------------------------------------------------

select throws_ok($$select pg_temp.inbound('d0000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-00000000000a', '0123', null, 'wamid.bad1', now())$$,
  'P0001', null, 'a phone number that is not E.164 is refused');
select throws_ok($$select pg_temp.inbound('d0000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-00000000000a', '+919800000305', null, 'wamid.bad2', now(), 'sticker')$$,
  'P0001', null, 'a kind we do not store is refused');
select throws_ok($$select pg_temp.inbound('d0000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-00000000000a', '+919800000305', null, '', now())$$,
  'P0001', null, 'an empty provider message id is refused');

-- Two businesses ---------------------------------------------------------------------------------------

create temp table rb as
  select * from pg_temp.inbound('d0000000-0000-0000-0000-00000000000b', 'd2000000-0000-0000-0000-00000000000b',
    '+919800000301', 'Asha at B', 'wamid.pgB1', '2026-10-06 09:30:00+00');

select is((select count(*) from public.contacts where phone = '+919800000301'), 2::bigint, 'the same number is a separate contact in each business');
select is((select tenant_id from public.conversations where id = (select conversation_id from rb)),
  'd0000000-0000-0000-0000-00000000000b'::uuid, 'the conversation belongs to the business whose number was written to');
select throws_ok($$select pg_temp.inbound('d0000000-0000-0000-0000-00000000000b', 'd2000000-0000-0000-0000-00000000000a', '+919800000306', null, 'wamid.pgB2', now())$$,
  'PA404', null, 'a channel of another business is refused');
select throws_ok($$select pg_temp.inbound('d0000000-0000-0000-0000-00000000000b', 'd2000000-0000-0000-0000-00000000000b', '+919800000301', null, 'wamid.pg1', now())$$,
  'PA409', null, 'a message id that belongs to another business is refused');
select is((select count(*) from public.messages where tenant_id = 'd0000000-0000-0000-0000-00000000000b' and provider_msg_id = 'wamid.pg1'),
  0::bigint, 'and nothing is stored under the other business');

-- The shared demo number (0031): a channel of one of our own platform connections may carry another business's chat,
-- a client's own (manual_byo) channel may not.
insert into public.channels (id, tenant_id, type) values
  ('d2000000-0000-0000-0000-0000000000c1', 'd0000000-0000-0000-0000-00000000000a', 'whatsapp'),
  ('d2000000-0000-0000-0000-0000000000c2', 'd0000000-0000-0000-0000-00000000000a', 'whatsapp');
insert into public.whatsapp_connections (tenant_id, channel_id, method, waba_id, phone_number_id, token_enc, token_type, connected_by) values
  ('d0000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-0000000000c1', 'platform', 'pg-demo-waba', 'pg-demo-pnid', 'placeholder', 'system_user', 'system:seed'),
  ('d0000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-0000000000c2', 'manual_byo', 'pg-own-waba', 'pg-own-pnid', 'placeholder', 'system_user', 'system:seed');

create temp table rp as
  select * from pg_temp.inbound('d0000000-0000-0000-0000-00000000000b', 'd2000000-0000-0000-0000-0000000000c1',
    '+919800000401', 'Visitor', 'wamid.pgP1', '2026-10-06 10:00:00+00');
select is((select inserted from rp), true, 'a platform channel carries another business''s chat');
select is((select tenant_id || '/' || channel_id from public.conversations where id = (select conversation_id from rp)),
  'd0000000-0000-0000-0000-00000000000b/d2000000-0000-0000-0000-0000000000c1',
  'the chat belongs to the routed business and sits on the platform channel');
select is((select inserted from pg_temp.inbound('d0000000-0000-0000-0000-00000000000b', 'd2000000-0000-0000-0000-0000000000c1',
    '+919800000401', 'Visitor', 'wamid.pgP1', '2026-10-06 10:00:00+00')), false, 'a replay on the platform channel stores nothing new');
select throws_ok($$select pg_temp.inbound('d0000000-0000-0000-0000-00000000000a', 'd2000000-0000-0000-0000-0000000000c1', '+919800000402', null, 'wamid.pgP1', now())$$,
  'PA409', null, 'a message id of another business is still refused on the platform channel');
select throws_ok($$select pg_temp.inbound('d0000000-0000-0000-0000-0000000000ff', 'd2000000-0000-0000-0000-0000000000c1', '+919800000403', null, 'wamid.pgP2', now())$$,
  'PA404', null, 'a business that does not exist is refused on the platform channel');
select throws_ok($$select pg_temp.inbound('d0000000-0000-0000-0000-00000000000b', 'd2000000-0000-0000-0000-0000000000c2', '+919800000404', null, 'wamid.pgP3', now())$$,
  'PA404', null, 'a client''s own channel is still refused for another business');

-- Delivery statuses -----------------------------------------------------------------------------------

insert into public.messages (tenant_id, conversation_id, direction, sender, body, provider_msg_id, delivery_status) values
  ('d0000000-0000-0000-0000-00000000000a', (select conversation_id from r5), 'out', 'ai', 'hi', 'o1', 'accepted'),
  ('d0000000-0000-0000-0000-00000000000a', (select conversation_id from r5), 'out', 'ai', 'hi', 'o3', 'accepted'),
  ('d0000000-0000-0000-0000-00000000000a', (select conversation_id from r5), 'out', 'ai', 'hi', 'o4', 'sent'),
  ('d0000000-0000-0000-0000-00000000000b', (select conversation_id from rb), 'out', 'ai', 'hi', 'oB', 'accepted');

select is(public.apply_message_status('d0000000-0000-0000-0000-00000000000a', 'o1', 'sent'), true, 'accepted moves to sent');
select is(public.apply_message_status('d0000000-0000-0000-0000-00000000000a', 'o1', 'delivered'), true, 'sent moves to delivered');
select is(public.apply_message_status('d0000000-0000-0000-0000-00000000000a', 'o1', 'sent'), false, 'a late sent does not move delivered back');
select is((select delivery_status from public.messages where provider_msg_id = 'o1'), 'delivered', 'the status is still delivered');
select is(public.apply_message_status('d0000000-0000-0000-0000-00000000000a', 'o1', 'read'), true, 'delivered moves to read');
select is(public.apply_message_status('d0000000-0000-0000-0000-00000000000a', 'o1', 'delivered'), false, 'a late delivered does not move read back');
select is(public.apply_message_status('d0000000-0000-0000-0000-00000000000a', 'o1', 'failed'), false, 'a failure does not overwrite read');
select is((select delivery_status from public.messages where provider_msg_id = 'o1'), 'read', 'the status is still read');
select is(public.apply_message_status('d0000000-0000-0000-0000-00000000000a', 'o3', 'failed'), true, 'a failure replaces accepted');
select is(public.apply_message_status('d0000000-0000-0000-0000-00000000000a', 'o3', 'sent'), false, 'a late sent does not undo a failure');
select is(public.apply_message_status('d0000000-0000-0000-0000-00000000000a', 'o3', 'delivered'), true, 'a delivery after a failure wins (the later, stronger fact)');
select is(public.apply_message_status('d0000000-0000-0000-0000-00000000000b', 'o4', 'delivered'), false, 'another business cannot change this message');
select is((select delivery_status from public.messages where provider_msg_id = 'o4'), 'sent', 'and it is unchanged');
select is(public.apply_message_status('d0000000-0000-0000-0000-00000000000a', 'does-not-exist', 'read'), false, 'an unknown message id changes nothing');
select is(public.apply_message_status('d0000000-0000-0000-0000-00000000000a', 'wamid.pg1', 'read'), false, 'an inbound message is never given a delivery status');
select is((select delivery_status from public.messages where provider_msg_id = 'wamid.pg1'), null, 'it still has none');
select throws_ok($$select public.apply_message_status('d0000000-0000-0000-0000-00000000000a', 'o1', 'played')$$,
  'P0001', null, 'a status we do not track is refused');
select is(public.apply_message_status('d0000000-0000-0000-0000-00000000000b', 'oB', 'sent'), true, 'each business updates its own messages');

select * from finish();
rollback;
