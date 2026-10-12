-- Plan limits (0027): team seats and WhatsApp numbers per plan, enforced by the database for every path.
-- Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

-- Fixtures (the seed's plans may already be there; these match them: Trial has 2 seats and 1 number, Starter 2 and 1).
insert into public.plans (key, name, price_inr, monthly_credits, seats, whatsapp_numbers, feature_keys) values
  ('trial', 'Trial', 0, 300, 2, 1, array['ai_auto_reply']),
  ('starter', 'Starter', 2499, 1500, 2, 1, array['ai_auto_reply'])
  on conflict (key) do nothing;
insert into auth.users (id, email) values
  ('0c000000-0000-0000-0000-000000000001', 'limits-1@test.local'),
  ('0c000000-0000-0000-0000-000000000002', 'limits-2@test.local'),
  ('0c000000-0000-0000-0000-000000000003', 'limits-3@test.local');
insert into public.tenants (id, name, vertical, plan_key) values
  ('0c100000-0000-0000-0000-000000000001', 'Seats', 'test-pack', 'trial'),
  ('0c100000-0000-0000-0000-000000000002', 'Numbers', 'test-pack', 'starter'),
  ('0c100000-0000-0000-0000-000000000003', 'Elsewhere', 'test-pack', 'trial');
insert into public.channels (id, tenant_id, type) values
  ('0c200000-0000-0000-0000-000000000002', '0c100000-0000-0000-0000-000000000002', 'whatsapp');

-- Seats ---------------------------------------------------------------------------------------------------------------

select lives_ok($$insert into public.memberships (tenant_id, user_id, role) values
                  ('0c100000-0000-0000-0000-000000000001', '0c000000-0000-0000-0000-000000000001', 'owner'),
                  ('0c100000-0000-0000-0000-000000000001', '0c000000-0000-0000-0000-000000000002', 'admin')$$,
  'a business may have as many members as its plan has seats');
select throws_ok($$insert into public.memberships (tenant_id, user_id, role) values
                   ('0c100000-0000-0000-0000-000000000001', '0c000000-0000-0000-0000-000000000003', 'staff')$$,
  'PA413', 'seat_limit: the Trial plan includes 2 team members', 'one more is refused with the plan''s seats');
select is((select count(*)::int from public.memberships where tenant_id = '0c100000-0000-0000-0000-000000000001'), 2,
  'and nothing was added');
select lives_ok($$insert into public.memberships (tenant_id, user_id, role) values
                  ('0c100000-0000-0000-0000-000000000003', '0c000000-0000-0000-0000-000000000003', 'owner')$$,
  'another business''s seats are its own');
select throws_ok($$update public.memberships set tenant_id = '0c100000-0000-0000-0000-000000000001'
                   where tenant_id = '0c100000-0000-0000-0000-000000000003'$$,
  'PA413', null, 'a member cannot be moved into a business that is full');
select lives_ok($$update public.memberships set whatsapp_phone = '+919800000401'
                  where tenant_id = '0c100000-0000-0000-0000-000000000001' and role = 'admin'$$,
  'a member of a full business can still change their own details');

-- WhatsApp numbers ----------------------------------------------------------------------------------------------------

create function pg_temp.add_number(p_pnid text, p_method text default 'manual_byo', p_status text default 'pending') returns void language sql as $$
  insert into public.whatsapp_connections (tenant_id, channel_id, method, waba_id, phone_number_id, token_enc, token_type, connected_by, status)
  values ('0c100000-0000-0000-0000-000000000002', '0c200000-0000-0000-0000-000000000002', p_method, 'limits-waba', p_pnid,
          'placeholder', 'system_user', 'system', p_status)
$$;

select lives_ok($$select pg_temp.add_number('limits-1')$$, 'a Starter business connects its one number');
select throws_ok($$select pg_temp.add_number('limits-2')$$,
  'PA403', 'whatsapp_number_limit: the Starter plan includes 1 WhatsApp numbers', 'a second is refused with the plan''s numbers');
select lives_ok($$select pg_temp.add_number('limits-platform', 'platform', 'active')$$, 'our own platform numbers never count');
select lives_ok($$update public.whatsapp_connections set status = 'active' where phone_number_id = 'limits-1';
                  update public.whatsapp_connections set status = 'failed' where phone_number_id = 'limits-1'$$,
  'a counted number can move between pending, active and failed');
select throws_ok($$select pg_temp.add_number('limits-3')$$,
  'PA403', null, 'a failed number still counts: disconnect it to make room');
select lives_ok($$update public.whatsapp_connections set status = 'disconnected' where phone_number_id = 'limits-1';
                  select pg_temp.add_number('limits-4')$$,
  'after a disconnect, another number fits');
select throws_ok($$update public.whatsapp_connections set status = 'pending' where phone_number_id = 'limits-1'$$,
  'PA403', null, 'and the disconnected one cannot come back while the other is connected');

select * from finish();
rollback;
