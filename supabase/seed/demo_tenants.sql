-- Demo businesses (one per launch pack, reached on the shared demo number by route code)
-- and two isolation-test businesses with a little data each. Safe to run more than once.
--
-- No auth users or passwords here: this repo is public. To let a signed-up dashboard user
-- into an isolation business, run (locally or with `pnpm exec supabase db query --linked`):
--   insert into public.memberships (tenant_id, user_id, role)
--   select 'd0000000-0000-0000-0000-0000000000a1', id, 'owner' from auth.users where email = '<email>';

insert into public.tenants (id, name, vertical, status, plan_key) values
  ('d0000000-0000-0000-0000-000000000001', 'Spark Agent Demo — Real Estate', 'real-estate', 'active', 'pro'),
  ('d0000000-0000-0000-0000-000000000002', 'Spark Agent Demo — Interiors',   'interiors',   'active', 'pro'),
  ('d0000000-0000-0000-0000-000000000003', 'Spark Agent Demo — Salon',       'salon',       'active', 'pro'),
  ('d0000000-0000-0000-0000-0000000000a1', 'Isolation Test A',         'real-estate', 'trial',  'trial'),
  ('d0000000-0000-0000-0000-0000000000b1', 'Isolation Test B',         'real-estate', 'trial',  'trial')
on conflict (id) do nothing;

-- The front desk: the business that owns the shared demo number's platform connection (pnpm seed:connection --tenant
-- d0000000-0000-0000-0000-0000000000fd). A visitor who can't be routed (no code, a bad code, over the daily limit) is
-- stored and answered here with the menu, never by the assistant, so it has no members, no route code and no credits
-- (those answers are free system notices). Active on Pro like the demo businesses, so no trial job ever touches it.
insert into public.tenants (id, name, vertical, status, plan_key) values
  ('d0000000-0000-0000-0000-0000000000fd', 'Spark Agent front desk', 'real-estate', 'active', 'pro')
on conflict (id) do nothing;

-- Demo route codes: the first message on the demo number carries one of these.
insert into public.route_codes (code, kind, tenant_id) values
  ('DEMO-REALESTATE', 'demo', 'd0000000-0000-0000-0000-000000000001'),
  ('DEMO-INTERIORS',  'demo', 'd0000000-0000-0000-0000-000000000002'),
  ('DEMO-SALON',      'demo', 'd0000000-0000-0000-0000-000000000003')
on conflict (code) do nothing;

-- Credits so demo replies are never blocked; demo traffic is capped at 30 messages per phone per day.
insert into public.credit_ledger (tenant_id, delta, reason)
select t.id, 10000, 'admin'
from public.tenants t
where t.id in ('d0000000-0000-0000-0000-000000000001',
               'd0000000-0000-0000-0000-000000000002',
               'd0000000-0000-0000-0000-000000000003')
  and not exists (select 1 from public.credit_ledger l where l.tenant_id = t.id and l.reason = 'admin');

-- Isolation tests: each business gets a contact, a lead, a channel and a connection whose
-- token is a placeholder, so "a client can't read token_enc" has a row to try against.
insert into public.contacts (id, tenant_id, phone, name) values
  ('d1000000-0000-0000-0000-0000000000a1', 'd0000000-0000-0000-0000-0000000000a1', '+910000000101', 'Customer A'),
  ('d1000000-0000-0000-0000-0000000000b1', 'd0000000-0000-0000-0000-0000000000b1', '+910000000102', 'Customer B')
on conflict do nothing;

insert into public.leads (id, tenant_id, contact_id, stage) values
  ('d2000000-0000-0000-0000-0000000000a1', 'd0000000-0000-0000-0000-0000000000a1', 'd1000000-0000-0000-0000-0000000000a1', 'engaged'),
  ('d2000000-0000-0000-0000-0000000000b1', 'd0000000-0000-0000-0000-0000000000b1', 'd1000000-0000-0000-0000-0000000000b1', 'engaged')
on conflict do nothing;

insert into public.channels (id, tenant_id, type, status) values
  ('d3000000-0000-0000-0000-0000000000a1', 'd0000000-0000-0000-0000-0000000000a1', 'whatsapp', 'active'),
  ('d3000000-0000-0000-0000-0000000000b1', 'd0000000-0000-0000-0000-0000000000b1', 'whatsapp', 'active')
on conflict do nothing;

insert into public.whatsapp_connections
  (id, tenant_id, channel_id, method, waba_id, phone_number_id, token_enc, token_type, connected_by, status)
values
  ('d4000000-0000-0000-0000-0000000000a1', 'd0000000-0000-0000-0000-0000000000a1', 'd3000000-0000-0000-0000-0000000000a1',
   'manual_byo', 'seed-waba-a', 'seed-isolation-a', 'seed-placeholder-not-a-token', 'system_user', 'admin:seed', 'pending'),
  ('d4000000-0000-0000-0000-0000000000b1', 'd0000000-0000-0000-0000-0000000000b1', 'd3000000-0000-0000-0000-0000000000b1',
   'manual_byo', 'seed-waba-b', 'seed-isolation-b', 'seed-placeholder-not-a-token', 'system_user', 'admin:seed', 'pending')
on conflict do nothing;
