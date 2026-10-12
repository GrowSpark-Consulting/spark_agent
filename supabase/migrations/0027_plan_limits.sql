-- 0027_plan_limits: a business stays within its plan's team seats and WhatsApp numbers (9-day plan, Day 5: "Plan limits
-- enforced in the API: seats and WhatsApp numbers (Starter and Growth 1 number, Pro 3)"; plans.seats and
-- plans.whatsapp_numbers, supabase/seed/plans.sql).
--
-- The API checks first, so the member gets a clear answer before anything is sent to Meta (backend/src/billing/
-- plan-limits.ts). These triggers are the last word for every path, including two requests at the same moment: each
-- takes the business's row lock before counting. They run after the row is written (and has passed the table's own
-- checks), count it with the others, and undo the statement when the plan is exceeded. The lock is FOR NO KEY UPDATE:
-- the new row's foreign key already holds a key-share lock on the business, which FOR UPDATE would wait on (two racing
-- inserts would deadlock), while NO KEY UPDATE still makes the counts take turns.
--   * memberships: a new member is refused when the business already has as many as its plan's seats (PA413, the
--     API's seat_limit). Pro's 999 means unlimited.
--   * whatsapp_connections: a number that starts counting (a new row, or a disconnected one coming back) is refused when
--     the business already has as many as its plan's numbers (PA403, the API's plan_required). Every connection that
--     is not disconnected counts, a failed one included (disconnect it to make room); our own platform numbers never
--     count.
-- A business over its limit after a downgrade keeps what it has; only additions are refused.

create function public.enforce_seat_limit() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_seats int;
  v_plan text;
  v_used int;
begin
  if tg_op = 'UPDATE' and new.tenant_id = old.tenant_id then
    return null;
  end if;
  select p.seats, p.name into v_seats, v_plan
  from public.tenants t join public.plans p on p.key = t.plan_key
  where t.id = new.tenant_id
  for no key update of t;
  if not found then
    return null;  -- the foreign key refuses an unknown business
  end if;
  select count(*) into v_used from public.memberships m where m.tenant_id = new.tenant_id;
  if v_used > v_seats then
    raise exception 'seat_limit: the % plan includes % team members', v_plan, v_seats using errcode = 'PA413';
  end if;
  return null;
end
$$;

create trigger memberships_seat_limit
  after insert or update of tenant_id on public.memberships
  for each row execute function public.enforce_seat_limit();

create function public.enforce_whatsapp_number_limit() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_limit int;
  v_plan text;
  v_used int;
begin
  if new.method = 'platform' or new.status = 'disconnected' then
    return null;
  end if;
  -- Already counted: the same business's number moving between pending, validating, active and failed.
  if tg_op = 'UPDATE' and old.status <> 'disconnected' and old.method <> 'platform' and old.tenant_id = new.tenant_id then
    return null;
  end if;
  select p.whatsapp_numbers, p.name into v_limit, v_plan
  from public.tenants t join public.plans p on p.key = t.plan_key
  where t.id = new.tenant_id
  for no key update of t;
  if not found then
    return null;
  end if;
  select count(*) into v_used
  from public.whatsapp_connections c
  where c.tenant_id = new.tenant_id and c.method <> 'platform' and c.status <> 'disconnected';
  if v_used > v_limit then
    raise exception 'whatsapp_number_limit: the % plan includes % WhatsApp numbers', v_plan, v_limit using errcode = 'PA403';
  end if;
  return null;
end
$$;

create trigger whatsapp_connections_number_limit
  after insert or update of status, tenant_id, method on public.whatsapp_connections
  for each row execute function public.enforce_whatsapp_number_limit();

-- Trigger functions only. Supabase grants new functions to anon and authenticated by default.
revoke execute on function public.enforce_seat_limit() from public, anon, authenticated;
revoke execute on function public.enforce_whatsapp_number_limit() from public, anon, authenticated;
