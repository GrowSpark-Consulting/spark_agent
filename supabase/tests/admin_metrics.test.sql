-- admin_metrics (0051): the cost-per-credit and trial-to-paid inputs. Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

-- Real businesses P (paid) and F (free), an old one O (created 40 days ago), and a demo business D (d0000000-...).
insert into public.tenants (id, name, vertical, created_at) values
  ('0c100000-0000-0000-0000-00000000000a', 'Metrics P', 'test-pack', now() - interval '3 days'),
  ('0c100000-0000-0000-0000-00000000000b', 'Metrics F', 'test-pack', now() - interval '10 days'),
  ('0c100000-0000-0000-0000-00000000000c', 'Metrics O', 'test-pack', now() - interval '40 days'),
  ('d0000000-0000-0000-0000-0000000000dd', 'Demo D', 'test-pack', now() - interval '1 day');

insert into public.payments (tenant_id, kind, txnid, base_paise, gst_paise, amount_paise, status) values
  ('0c100000-0000-0000-0000-00000000000a', 'subscribe', 'metricsp1', 100, 18, 118, 'success'),
  ('0c100000-0000-0000-0000-00000000000b', 'subscribe', 'metricsf1', 100, 18, 118, 'failed'),
  ('0c100000-0000-0000-0000-00000000000c', 'subscribe', 'metricso1', 100, 18, 118, 'success'),
  ('d0000000-0000-0000-0000-0000000000dd', 'subscribe', 'metricsd1', 100, 18, 118, 'success');

-- Credits: 100 granted, then spends (ai_reply 40 two days ago, template 10 and an admin deduction 5 twenty days ago, 7 old, demo 50).
insert into public.credit_ledger (tenant_id, delta, reason, created_at) values
  ('0c100000-0000-0000-0000-00000000000a', 100, 'plan_grant', now() - interval '3 days'),
  ('0c100000-0000-0000-0000-00000000000a', -40, 'ai_reply', now() - interval '2 days'),
  ('0c100000-0000-0000-0000-00000000000a', -10, 'template_utility', now() - interval '20 days'),
  ('0c100000-0000-0000-0000-00000000000a', -5, 'admin', now() - interval '1 day'),
  ('0c100000-0000-0000-0000-00000000000a', -7, 'ai_reply', now() - interval '45 days'),
  ('d0000000-0000-0000-0000-0000000000dd', -50, 'ai_reply', now() - interval '1 day');

insert into public.ai_spend_daily (tenant_id, day, cost_usd, calls) values
  ('0c100000-0000-0000-0000-00000000000a', (now() at time zone 'Asia/Kolkata')::date - 2, 0.40, 8),
  ('0c100000-0000-0000-0000-00000000000a', (now() at time zone 'Asia/Kolkata')::date - 20, 0.10, 2),
  ('0c100000-0000-0000-0000-00000000000a', (now() at time zone 'Asia/Kolkata')::date - 45, 9.00, 99),
  ('d0000000-0000-0000-0000-0000000000dd', (now() at time zone 'Asia/Kolkata')::date - 1, 5.00, 50);

select results_eq($$select days from public.admin_metrics() order by days$$, $$values (7), (30)$$, 'one row for the last 7 days and one for the last 30');
select results_eq($$select credits_spent from public.admin_metrics() where days = 7$$, $$values (40::bigint)$$,
  '7 days: the reply credits only (the admin deduction, the old spend and the demo business are not usage)');
select results_eq($$select credits_spent from public.admin_metrics() where days = 30$$, $$values (50::bigint)$$, '30 days: replies and templates');
select results_eq($$select ai_cost_usd, ai_calls from public.admin_metrics() where days = 7$$, $$values (0.40::numeric, 8::bigint)$$, '7 days: the model cost and calls of the real business');
select results_eq($$select ai_cost_usd, ai_calls from public.admin_metrics() where days = 30$$, $$values (0.50::numeric, 10::bigint)$$, '30 days: two days of spend, not the 45-day-old one, not the demo');
select results_eq($$select trials_started, trials_paid from public.admin_metrics() where days = 7$$, $$values (1::bigint, 1::bigint)$$,
  '7 days: one real business started, and it paid (the demo business is left out)');
select results_eq($$select trials_started, trials_paid from public.admin_metrics() where days = 30$$, $$values (2::bigint, 1::bigint)$$,
  '30 days: two started, one paid (a failed payment is not paying; the 40-day-old business is outside)');
select results_eq($$select credits_spent, trials_started from public.admin_metrics(now() + interval '60 days') where days = 7$$, $$values (0::bigint, 0::bigint)$$, 'a window with nothing in it is zeros, not an error');
select ok(not has_function_privilege('authenticated', 'public.admin_metrics(timestamptz)', 'execute') and not has_function_privilege('anon', 'public.admin_metrics(timestamptz)', 'execute'),
  'the browser cannot call it');

select * from finish();
rollback;
