-- 0026_booking_actions: what the calendar's buttons do (9-day plan, Day 5: "Booking action routes (reschedule,
-- cancel, complete, no-show) emitting booking.changed"; docs/handover.md, route table).
--
-- 1. bookings.status_changed_at: when the status last changed, kept by a trigger, so the calendar can show when a
--    booking was confirmed or cancelled (Dev 3's regression rows BT-1 and BT-2). Existing rows take created_at.
-- 2. The staff actions, each in one transaction with its audit row, and who did it kept in details (<action>_by):
--    * complete_booking: a confirmed booking that has started becomes completed, and its lead moves to visited
--      (never back from won or lost);
--    * mark_booking_no_show: a confirmed booking that has started becomes no_show;
--    * staff_cancel_booking and staff_reschedule_booking: cancel_booking and reschedule_booking (0015, 0023) plus the
--      audit row and who did it.
--    A repeat of complete, no-show or cancel returns the booking unchanged and writes nothing. The API emits
--    booking.changed after each, so the reminder, post-visit, no-show and calendar jobs follow.
-- 3. bookings and leads join the Realtime publication, so the calendar and the leads board update by themselves
--    (Dev 3's RT-1 and RT-2). Realtime applies each subscriber's RLS, as for the inbox (0010).
-- Errors use the SQLSTATEs the API maps: PA404 not_found, PA409 conflict, P0001 validation_failed, 23P01 slot_taken.

-- 1. status_changed_at ---------------------------------------------------------------------------------------------

alter table public.bookings add column status_changed_at timestamptz;
update public.bookings set status_changed_at = created_at;
alter table public.bookings
  alter column status_changed_at set default now(),
  alter column status_changed_at set not null;

create function public.bookings_touch_status_changed_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;
  return new;
end
$$;

create trigger bookings_touch_status_changed_at
  before update of status on public.bookings
  for each row execute function public.bookings_touch_status_changed_at();

-- 2. Staff actions -------------------------------------------------------------------------------------------------

create function public.complete_booking(p_tenant_id uuid, p_booking_id uuid, p_actor text)
returns public.bookings
language plpgsql
set search_path = ''
as $$
declare
  v_row public.bookings;
begin
  if p_actor is null or p_actor = '' then
    raise exception 'complete_booking: an actor is required';
  end if;
  select * into v_row from public.bookings b where b.id = p_booking_id and b.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'complete_booking: booking not found' using errcode = 'PA404';
  end if;
  if v_row.status = 'completed' then
    return v_row;
  end if;
  if v_row.status <> 'confirmed' then
    raise exception 'complete_booking: a % booking cannot be marked visited', replace(v_row.status, '_', '-') using errcode = 'PA409';
  end if;
  if v_row.start_at > now() then
    raise exception 'complete_booking: this booking has not started yet' using errcode = 'PA409';
  end if;

  update public.bookings b
     set status = 'completed', details = b.details || jsonb_build_object('completed_by', p_actor)
   where b.id = p_booking_id and b.tenant_id = p_tenant_id
  returning * into v_row;
  update public.leads l
     set stage = 'visited'
   where l.id = v_row.lead_id and l.tenant_id = p_tenant_id
     and l.stage in ('new','engaged','qualified','booked','nurture','human');
  insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
  values (p_tenant_id, p_actor, 'booking.completed', 'booking', p_booking_id, jsonb_build_object('from', 'confirmed', 'to', 'completed'));
  return v_row;
end
$$;

create function public.mark_booking_no_show(p_tenant_id uuid, p_booking_id uuid, p_actor text)
returns public.bookings
language plpgsql
set search_path = ''
as $$
declare
  v_row public.bookings;
begin
  if p_actor is null or p_actor = '' then
    raise exception 'mark_booking_no_show: an actor is required';
  end if;
  select * into v_row from public.bookings b where b.id = p_booking_id and b.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'mark_booking_no_show: booking not found' using errcode = 'PA404';
  end if;
  if v_row.status = 'no_show' then
    return v_row;
  end if;
  if v_row.status <> 'confirmed' then
    raise exception 'mark_booking_no_show: a % booking cannot be marked no-show', replace(v_row.status, '_', '-') using errcode = 'PA409';
  end if;
  if v_row.start_at > now() then
    raise exception 'mark_booking_no_show: this booking has not started yet' using errcode = 'PA409';
  end if;

  update public.bookings b
     set status = 'no_show', details = b.details || jsonb_build_object('no_show_by', p_actor)
   where b.id = p_booking_id and b.tenant_id = p_tenant_id
  returning * into v_row;
  insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
  values (p_tenant_id, p_actor, 'booking.no_show', 'booking', p_booking_id, jsonb_build_object('from', 'confirmed', 'to', 'no_show'));
  return v_row;
end
$$;

create function public.staff_cancel_booking(p_tenant_id uuid, p_booking_id uuid, p_reason text, p_actor text)
returns public.bookings
language plpgsql
set search_path = ''
as $$
declare
  v_before text;
  v_row public.bookings;
begin
  if p_actor is null or p_actor = '' then
    raise exception 'staff_cancel_booking: an actor is required';
  end if;
  select b.status into v_before from public.bookings b where b.id = p_booking_id and b.tenant_id = p_tenant_id for update;
  v_row := public.cancel_booking(p_tenant_id, p_booking_id, p_reason);  -- not found, wrong state and a repeat: as cancel_booking
  if v_before = 'cancelled' then
    return v_row;
  end if;

  update public.bookings b
     set details = b.details || jsonb_build_object('cancelled_by', p_actor)
   where b.id = p_booking_id and b.tenant_id = p_tenant_id
  returning * into v_row;
  insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
  values (p_tenant_id, p_actor, 'booking.cancelled', 'booking', p_booking_id,
          jsonb_build_object('from', v_before, 'to', 'cancelled', 'reason', p_reason));
  return v_row;
end
$$;

create function public.staff_reschedule_booking(
  p_tenant_id uuid, p_booking_id uuid, p_start timestamptz, p_end timestamptz, p_resource_id uuid, p_actor text
)
returns public.bookings
language plpgsql
set search_path = ''
as $$
declare
  v_new public.bookings;
begin
  if p_actor is null or p_actor = '' then
    raise exception 'staff_reschedule_booking: an actor is required';
  end if;
  v_new := public.reschedule_booking(p_tenant_id, p_booking_id, p_start, p_end, p_resource_id);

  update public.bookings b
     set details = b.details || jsonb_build_object('rescheduled_by', p_actor)
   where b.id = v_new.id and b.tenant_id = p_tenant_id
  returning * into v_new;
  insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
  values (p_tenant_id, p_actor, 'booking.rescheduled', 'booking', p_booking_id,
          jsonb_build_object('to_booking', v_new.id, 'start_at', v_new.start_at, 'end_at', v_new.end_at, 'resource_id', v_new.resource_id));
  return v_new;
end
$$;

-- Server only. Supabase grants new functions to anon and authenticated by default.
revoke execute on function public.bookings_touch_status_changed_at() from public, anon, authenticated;
revoke execute on function public.complete_booking(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.mark_booking_no_show(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.staff_cancel_booking(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.staff_reschedule_booking(uuid, uuid, timestamptz, timestamptz, uuid, text) from public, anon, authenticated;
grant execute on function public.complete_booking(uuid, uuid, text) to service_role;
grant execute on function public.mark_booking_no_show(uuid, uuid, text) to service_role;
grant execute on function public.staff_cancel_booking(uuid, uuid, text, text) to service_role;
grant execute on function public.staff_reschedule_booking(uuid, uuid, timestamptz, timestamptz, uuid, text) to service_role;

-- 3. Realtime ------------------------------------------------------------------------------------------------------

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  -- A publication FOR ALL TABLES already includes them (and refuses ADD TABLE).
  if (select puballtables from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  foreach t in array array['bookings', 'leads'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;
