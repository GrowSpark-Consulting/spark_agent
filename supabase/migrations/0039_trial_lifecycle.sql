-- 0039_trial_lifecycle: the 7-day trial's messages and its end (docs/handover.md, module 8 and the trial-lifecycle job:
-- "Day 0, 3, 5, 6, 7 messages; pauses the tenant at the end"; backend/src/billing/trial-lifecycle.ts).
--
-- Messages go to the business's owners as account notices (notify.send account_notice, free; 0038's stack). Day 0
-- welcomes them when the trial starts (tenant.trial_started). The others fall due relative to trial_ends_at, so a trial
-- that is extended moves its messages too: day 3 four days before the end (how the assistant did so far), day 5 two days
-- before (a plan suggestion), day 6 one day before (it ends tomorrow), day 7 once the trial has ended and the business is
-- paused (choose a plan).
--
--   * trial_notices: one row per business and day, claimed before the message is sent, so a repeat run or two runs at
--     once never send it twice. claimed_by names the job run: a retry of that run may send again (notify.send's own
--     idempotency key then drops a repeat), another run may not. Server only: RLS on, no policies, no browser grants.
--   * trial_notices_due(now): for each trial, the latest day now due and not yet claimed, and nothing earlier once a later
--     day is out: a trial the job meets late (one that started before this job existed) gets one message, not a burst.
--   * claim_trial_notice(tenant, day, run) → claimed / already / superseded / not_eligible. It locks the business and
--     checks again: days 0 to 6 need a trial that has not ended; day 7 a business paused at the end of its trial (plan
--     still 'trial') within 3 days of that end; none goes to a business with a live subscription (active or past_due),
--     so one that paid or upgraded is never told its trial is ending.
--   * pause_expired_trials(now): every trial whose end has passed, with no live subscription and no subscription payment
--     still pending at PayU, becomes paused (the inbox stays readable; choosing a plan in Billing makes it active again,
--     settle_payment). A business being paid for at that moment is skipped (its row is locked) and seen again on the next
--     run, by which time it is active. Each pause is audited as tenant.trial_ended.

create table public.trial_notices (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  day smallint not null check (day in (0, 3, 5, 6, 7)),
  claimed_by text not null check (btrim(claimed_by) <> ''),
  claimed_at timestamptz not null default now(),
  primary key (tenant_id, day)
);

alter table public.trial_notices enable row level security;
revoke all on public.trial_notices from anon, authenticated;

create function public.trial_notices_due(p_now timestamptz default now())
returns table (tenant_id uuid, day smallint)
language sql stable
set search_path = ''
as $$
  select t.id, d.day
  from public.tenants t
  cross join lateral (
    select (case
      when t.status = 'trial' and p_now < t.trial_ends_at and p_now >= t.trial_ends_at - interval '1 day' then 6
      when t.status = 'trial' and p_now < t.trial_ends_at and p_now >= t.trial_ends_at - interval '2 days' then 5
      when t.status = 'trial' and p_now < t.trial_ends_at and p_now >= t.trial_ends_at - interval '4 days' then 3
      when t.status = 'paused' and t.plan_key = 'trial' and t.trial_ends_at <= p_now
           and t.trial_ends_at > p_now - interval '3 days' then 7
    end)::smallint as day
  ) d
  where t.trial_ends_at is not null and d.day is not null
    and not exists (
      select 1 from public.subscriptions s where s.tenant_id = t.id and s.status in ('active', 'past_due'))
    and not exists (
      select 1 from public.trial_notices n where n.tenant_id = t.id and n.day >= d.day)
  order by t.trial_ends_at
$$;

create function public.claim_trial_notice(p_tenant_id uuid, p_day int, p_claimed_by text, p_now timestamptz default now())
returns text
language plpgsql
set search_path = ''
as $$
declare
  t public.tenants;
  v_eligible boolean;
  v_by text;
begin
  if p_day is null or p_day not in (0, 3, 5, 6, 7) then
    raise exception 'claim_trial_notice: % is not a trial notice day', p_day using errcode = 'P0001';
  end if;
  if p_claimed_by is null or btrim(p_claimed_by) = '' then
    raise exception 'claim_trial_notice: the claiming run is required' using errcode = 'P0001';
  end if;
  -- The same lock settle_payment takes before it activates a plan: a payment in flight finishes first.
  select * into t from public.tenants tn where tn.id = p_tenant_id for no key update;
  if not found or t.trial_ends_at is null then
    return 'not_eligible';
  end if;
  v_eligible := not exists (
      select 1 from public.subscriptions s where s.tenant_id = t.id and s.status in ('active', 'past_due'))
    and case
      when p_day = 7 then t.status = 'paused' and t.plan_key = 'trial' and t.trial_ends_at <= p_now
                          and t.trial_ends_at > p_now - interval '3 days'
      else t.status = 'trial' and p_now < t.trial_ends_at
    end;
  if not v_eligible then
    return 'not_eligible';
  end if;
  if exists (select 1 from public.trial_notices n where n.tenant_id = t.id and n.day > p_day) then
    return 'superseded';
  end if;

  insert into public.trial_notices (tenant_id, day, claimed_by) values (t.id, p_day, p_claimed_by)
  on conflict do nothing;
  if found then
    return 'claimed';
  end if;
  select n.claimed_by into v_by from public.trial_notices n where n.tenant_id = t.id and n.day = p_day;
  return case when v_by = p_claimed_by then 'claimed' else 'already' end;
end
$$;

create function public.pause_expired_trials(p_now timestamptz default now())
returns table (tenant_id uuid)
language plpgsql
set search_path = ''
as $$
declare
  r record;
begin
  for r in
    select t.id, t.trial_ends_at
    from public.tenants t
    where t.status = 'trial' and t.trial_ends_at is not null and t.trial_ends_at <= p_now
      and not exists (
        select 1 from public.subscriptions s where s.tenant_id = t.id and s.status in ('active', 'past_due'))
      and not exists (
        select 1 from public.payments pm where pm.tenant_id = t.id and pm.kind = 'subscribe' and pm.status = 'pending')
    order by t.trial_ends_at
    for update of t skip locked
  loop
    -- Checked again on the locked row: a plan paid for since the scan has made it active.
    update public.tenants tn set status = 'paused' where tn.id = r.id and tn.status = 'trial';
    continue when not found;
    insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
    values (r.id, 'system', 'tenant.trial_ended', 'tenant', r.id, jsonb_build_object('trial_ends_at', r.trial_ends_at));
    tenant_id := r.id;
    return next;
  end loop;
end
$$;

revoke execute on function public.trial_notices_due(timestamptz) from public, anon, authenticated;
revoke execute on function public.claim_trial_notice(uuid, int, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.pause_expired_trials(timestamptz) from public, anon, authenticated;
grant execute on function public.trial_notices_due(timestamptz) to service_role;
grant execute on function public.claim_trial_notice(uuid, int, text, timestamptz) to service_role;
grant execute on function public.pause_expired_trials(timestamptz) to service_role;
