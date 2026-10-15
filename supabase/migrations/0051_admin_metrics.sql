-- 0051_admin_metrics: the admin view's two business numbers (9-day plan, Day 8: "Cost-per-credit and trial-to-paid metrics").
-- admin_metrics(now) answers one row for the last 7 days and one for the last 30:
--   * credits_spent: credits taken for customer-facing sends in the window (ledger reasons ai_reply, template_utility,
--     template_marketing; an admin's own deduction is not usage). It is the gross draw: a refund of a failed send is a
--     grant and is not netted off.
--   * ai_cost_usd, ai_calls: the models' estimated cost over the window's India days (ai_spend_daily, 0044). That covers
--     every model call, including the ones that spend no credit (the lead card, a suggested reply), on purpose: it is what the
--     business's credits have to pay for. The server turns dollars into rupees (backend/src/billing/metrics.ts).
--   * trials_started, trials_paid: businesses created in the window, and how many of those have a successful `subscribe`
--     payment (by now, not only by the window's end).
-- The shared demo businesses (ids d0000000-...) and the isolation-test ones are left out of every count: they are ours.
-- Server only: the route checks platform_admins first.

create function public.admin_metrics(p_now timestamptz default now())
returns table (days int, credits_spent bigint, ai_cost_usd numeric, ai_calls bigint, trials_started bigint, trials_paid bigint)
language sql
stable
set search_path = ''
as $$
  select w.days,
         coalesce((select sum(-l.delta) from public.credit_ledger l
                    where l.delta < 0 and l.reason in ('ai_reply', 'template_utility', 'template_marketing')
                      and l.created_at >= p_now - make_interval(days => w.days)
                      and l.tenant_id::text not like 'd0000000-%'), 0)::bigint,
         coalesce((select sum(s.cost_usd) from public.ai_spend_daily s
                    where s.day > ((p_now at time zone 'Asia/Kolkata')::date - w.days)
                      and s.tenant_id::text not like 'd0000000-%'), 0),
         coalesce((select sum(s.calls) from public.ai_spend_daily s
                    where s.day > ((p_now at time zone 'Asia/Kolkata')::date - w.days)
                      and s.tenant_id::text not like 'd0000000-%'), 0)::bigint,
         (select count(*) from public.tenants t
           where t.created_at >= p_now - make_interval(days => w.days) and t.id::text not like 'd0000000-%'),
         (select count(*) from public.tenants t
           where t.created_at >= p_now - make_interval(days => w.days) and t.id::text not like 'd0000000-%'
             and exists (select 1 from public.payments p where p.tenant_id = t.id and p.kind = 'subscribe' and p.status = 'success'))
    from (values (7), (30)) as w(days)
   order by w.days;
$$;

revoke execute on function public.admin_metrics(timestamptz) from public, anon, authenticated;
grant execute on function public.admin_metrics(timestamptz) to service_role;
