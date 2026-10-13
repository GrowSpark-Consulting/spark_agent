-- Credit refunds (0008, 0034). Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

insert into public.tenants (id, name, vertical) values
  ('c5000000-0000-0000-0000-000000000001', 'Refunds', 'test-pack');
-- Two buckets: plan credits expiring sooner, a top-up later.
select public.renew_plan_credits('c5000000-0000-0000-0000-000000000001', 3, now() + interval '30 days');
select public.grant_credits('c5000000-0000-0000-0000-000000000001', 10, 'topup', 'c5100000-0000-0000-0000-000000000009');
-- A 5-credit spend for message c51…01 splits: 3 from the plan bucket, 2 from the top-up.
select public.spend_credits('c5000000-0000-0000-0000-000000000001', 5, 'ai_reply', 'c5100000-0000-0000-0000-000000000001');
-- Another message, not refunded.
select public.spend_credits('c5000000-0000-0000-0000-000000000001', 1, 'ai_reply', 'c5100000-0000-0000-0000-000000000002');

select results_eq($$select total from public.credit_balance('c5000000-0000-0000-0000-000000000001')$$,
  $$values (7)$$, 'before the refund: 13 granted, 6 spent');
select is(public.refund_credits('c5000000-0000-0000-0000-000000000001', 'c5100000-0000-0000-0000-000000000001'),
  5, 'the refund returns the 5 credits spent on that message');
select results_eq($$select * from public.credit_balance('c5000000-0000-0000-0000-000000000001')$$,
  $$values (3, 9, 12)$$, 'the balance is back, each part in its own bucket');
select results_eq(
  $$select delta, expires_at from public.credit_ledger
    where ref_id = 'c5100000-0000-0000-0000-000000000001' and reason = 'refund' order by expires_at$$,
  $$values (3, now() + interval '30 days'), (2, now() + interval '90 days')$$,
  'refunded credits keep their original expiry');
select is(public.refund_credits('c5000000-0000-0000-0000-000000000001', 'c5100000-0000-0000-0000-000000000001'),
  0, 'a second refund for the same message gives nothing');
select is(public.refund_credits('c5000000-0000-0000-0000-000000000001', 'c5100000-0000-0000-0000-0000000000ff'),
  0, 'a message with no spend refunds nothing');
select throws_ok($$select public.refund_credits('c5000000-0000-0000-0000-000000000001', null)$$,
  'P0001', null, 'a refund needs the message id');
select ok(not has_function_privilege('authenticated', 'public.refund_credits(uuid, uuid)', 'execute'),
  'members cannot refund credits');

-- A keyed send keeps its message id (c51…03) on every attempt a job retries, so each one spends and refunds under it.
select public.spend_credits('c5000000-0000-0000-0000-000000000001', 1, 'template_utility', 'c5100000-0000-0000-0000-000000000003');
select public.refund_credits('c5000000-0000-0000-0000-000000000001', 'c5100000-0000-0000-0000-000000000003');
select public.spend_credits('c5000000-0000-0000-0000-000000000001', 1, 'template_utility', 'c5100000-0000-0000-0000-000000000003');
select is(public.refund_credits('c5000000-0000-0000-0000-000000000001', 'c5100000-0000-0000-0000-000000000003'),
  1, 'a retry under the same message id gets its credit back too');
select public.spend_credits('c5000000-0000-0000-0000-000000000001', 1, 'template_utility', 'c5100000-0000-0000-0000-000000000003');
select is(public.refund_credits('c5000000-0000-0000-0000-000000000001', 'c5100000-0000-0000-0000-000000000003'),
  1, 'and so does every later retry');
select results_eq($$select * from public.credit_balance('c5000000-0000-0000-0000-000000000001')$$,
  $$values (3, 9, 12)$$, 'three failed attempts cost nothing');
select is(public.refund_credits('c5000000-0000-0000-0000-000000000001', 'c5100000-0000-0000-0000-000000000003'),
  0, 'with nothing spent since, a repeat refund still gives nothing');

-- A retry can draw from another bucket: message c51…04 first spends 4 (3 plan, 1 top-up) and is refunded; another
-- message then uses the plan credits, so the retry's 4 come from the top-up alone.
select public.spend_credits('c5000000-0000-0000-0000-000000000001', 4, 'ai_reply', 'c5100000-0000-0000-0000-000000000004');
select public.refund_credits('c5000000-0000-0000-0000-000000000001', 'c5100000-0000-0000-0000-000000000004');
select public.spend_credits('c5000000-0000-0000-0000-000000000001', 3, 'ai_reply', 'c5100000-0000-0000-0000-000000000005');
select public.spend_credits('c5000000-0000-0000-0000-000000000001', 4, 'ai_reply', 'c5100000-0000-0000-0000-000000000004');
select is(public.refund_credits('c5000000-0000-0000-0000-000000000001', 'c5100000-0000-0000-0000-000000000004'),
  4, 'the retry gets its 4 credits back');
select results_eq($$select * from public.credit_balance('c5000000-0000-0000-0000-000000000001')$$,
  $$values (0, 9, 9)$$, 'into the top-up bucket it spent from, not the plan bucket');

select * from finish();
rollback;
