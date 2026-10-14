-- 0044_ai_limits: rate limits and a daily AI spend cap per business (Production Blueprint: "rate limits per tenant and per
-- contact to stop spam and runaway costs; daily LLM spend cap per tenant"; 9-day plan, Day 7). backend/src/lib/ai-limits.ts.
--
--   * ai_spend_daily: what each business's model calls cost per day (India's date), recorded after every call from the
--     model's own estimate (LlmResult.costUsd). Server only.
--   * tenants.ai_daily_cap_usd: a platform admin's cap for one business; null takes the plan's default, a tenth of its
--     monthly credits at USD 0.02 a reply (monthly_credits x 0.002), at least USD 1. PLACEHOLDER until Raja decides.
--   * ai_limits(tenant, conversation): today's spend and cap, and the AI replies sent in the last hour to this chat and by
--     the whole business, for the pipeline's gate. The hourly limits themselves are in ai-limits.ts.
-- Server only.

create table public.ai_spend_daily (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  day date not null,                           -- in India (Asia/Kolkata)
  cost_usd numeric(12, 6) not null default 0,  -- the models' own estimates; a model with no price adds 0
  calls int not null default 0,
  primary key (tenant_id, day)
);
alter table public.ai_spend_daily enable row level security;  -- no policies: server only
revoke all on public.ai_spend_daily from anon, authenticated;

alter table public.tenants add column ai_daily_cap_usd numeric(10, 2) check (ai_daily_cap_usd is null or ai_daily_cap_usd >= 0);

create function public.record_ai_spend(p_tenant_id uuid, p_cost_usd numeric)
returns void
language sql
set search_path = ''
as $$
  insert into public.ai_spend_daily (tenant_id, day, cost_usd, calls)
  values (p_tenant_id, (now() at time zone 'Asia/Kolkata')::date, greatest(coalesce(p_cost_usd, 0), 0), 1)
  on conflict (tenant_id, day) do update
    set cost_usd = public.ai_spend_daily.cost_usd + excluded.cost_usd,
        calls = public.ai_spend_daily.calls + 1;
$$;

create function public.ai_limits(p_tenant_id uuid, p_conversation_id uuid default null)
returns table (spend_today_usd numeric, cap_usd numeric, contact_replies_hour int, tenant_replies_hour int)
language sql
stable
set search_path = ''
as $$
  select
    coalesce((select s.cost_usd from public.ai_spend_daily s
               where s.tenant_id = p_tenant_id and s.day = (now() at time zone 'Asia/Kolkata')::date), 0),
    coalesce(t.ai_daily_cap_usd, greatest(1.00, coalesce(p.monthly_credits, 0) * 0.002)),
    case when p_conversation_id is null then 0 else
      (select count(*)::int from public.messages m
        where m.conversation_id = p_conversation_id and m.tenant_id = p_tenant_id and m.sender = 'ai'
          and m.created_at > now() - interval '1 hour') end,
    (select count(*)::int from public.messages m
      where m.tenant_id = p_tenant_id and m.sender = 'ai' and m.created_at > now() - interval '1 hour')
  from public.tenants t
  left join public.plans p on p.key = t.plan_key
  where t.id = p_tenant_id;
$$;

revoke execute on function public.record_ai_spend(uuid, numeric) from public, anon, authenticated;
revoke execute on function public.ai_limits(uuid, uuid) from public, anon, authenticated;
