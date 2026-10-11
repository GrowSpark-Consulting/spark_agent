-- 0023_booking_resource_lock: holds and moves for one person (resource) take turns.
--
-- With several holds for the same time at the same moment, the bookings exclusion constraint still lets only one win,
-- but Postgres can report the losers as "deadlock detected" (40P01) instead of the exclusion violation (23P01): each
-- insert waits on another's not-yet-committed row while checking the constraint. Double booking stays impossible, but
-- a customer who loses the race would get a server error instead of "that time was just taken" (slot_taken).
-- scripts/db/hold-slot-concurrency.sh (CI) caught it.
--
-- Fix: hold_slot and reschedule_booking take a transaction-level advisory lock for the resource before they touch its
-- bookings, so holds for one person queue: the first commits, and every later one sees it and gets 23P01. Bookings
-- with no resource (callback, date_range, reservation) never clash and take no lock. The bodies are otherwise those of
-- 0015 unchanged.

create or replace function public.hold_slot(
  p_tenant_id uuid, p_lead_id uuid, p_kind text, p_start timestamptz, p_end timestamptz,
  p_resource_id uuid default null, p_service_id uuid default null, p_details jsonb default '{}',
  p_hold_minutes int default 10
)
returns public.bookings
language plpgsql
set search_path = ''
as $$
declare
  v_service_type text;
  v_resource_type text;
  v_row public.bookings;
begin
  if p_kind is null or p_kind not in ('slot','site_visit','field_visit','callback','date_range','reservation') then
    raise exception 'hold_slot: % is not a booking kind', p_kind;
  end if;
  if p_start is null or p_end is null or p_end <= p_start then
    raise exception 'hold_slot: a booking must end after it starts';
  end if;
  if p_start <= now() then
    raise exception 'hold_slot: that time has already passed';
  end if;
  if p_hold_minutes is null or p_hold_minutes not between 1 and 60 then
    raise exception 'hold_slot: a hold lasts 1 to 60 minutes';
  end if;
  if p_kind in ('slot','site_visit','field_visit') and (p_resource_id is null or p_service_id is null) then
    raise exception 'hold_slot: a % booking needs a resource and a service', p_kind;
  end if;

  if not exists (select 1 from public.leads l where l.id = p_lead_id and l.tenant_id = p_tenant_id) then
    raise exception 'hold_slot: lead not found' using errcode = 'PA404';
  end if;
  if p_service_id is not null then
    select s.resource_type into v_service_type
    from public.services s
    where s.id = p_service_id and s.tenant_id = p_tenant_id and s.active;
    if not found then
      raise exception 'hold_slot: service not found' using errcode = 'PA404';
    end if;
  end if;
  if p_resource_id is not null then
    select r.type into v_resource_type
    from public.resources r
    where r.id = p_resource_id and r.tenant_id = p_tenant_id and r.active;
    if not found then
      raise exception 'hold_slot: resource not found' using errcode = 'PA404';
    end if;
    if v_service_type is not null and v_resource_type <> v_service_type then
      raise exception 'hold_slot: that resource does not provide this service';
    end if;
    -- One hold or move per person at a time (see the top of this file).
    perform pg_advisory_xact_lock(hashtextextended('pakka:booking:' || p_resource_id::text, 0));
  end if;

  update public.bookings b
     set status = 'expired'
   where b.tenant_id = p_tenant_id and b.resource_id = p_resource_id and b.status = 'held'
     and b.hold_expires_at <= now()
     and tstzrange(b.start_at, b.end_at) && tstzrange(p_start, p_end);

  update public.bookings b
     set status = 'cancelled', details = b.details || '{"cancel_reason": "replaced"}'
   where b.tenant_id = p_tenant_id and b.lead_id = p_lead_id and b.status = 'held';

  insert into public.bookings
    (tenant_id, lead_id, resource_id, service_id, kind, start_at, end_at, status, hold_expires_at, details)
  values
    (p_tenant_id, p_lead_id, p_resource_id, p_service_id, p_kind, p_start, p_end, 'held',
     now() + make_interval(mins => p_hold_minutes), coalesce(p_details, '{}'))
  returning * into v_row;
  return v_row;
end
$$;

create or replace function public.reschedule_booking(
  p_tenant_id uuid, p_booking_id uuid, p_start timestamptz, p_end timestamptz, p_resource_id uuid default null
)
returns public.bookings
language plpgsql
set search_path = ''
as $$
declare
  v_old public.bookings;
  v_new public.bookings;
  v_resource_id uuid;
  v_resource_type text;
  v_service_type text;
begin
  if p_start is null or p_end is null or p_end <= p_start then
    raise exception 'reschedule_booking: a booking must end after it starts';
  end if;
  if p_start <= now() then
    raise exception 'reschedule_booking: that time has already passed';
  end if;

  select * into v_old
  from public.bookings b
  where b.id = p_booking_id and b.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'reschedule_booking: booking not found' using errcode = 'PA404';
  end if;
  if v_old.status <> 'confirmed' then
    raise exception 'reschedule_booking: only a confirmed booking can be moved (%)', v_old.status using errcode = 'PA409';
  end if;

  v_resource_id := coalesce(p_resource_id, v_old.resource_id);
  if p_resource_id is not null and p_resource_id is distinct from v_old.resource_id then
    select r.type into v_resource_type
    from public.resources r
    where r.id = p_resource_id and r.tenant_id = p_tenant_id and r.active;
    if not found then
      raise exception 'reschedule_booking: resource not found' using errcode = 'PA404';
    end if;
    select s.resource_type into v_service_type
    from public.services s
    where s.id = v_old.service_id and s.tenant_id = p_tenant_id;
    if v_service_type is not null and v_resource_type <> v_service_type then
      raise exception 'reschedule_booking: that resource does not provide this service';
    end if;
  end if;
  -- One hold or move per person at a time (see the top of this file).
  if v_resource_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('pakka:booking:' || v_resource_id::text, 0));
  end if;

  update public.bookings b
     set status = 'rescheduled'
   where b.id = p_booking_id and b.tenant_id = p_tenant_id;

  insert into public.bookings
    (tenant_id, lead_id, resource_id, service_id, kind, start_at, end_at, status, details)
  values
    (p_tenant_id, v_old.lead_id, v_resource_id, v_old.service_id, v_old.kind, p_start, p_end, 'confirmed',
     v_old.details || jsonb_build_object('rescheduled_from', v_old.id))
  returning * into v_new;
  return v_new;
end
$$;

-- Same signatures, so 0015's grants stand; repeated so nothing depends on that. Server only.
revoke execute on function public.hold_slot(uuid, uuid, text, timestamptz, timestamptz, uuid, uuid, jsonb, int) from public, anon, authenticated;
revoke execute on function public.reschedule_booking(uuid, uuid, timestamptz, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.hold_slot(uuid, uuid, text, timestamptz, timestamptz, uuid, uuid, jsonb, int) to service_role;
grant execute on function public.reschedule_booking(uuid, uuid, timestamptz, timestamptz, uuid) to service_role;
