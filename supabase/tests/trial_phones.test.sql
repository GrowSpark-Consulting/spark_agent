-- One free trial per WhatsApp number (0031): claim_trial_phone records each trial's first TRIAL-code sender and
-- refuses that sender a second trial. Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

insert into public.tenants (id, name, vertical, status) values
  ('0f100000-0000-0000-0000-000000000001', 'First trial', 'test-pack', 'trial'),
  ('0f100000-0000-0000-0000-000000000002', 'Second trial', 'test-pack', 'trial'),
  ('0f100000-0000-0000-0000-000000000003', 'Third trial', 'test-pack', 'trial');

select is(public.claim_trial_phone('0f100000-0000-0000-0000-000000000001', '919800000601'), 'claimed',
  'the first TRIAL-code sender becomes the trial''s phone');
select is(public.claim_trial_phone('0f100000-0000-0000-0000-000000000001', '+91 98000 00601'), 'claimed',
  'the same phone again, written as E.164, is still the trial''s phone');
select is(public.claim_trial_phone('0f100000-0000-0000-0000-000000000001', '919800000602'), 'other_sender',
  'a second sender to the same trial is someone else trying it');
select is(public.claim_trial_phone('0f100000-0000-0000-0000-000000000002', '919800000601'), 'taken',
  'the first trial''s phone cannot start a second trial');
select is((select count(*)::int from public.trial_phones where tenant_id = '0f100000-0000-0000-0000-000000000002'), 0,
  'the refused claim recorded nothing for the second trial');
select is(public.claim_trial_phone('0f100000-0000-0000-0000-000000000002', '919800000603'), 'claimed',
  'the second trial then takes a phone of its own');
select is(public.claim_trial_phone('0f100000-0000-0000-0000-000000000002', '919800000601'), 'other_sender',
  'the first trial''s owner trying the second trial (which has its phone) is routed as usual');

select is((select count(*)::int from public.trial_phones where phone_hash ~ '^[0-9a-f]{64}$'
             and tenant_id in ('0f100000-0000-0000-0000-000000000001', '0f100000-0000-0000-0000-000000000002')), 2,
  'one row per trial, holding a hash');
select is((select count(*)::int from public.trial_phones where phone_hash like '%9800000601%'), 0,
  'the plain number is not stored');

delete from public.tenants where id = '0f100000-0000-0000-0000-000000000001';
select is(public.claim_trial_phone('0f100000-0000-0000-0000-000000000003', '919800000601'), 'taken',
  'a deleted trial''s phone still cannot start another');

select throws_ok($$select public.claim_trial_phone('0f100000-0000-0000-0000-000000000003', '98000')$$,
  'P0001', 'claim_trial_phone: the phone must be a full international number, country code included',
  'a number too short to be international is refused');
select throws_ok($$select public.claim_trial_phone('0f100000-0000-0000-0000-000000000003', 'abc919800000601')$$,
  'P0001', null, 'text that is not a phone is refused');
select throws_ok($$select public.claim_trial_phone('0f100000-0000-0000-0000-0000000000ff', '919800000609')$$,
  'P0001', 'claim_trial_phone: unknown business 0f100000-0000-0000-0000-0000000000ff', 'an unknown business is refused');

select is(
  (select array_agg(r order by r) from unnest(array['anon', 'authenticated']) r
    where has_function_privilege(r, 'public.claim_trial_phone(uuid, text)', 'execute')
       or has_table_privilege(r, 'public.trial_phones', 'select')),
  null,
  'the browser can neither call the claim nor read the table');

select * from finish();
rollback;
