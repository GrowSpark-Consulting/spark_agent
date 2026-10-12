-- whatsapp_connections.method (0003, widened in 0014): embedded_signup, assisted, manual_byo and platform
-- (our own numbers, signed with our own Meta app). Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000005a0', 'method-a@test.local');
-- Several numbers of one business, so it is on Pro (3 numbers; 0027 refuses more than the plan's).
insert into public.plans (key, name, price_inr, monthly_credits, seats, whatsapp_numbers, feature_keys)
  values ('pro', 'Pro', 12999, 15000, 999, 3, array['ai_auto_reply'])
  on conflict (key) do nothing;  -- the seed may already have it
insert into public.tenants (id, name, vertical, plan_key) values
  ('d5000000-0000-0000-0000-00000000000a', 'Method Test', 'test-pack', 'pro');
insert into public.memberships (tenant_id, user_id, role) values
  ('d5000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000005a0', 'owner');
insert into public.channels (id, tenant_id, type) values
  ('d5200000-0000-0000-0000-00000000000a', 'd5000000-0000-0000-0000-00000000000a', 'whatsapp');

create function pg_temp.connect(p_method text, p_pnid text) returns void language sql as $$
  insert into public.whatsapp_connections (tenant_id, channel_id, method, waba_id, phone_number_id, token_enc, token_type, connected_by)
  values ('d5000000-0000-0000-0000-00000000000a', 'd5200000-0000-0000-0000-00000000000a', p_method, 'method-waba', p_pnid,
          'placeholder', 'system_user', 'system:seed')
$$;

select lives_ok($$select pg_temp.connect('embedded_signup', 'method-pnid-1')$$, 'embedded_signup is allowed');
select lives_ok($$select pg_temp.connect('assisted', 'method-pnid-2')$$, 'assisted is allowed');
select lives_ok($$select pg_temp.connect('manual_byo', 'method-pnid-3')$$, 'manual_byo is allowed');
select lives_ok($$select pg_temp.connect('platform', 'method-pnid-4')$$, 'platform is allowed');
select throws_ok($$select pg_temp.connect('bsp', 'method-pnid-5')$$, '23514', null, 'any other method is refused');
select throws_ok($$select pg_temp.connect('', 'method-pnid-6')$$, '23514', null, 'an empty method is refused');
select throws_ok($$select pg_temp.connect(null, 'method-pnid-7')$$, '23502', null, 'a missing method is refused');

select is((select method from public.whatsapp_connections where phone_number_id = 'method-pnid-4'), 'platform',
  'the platform connection is stored with that method');
-- The dashboard reads the view as a signed-in member of the business.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000005a0","role":"authenticated"}', true);
select is((select method from public.whatsapp_connections_public where phone_number_id = 'method-pnid-4'), 'platform',
  'and the dashboard view shows it to a member of the business');
reset role;

select * from finish();
rollback;
