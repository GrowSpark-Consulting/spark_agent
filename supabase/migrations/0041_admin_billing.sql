-- 0041_admin_billing: what the internal admin panel needs from billing (docs/handover.md, "Admin (internal): all tenants
-- with status and credits, extend trial, grant credits, edit plans and features"; 9-day plan, Day 7; Dev 3's panel calls
-- /api/admin/*, backend/src/admin/billing-admin.ts). Server only: the routes check platform_admins (0016) first, and each
-- change and its audit row (actor admin:<user id>) happen in one transaction.
--
--   * admin_tenants(): every business with its status, plan, live credits, trial end, live subscription, the setup-fee
--     flag (an assisted onboarding call is owed), members and its own active numbers. Newest first.
--   * admin_extend_trial(tenant, days, actor): 1 to 30 days more, counted from the later of the trial's end and now; a
--     trial paused at its end becomes a trial again. Only a business still on the trial plan with no live subscription
--     (PA409 otherwise). The TRIAL code follows the new end, and the trial notices start over (only the latest due one
--     goes, 0039). Trial credits are not extended: they expire with the original end, so grant credits as well.
--   * admin_grant_credits(tenant, amount, expires_at, request_id, note, actor): grant_credits(..., 'admin', ...) and its
--     audit row. request_id, when given, makes a repeat (a double click) grant nothing more.
--   * admin_update_plan(key, ...): null fields stay as they are. A price change is refused while any business has a live
--     subscription on the plan, or a downgrade to it scheduled (PA409): their auto-debit mandates were approved for the
--     old amount, so renewals at a new price would fail. feature_keys must all be existing features. The trial stays free.
--   * admin_update_feature(key, name, description, default_on): the catalogue entry.
--   * admin_refund_candidates(): payments settle_payment kept but flagged for a refund (payment.needs_refund, 0036, 0038):
--     paid twice, or for a plan that was no longer the business's. Refunds themselves are done in PayU's dashboard.

create function public.admin_tenants()
returns table (
  tenant_id uuid, name text, vertical text, status text, plan_key text, trial_ends_at timestamptz, created_at timestamptz,
  setup_call_paid_at timestamptz, credits int, subscription_status text, billing_cycle text, current_period_end timestamptz,
  members int, active_numbers int
)
language sql stable
set search_path = ''
as $$
  select t.id, t.name, t.vertical, t.status, t.plan_key, t.trial_ends_at, t.created_at, t.setup_call_paid_at,
         (select b.total from public.credit_balance(t.id) b),
         s.status, s.billing_cycle, s.current_period_end,
         (select count(*)::int from public.memberships m where m.tenant_id = t.id),
         (select count(*)::int from public.whatsapp_connections w
           where w.tenant_id = t.id and w.status = 'active' and w.method <> 'platform')
  from public.tenants t
  left join lateral (
    select sub.status, sub.billing_cycle, sub.current_period_end
    from public.subscriptions sub
    where sub.tenant_id = t.id and sub.status in ('active', 'past_due')
    limit 1
  ) s on true
  order by t.created_at desc
$$;

create function public.admin_extend_trial(p_tenant_id uuid, p_days int, p_actor text)
returns timestamptz
language plpgsql
set search_path = ''
as $$
declare
  t public.tenants;
  v_end timestamptz;
begin
  if p_days is null or p_days < 1 or p_days > 30 then
    raise exception 'admin_extend_trial: extend by 1 to 30 days' using errcode = 'P0001';
  end if;
  if p_actor is null or p_actor !~ '^admin:' then
    raise exception 'admin_extend_trial: the actor must be a platform admin' using errcode = 'P0001';
  end if;
  select * into t from public.tenants tn where tn.id = p_tenant_id for no key update;
  if not found then
    raise exception 'admin_extend_trial: unknown business' using errcode = 'PA404';
  end if;
  if t.plan_key <> 'trial' or t.status not in ('trial', 'paused')
     or exists (select 1 from public.subscriptions s where s.tenant_id = t.id and s.status in ('active', 'past_due')) then
    raise exception 'admin_extend_trial: the business is not on a trial' using errcode = 'PA409';
  end if;

  v_end := greatest(coalesce(t.trial_ends_at, now()), now()) + make_interval(days => p_days);
  update public.tenants tn set status = 'trial', trial_ends_at = v_end where tn.id = t.id;
  update public.route_codes r set expires_at = v_end where r.tenant_id = t.id and r.kind = 'trial';
  delete from public.trial_notices n where n.tenant_id = t.id and n.day > 0;
  insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
  values (t.id, p_actor, 'tenant.trial_extended', 'tenant', t.id,
          jsonb_build_object('from', t.trial_ends_at, 'to', v_end, 'days', p_days, 'was_paused', t.status = 'paused'));
  return v_end;
end
$$;

create function public.admin_grant_credits(
  p_tenant_id uuid, p_amount int, p_expires_at timestamptz, p_request_id uuid, p_note text, p_actor text
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_granted boolean;
begin
  if p_amount is null or p_amount < 1 or p_amount > 100000 then
    raise exception 'admin_grant_credits: grant 1 to 100,000 credits' using errcode = 'P0001';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'admin_grant_credits: the expiry must be in the future' using errcode = 'P0001';
  end if;
  if p_actor is null or p_actor !~ '^admin:' then
    raise exception 'admin_grant_credits: the actor must be a platform admin' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.tenants t where t.id = p_tenant_id) then
    raise exception 'admin_grant_credits: unknown business' using errcode = 'PA404';
  end if;
  v_granted := public.grant_credits(p_tenant_id, p_amount, 'admin', p_request_id, p_expires_at);
  if v_granted then
    insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
    values (p_tenant_id, p_actor, 'credits.granted', 'tenant', p_tenant_id,
            jsonb_build_object('amount', p_amount, 'expires_at', p_expires_at, 'note', left(nullif(btrim(p_note), ''), 200)));
  end if;
  return v_granted;
end
$$;

create function public.admin_update_plan(
  p_key text, p_name text, p_price_inr int, p_monthly_credits int, p_seats int, p_whatsapp_numbers int,
  p_feature_keys text[], p_actor text
)
returns setof public.plans
language plpgsql
set search_path = ''
as $$
declare
  p public.plans;
  v public.plans;
  v_unknown text;
begin
  if p_actor is null or p_actor !~ '^admin:' then
    raise exception 'admin_update_plan: the actor must be a platform admin' using errcode = 'P0001';
  end if;
  select * into p from public.plans pl where pl.key = p_key for update;
  if not found then
    raise exception 'admin_update_plan: unknown plan' using errcode = 'PA404';
  end if;
  if p_name is not null and (btrim(p_name) = '' or length(p_name) > 60) then
    raise exception 'admin_update_plan: a name of 1 to 60 characters' using errcode = 'P0001';
  end if;
  if coalesce(p_price_inr, 0) < 0 or coalesce(p_monthly_credits, 1) < 1 or coalesce(p_seats, 1) < 1 or coalesce(p_whatsapp_numbers, 1) < 1 then
    raise exception 'admin_update_plan: prices are 0 or more, credits, seats and numbers 1 or more' using errcode = 'P0001';
  end if;
  if p_price_inr is not null and p_price_inr <> p.price_inr then
    if p.key = 'trial' then
      raise exception 'admin_update_plan: the trial is free' using errcode = 'P0001';
    end if;
    if exists (
      select 1 from public.subscriptions s
      where (s.plan_key = p.key and s.status in ('active', 'past_due')) or (s.next_plan_key = p.key and s.status in ('active', 'past_due'))
    ) then
      raise exception 'admin_update_plan: businesses are subscribed at this price' using errcode = 'PA409';
    end if;
  end if;
  if p_feature_keys is not null then
    select k into v_unknown from unnest(p_feature_keys) k where not exists (select 1 from public.features f where f.key = k) limit 1;
    if v_unknown is not null then
      raise exception 'admin_update_plan: % is not a feature', v_unknown using errcode = 'P0001';
    end if;
  end if;

  update public.plans pl
     set name = coalesce(btrim(p_name), pl.name),
         price_inr = coalesce(p_price_inr, pl.price_inr),
         monthly_credits = coalesce(p_monthly_credits, pl.monthly_credits),
         seats = coalesce(p_seats, pl.seats),
         whatsapp_numbers = coalesce(p_whatsapp_numbers, pl.whatsapp_numbers),
         feature_keys = coalesce(p_feature_keys, pl.feature_keys)
   where pl.key = p.key
  returning * into v;
  insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
  values (null, p_actor, 'plan.updated', 'plan', null,
          jsonb_build_object('key', p.key, 'before', to_jsonb(p), 'after', to_jsonb(v)));
  return next v;
end
$$;

create function public.admin_update_feature(p_key text, p_name text, p_description text, p_default_on boolean, p_actor text)
returns setof public.features
language plpgsql
set search_path = ''
as $$
declare
  f public.features;
  v public.features;
begin
  if p_actor is null or p_actor !~ '^admin:' then
    raise exception 'admin_update_feature: the actor must be a platform admin' using errcode = 'P0001';
  end if;
  select * into f from public.features ft where ft.key = p_key for update;
  if not found then
    raise exception 'admin_update_feature: unknown feature' using errcode = 'PA404';
  end if;
  if (p_name is not null and (btrim(p_name) = '' or length(p_name) > 80))
     or (p_description is not null and (btrim(p_description) = '' or length(p_description) > 300)) then
    raise exception 'admin_update_feature: a name of 1 to 80 characters and a description of 1 to 300' using errcode = 'P0001';
  end if;
  update public.features ft
     set name = coalesce(btrim(p_name), ft.name),
         description = coalesce(btrim(p_description), ft.description),
         default_on = coalesce(p_default_on, ft.default_on)
   where ft.key = f.key
  returning * into v;
  insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
  values (null, p_actor, 'feature.updated', 'feature', null,
          jsonb_build_object('key', f.key, 'before', to_jsonb(f), 'after', to_jsonb(v)));
  return next v;
end
$$;

create function public.admin_refund_candidates()
returns table (
  payment_id uuid, tenant_id uuid, tenant_name text, kind text, amount_paise int, provider_payment_id text,
  method text, paid_at timestamptz, flagged_at timestamptz
)
language sql stable
set search_path = ''
as $$
  select p.id, p.tenant_id, t.name, p.kind, p.amount_paise, p.provider_payment_id, p.method, p.settled_at, a.created_at
  from public.audit_logs a
  join public.payments p on p.id = a.entity_id
  join public.tenants t on t.id = p.tenant_id
  where a.action = 'payment.needs_refund' and a.entity = 'payment'
  order by a.created_at desc
$$;

revoke execute on function public.admin_tenants() from public, anon, authenticated;
revoke execute on function public.admin_extend_trial(uuid, int, text) from public, anon, authenticated;
revoke execute on function public.admin_grant_credits(uuid, int, timestamptz, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.admin_update_plan(text, text, int, int, int, int, text[], text) from public, anon, authenticated;
revoke execute on function public.admin_update_feature(text, text, text, boolean, text) from public, anon, authenticated;
revoke execute on function public.admin_refund_candidates() from public, anon, authenticated;
grant execute on function public.admin_tenants() to service_role;
grant execute on function public.admin_extend_trial(uuid, int, text) to service_role;
grant execute on function public.admin_grant_credits(uuid, int, timestamptz, uuid, text, text) to service_role;
grant execute on function public.admin_update_plan(text, text, int, int, int, int, text[], text) to service_role;
grant execute on function public.admin_update_feature(text, text, text, boolean, text) to service_role;
grant execute on function public.admin_refund_candidates() to service_role;
