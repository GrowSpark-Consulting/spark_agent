-- 0043_contact_deletion: a customer's request to delete their data (DPDP; docs/handover.md, "Consent": "Deletion requests
-- from the dashboard remove the contact's messages and lead data and log deleted"). An owner or admin acts on it from the
-- dashboard's Data & privacy settings (backend/src/consent/deletion.ts, POST /api/contacts/:id/deletion).
--
--   * Removed: the contact's chats (conversations, with their messages and handoffs) and its leads (with their bookings
--     and quotes). The business's knowledge-base gaps forget it as their last asker.
--   * Kept: the contact row, scrubbed (phone "deleted:<id>", no name, language or tags; deleted_at set), because its
--     consent_logs go with it (on delete cascade) and must survive: deletion_requested and deleted (source dashboard) are
--     written in the same transaction. audit_logs gets contact.deleted naming the member, with counts only.
--   * Refused (PA409) while the contact has an upcoming held or confirmed booking: the business cancels it first, which
--     tells the customer and takes the event off Google Calendar.
--   * A past booking's Google Calendar event carries the customer's name: the function returns those events and the
--     server removes them once the transaction has committed.
--   * Asking again changes nothing ('already_deleted'). If the same number writes again later, it is a new contact.
-- Server only.

alter table public.contacts add column deleted_at timestamptz;  -- its data was deleted on request (0043); the row is scrubbed

-- What a deletion would remove, for the dashboard's confirmation. Null row: no such contact in this business.
create function public.contact_deletion_preview(p_tenant_id uuid, p_contact_id uuid)
returns table (deleted_at timestamptz, conversations int, messages int, leads int, bookings int, upcoming_bookings int)
language sql
stable
set search_path = ''
as $$
  select
    c.deleted_at,
    (select count(*)::int from public.conversations v where v.tenant_id = p_tenant_id and v.contact_id = c.id),
    (select count(*)::int from public.messages m join public.conversations v on v.id = m.conversation_id
      where v.tenant_id = p_tenant_id and v.contact_id = c.id),
    (select count(*)::int from public.leads l where l.tenant_id = p_tenant_id and l.contact_id = c.id),
    (select count(*)::int from public.bookings b join public.leads l on l.id = b.lead_id
      where l.tenant_id = p_tenant_id and l.contact_id = c.id),
    (select count(*)::int from public.bookings b join public.leads l on l.id = b.lead_id
      where l.tenant_id = p_tenant_id and l.contact_id = c.id and b.status in ('held', 'confirmed') and b.end_at > now())
  from public.contacts c
  where c.tenant_id = p_tenant_id and c.id = p_contact_id;
$$;

create function public.delete_contact_data(p_tenant_id uuid, p_contact_id uuid, p_actor text)
returns table (outcome text, conversations int, messages int, leads int, bookings int, calendar_events jsonb)
language plpgsql
set search_path = ''
as $$
declare
  v_deleted_at timestamptz;
  v_conversations int;
  v_messages int;
  v_leads int;
  v_bookings int;
  v_events jsonb;
begin
  -- The row lock also holds back a message from the same number until the phone is scrubbed: it then makes a new contact.
  select c.deleted_at into v_deleted_at from public.contacts c where c.tenant_id = p_tenant_id and c.id = p_contact_id for update;
  if not found then
    raise exception 'delete_contact_data: no such contact in this business' using errcode = 'PA404';
  end if;
  if v_deleted_at is not null then
    return query select 'already_deleted'::text, 0, 0, 0, 0, '[]'::jsonb;
    return;
  end if;
  if exists (
    select 1 from public.bookings b join public.leads l on l.id = b.lead_id
    where l.tenant_id = p_tenant_id and l.contact_id = p_contact_id and b.status in ('held', 'confirmed') and b.end_at > now()
  ) then
    raise exception 'delete_contact_data: the contact has an upcoming booking' using errcode = 'PA409';
  end if;

  insert into public.consent_logs (tenant_id, contact_id, event, source) values (p_tenant_id, p_contact_id, 'deletion_requested', 'dashboard');

  select coalesce(jsonb_agg(jsonb_build_object('resource_id', b.resource_id, 'event_id', b.calendar_event_id)), '[]'::jsonb)
    into v_events
    from public.bookings b join public.leads l on l.id = b.lead_id
   where l.tenant_id = p_tenant_id and l.contact_id = p_contact_id and b.calendar_event_id is not null and b.resource_id is not null;
  select count(*)::int into v_messages
    from public.messages m join public.conversations v on v.id = m.conversation_id
   where v.tenant_id = p_tenant_id and v.contact_id = p_contact_id;
  select count(*)::int into v_bookings
    from public.bookings b join public.leads l on l.id = b.lead_id
   where l.tenant_id = p_tenant_id and l.contact_id = p_contact_id;

  delete from public.leads l where l.tenant_id = p_tenant_id and l.contact_id = p_contact_id;  -- with their bookings and quotes
  get diagnostics v_leads = row_count;
  delete from public.conversations v where v.tenant_id = p_tenant_id and v.contact_id = p_contact_id;  -- with messages and handoffs
  get diagnostics v_conversations = row_count;
  update public.kb_gaps g set last_contact_id = null where g.tenant_id = p_tenant_id and g.last_contact_id = p_contact_id;

  update public.contacts c
     set phone = 'deleted:' || c.id, name = null, language = null, tags = '{}', deleted_at = now()
   where c.id = p_contact_id;

  insert into public.consent_logs (tenant_id, contact_id, event, source) values (p_tenant_id, p_contact_id, 'deleted', 'dashboard');
  insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
  values (p_tenant_id, p_actor, 'contact.deleted', 'contact', p_contact_id,
          jsonb_build_object('conversations', v_conversations, 'messages', v_messages, 'leads', v_leads, 'bookings', v_bookings));

  return query select 'deleted'::text, v_conversations, v_messages, v_leads, v_bookings, v_events;
end;
$$;

revoke execute on function public.contact_deletion_preview(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.delete_contact_data(uuid, uuid, text) from public, anon, authenticated;
