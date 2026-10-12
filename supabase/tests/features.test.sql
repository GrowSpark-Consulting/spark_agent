-- set_tenant_feature (0025): the plan check, the write and the audit row of PATCH /api/features/:key. Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

-- Fixtures (the seed's plans may already be there; these rows match them where it matters: Starter has
-- reminder_24h but neither followup_nudges nor outbound_webhooks).
insert into public.plans (key, name, price_inr, monthly_credits, seats, whatsapp_numbers, feature_keys)
  values ('starter', 'Starter', 2499, 1500, 2, 1, array['reminder_24h'])
  on conflict (key) do nothing;
insert into public.features (key, name, description, default_on) values
  ('reminder_24h', 'Day-before reminder', 'A reminder.', true),
  ('followup_nudges', 'Follow-up nudges', 'Nudges.', true),
  ('outbound_webhooks', 'Outbound webhooks', 'Webhooks.', false)
  on conflict (key) do nothing;
insert into public.tenants (id, name, vertical, plan_key) values
  ('f0000000-0000-0000-0000-000000000001', 'Feature Test', 'test-pack', 'starter');

set local role authenticated;
select throws_ok(
  $$select public.set_tenant_feature('f0000000-0000-0000-0000-000000000001', 'reminder_24h', false, null, 'system')$$,
  '42501', null, 'a signed-in user cannot call set_tenant_feature (server only)');
reset role;

select throws_ok(
  $$select public.set_tenant_feature('f0000000-0000-0000-0000-0000000000ff', 'reminder_24h', false, null, 'system')$$,
  'PA404', null, 'an unknown business is not_found');
select throws_ok(
  $$select public.set_tenant_feature('f0000000-0000-0000-0000-000000000001', 'no_such_feature', true, null, 'system')$$,
  'PA404', null, 'an unknown feature is not_found');
select throws_ok(
  $$select public.set_tenant_feature('f0000000-0000-0000-0000-000000000001', 'reminder_24h', null, '[1]', 'system')$$,
  'P0001', null, 'settings must be an object');

-- Locked: the plan does not include it.
select throws_ok(
  $$select public.set_tenant_feature('f0000000-0000-0000-0000-000000000001', 'outbound_webhooks', true, null, 'system')$$,
  'PA403', null, 'a feature outside the plan cannot be switched on');
select throws_ok(
  $$select public.set_tenant_feature('f0000000-0000-0000-0000-000000000001', 'followup_nudges', null, '{"nurture_after_minutes": 2880}', 'system')$$,
  'PA403', null, 'the settings of a feature outside the plan cannot change');
select is(
  public.set_tenant_feature('f0000000-0000-0000-0000-000000000001', 'followup_nudges', true, null, 'system') ->> 'changed',
  'false', 'sending a locked feature the value it already has (on by default) changes nothing and is allowed');
select is(
  public.set_tenant_feature('f0000000-0000-0000-0000-000000000001', 'followup_nudges', false, null, 'e0000000-0000-0000-0000-0000000000aa'),
  '{"changed": true, "enabled": false, "settings": {}}'::jsonb, 'a feature outside the plan can be switched off');

-- In the plan.
select is(
  public.set_tenant_feature('f0000000-0000-0000-0000-000000000001', 'reminder_24h', false, null, 'e0000000-0000-0000-0000-0000000000aa'),
  '{"changed": true, "enabled": false, "settings": {}}'::jsonb, 'an owner switches off a feature in the plan');
select is(
  (select enabled from public.tenant_features where tenant_id = 'f0000000-0000-0000-0000-000000000001' and feature_key = 'reminder_24h'),
  false, 'the switch is saved');
select results_eq(
  $$select action, actor, diff from public.audit_logs where tenant_id = 'f0000000-0000-0000-0000-000000000001' and diff ->> 'key' = 'reminder_24h'$$,
  $$values ('feature.toggled'::text, 'e0000000-0000-0000-0000-0000000000aa'::text,
            '{"key": "reminder_24h", "enabled": {"from": true, "to": false}, "settings": {"from": {}, "to": {}}}'::jsonb)$$,
  'the change is audited with who made it and both values');

select is(
  public.set_tenant_feature('f0000000-0000-0000-0000-000000000001', 'reminder_24h', false, '{}', 'system') ->> 'changed',
  'false', 'saving the same values again changes nothing');
select is(
  (select count(*)::int from public.audit_logs where tenant_id = 'f0000000-0000-0000-0000-000000000001'),
  2, 'and writes no audit row (the two rows are the two real changes)');

select public.set_tenant_feature('f0000000-0000-0000-0000-000000000001', 'reminder_24h', null, '{"offset_minutes": 720}', 'system');
select results_eq(
  $$select action, diff -> 'settings' from public.audit_logs
     where tenant_id = 'f0000000-0000-0000-0000-000000000001' and action = 'feature.settings_changed'$$,
  $$values ('feature.settings_changed'::text, '{"from": {}, "to": {"offset_minutes": 720}}'::jsonb)$$,
  'a settings change keeps the switch and is audited as feature.settings_changed');

select * from finish();
rollback;
