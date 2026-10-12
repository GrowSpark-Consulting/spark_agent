-- Seed contents (supabase/seed). Expects a database built with the seed: pnpm db:reset, then pnpm db:test.
begin;
create extension if not exists pgtap with schema extensions;
select plan(18);

select results_eq(
  'select key, price_inr, monthly_credits, seats, whatsapp_numbers from public.plans order by price_inr',
  $$values ('trial'::text, 0, 300, 2, 1), ('starter', 2499, 1500, 2, 1),
           ('growth', 5999, 5000, 5, 1), ('pro', 12999, 15000, 999, 3)$$,
  'plans match the handover prices, credits, seats and numbers');

select is((select count(*) from public.features), 21::bigint,
  'all 21 feature keys are seeded (16 v1 + 5 added in v1.0)');

select is(
  (select count(*) from (select distinct unnest(feature_keys) as k from public.plans) p
    where p.k not in (select key from public.features)),
  0::bigint,
  'every feature a plan lists exists in features');

select results_eq(
  $$select key from public.features
    where key in ('handoff_own_number','custom_scoring','quote_auto_send','quote_followup','pretrip_info')
    order by key$$,
  array['custom_scoring','handoff_own_number','pretrip_info','quote_auto_send','quote_followup'],
  'the five new feature keys are seeded');

select results_eq(
  $$select key, default_on from public.features
    where key in ('quote_auto_send','quote_followup','pretrip_info') order by key$$,
  $$values ('pretrip_info'::text, true), ('quote_auto_send', false), ('quote_followup', true)$$,
  'quote and trip toggles default as the handover says');

select is(
  (select count(*) from public.features
    where (key in ('staff_alerts','daily_agenda','handoff_triggers') and credit_cost <> 0)
       or (key in ('ai_auto_reply','reminder_24h','followup_nudges') and credit_cost <> 1)),
  0::bigint,
  'staff alerts and the daily agenda are free; AI replies and automated messages cost 1');

select results_eq(
  $$select r.code, t.vertical from public.route_codes r join public.tenants t on t.id = r.tenant_id
    where r.kind = 'demo' order by r.code$$,
  $$values ('DEMO-INTERIORS'::text, 'interiors'::text), ('DEMO-REALESTATE', 'real-estate'), ('DEMO-SALON', 'salon')$$,
  'each demo route code reaches the demo business for its pack');

select is(
  (select count(*) from public.credit_ledger
    where tenant_id in (select tenant_id from public.route_codes where kind = 'demo') and delta > 0),
  3::bigint,
  'each demo business has one credit grant');

select is(
  (select count(*) from public.tenants t
    where t.name like 'Isolation Test %'
      and (select count(*) from public.leads l where l.tenant_id = t.id) = 1
      and (select count(*) from public.whatsapp_connections w where w.tenant_id = t.id) = 1),
  2::bigint,
  'two isolation-test businesses each have a lead and a connection');

select is(
  (select count(*) from public.memberships m
    where m.tenant_id::text like 'd0000000-%'),
  0::bigint,
  'the seed creates no logins for seeded businesses');

select is(
  (select count(*) from public.whatsapp_connections
    where tenant_id::text like 'd0000000-%' and token_enc <> 'seed-placeholder-not-a-token'),
  0::bigint,
  'seeded connections hold only a placeholder, never a real token');

-- Booking setup (supabase/seed/booking_setup.sql)
select is(
  (select count(*) from public.tenants t
    where t.id in (select tenant_id from public.route_codes where kind = 'demo')
      and exists (select 1 from public.services s where s.tenant_id = t.id and s.active)
      and exists (select 1 from public.resources r where r.tenant_id = t.id and r.active and r.working_hours <> '{}')),
  3::bigint,
  'each demo business has services and resources with working hours');

select is(
  (select count(*) from public.services s
    where s.tenant_id::text like 'd0000000-%'
      and not exists (select 1 from public.resources r
                       where r.tenant_id = s.tenant_id and r.type = s.resource_type and r.active)),
  0::bigint,
  'every seeded service has an active resource of its type, so it can be booked');

select is(
  (select count(*) from public.tenants where id::text like 'd0000000-%' and business_hours = '{}'),
  0::bigint,
  'every seeded business has business hours');

select is(
  (select count(*)
     from public.resources r, jsonb_each(r.working_hours) d, jsonb_array_elements(d.value) i
    where r.tenant_id::text like 'd0000000-%'
      and (d.key not in ('mon','tue','wed','thu','fri','sat','sun')
           or (i ->> 'start') !~ '^\d\d:\d\d$' or (i ->> 'end') !~ '^\d\d:\d\d$'
           or (i ->> 'start') >= (i ->> 'end'))),
  0::bigint,
  'seeded working hours use day keys mon..sun and HH:MM intervals that end after they start');

select is(
  (select count(*) from public.resources r
    where r.tenant_id::text like 'd0000000-%' and r.service_area is not null
      and jsonb_typeof(r.service_area -> 'pincodes') is distinct from 'array'),
  0::bigint,
  'seeded service areas list pincodes');

-- The real-estate demo can be scored and booked (Dev 1's Day 3 note, section 7).
select is(
  (select count(*) from public.catalog_items c
    where c.tenant_id = 'd0000000-0000-0000-0000-000000000001' and c.active and c.price_from > 0
      and (c.attributes ->> 'price_to')::int >= c.price_from and c.attributes ->> 'area' <> ''),
  3::bigint,
  'the real-estate demo has three projects with a price band and an area, for the budget and area rules');
select is(
  (select s.name from public.tenants t join public.services s on s.id = (t.agent_settings ->> 'bookingServiceId')::uuid and s.tenant_id = t.id and s.active
    where t.id = 'd0000000-0000-0000-0000-000000000001'),
  'Site visit',
  'the real-estate demo names the active service the assistant books');

select * from finish();
rollback;
