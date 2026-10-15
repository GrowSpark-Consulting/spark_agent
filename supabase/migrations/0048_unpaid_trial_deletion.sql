-- 0048_unpaid_trial_deletion: a business's data is deleted 30 days after its trial ended unpaid (9-day plan, Day 7: "Delete a tenant's
-- data 30 days after an unpaid trial ends"), and both deletions remove the media files too (backend/src/billing/unpaid-trials.ts,
-- backend/src/consent/deletion.ts, backend/src/lib/storage.ts).
--
--   * unpaid_trials_for_cleanup(now): the businesses still on the trial plan, never paid (no successful payment, no live, past-due or
--     pending subscription), whose trial ended 23 days ago or more. `due` is true from day 30: those are deleted; the others get one
--     warning, 7 days before (the server sends it, once per owner).
--   * delete_unpaid_trial(tenant, now): checks it all again with the business locked, writes audit_logs tenant.deleted (counts only;
--     audit_logs has no foreign key to tenants, so the row survives) and deletes the business: every table that names it goes with it
--     (on delete cascade), except trial_phones, whose tenant_id is set to null so the same number still cannot take a second free trial.
--     'gone' when the business no longer exists (a retry after it was deleted), 'not_eligible' when it paid or its trial was extended.
--   * media_object_names(tenant, conversations?): the paths of a business's files in message-media (all of them, or those of some
--     chats), for the server to remove through the Storage API: deleting rows does not touch storage, and storage refuses a direct
--     DELETE. Read from storage.objects by the path's own folders, so it still finds them after the rows are gone.
--   * delete_contact_data (0043) now also returns the ids of the chats it deleted, so the server removes their files.
-- Kept on purpose: the members' own logins (auth.users: a person may belong to another business, or start again), and events the
-- business's own Google Calendar holds (its calendar; our copy of its tokens goes with it). Server only.

create function public.unpaid_trials_for_cleanup(p_now timestamptz default now())
returns table (tenant_id uuid, trial_ended_at timestamptz, deletes_on timestamptz, due boolean)
language sql
stable
set search_path = ''
as $$
  select t.id, t.trial_ends_at, t.trial_ends_at + interval '30 days', t.trial_ends_at + interval '30 days' <= p_now
  from public.tenants t
  where t.plan_key = 'trial'
    and t.status <> 'active'
    and t.trial_ends_at is not null
    and t.trial_ends_at + interval '23 days' <= p_now
    and not exists (select 1 from public.payments p where p.tenant_id = t.id and p.status = 'success')
    and not exists (select 1 from public.subscriptions s where s.tenant_id = t.id and s.status in ('active', 'past_due', 'pending'))
  order by t.trial_ends_at, t.id;
$$;

create function public.delete_unpaid_trial(p_tenant_id uuid, p_now timestamptz default now())
returns table (outcome text, counts jsonb)
language plpgsql
set search_path = ''
as $$
declare
  t record;
  v_counts jsonb;
begin
  select tn.id, tn.plan_key, tn.status, tn.trial_ends_at into t from public.tenants tn where tn.id = p_tenant_id for update;
  if not found then
    return query select 'gone'::text, '{}'::jsonb;
    return;
  end if;
  if t.plan_key <> 'trial' or t.status = 'active' or t.trial_ends_at is null or t.trial_ends_at + interval '30 days' > p_now
     or exists (select 1 from public.payments p where p.tenant_id = p_tenant_id and p.status = 'success')
     or exists (select 1 from public.subscriptions s where s.tenant_id = p_tenant_id and s.status in ('active', 'past_due', 'pending')) then
    return query select 'not_eligible'::text, '{}'::jsonb;
    return;
  end if;

  v_counts := jsonb_build_object(
    'members', (select count(*) from public.memberships m where m.tenant_id = p_tenant_id),
    'contacts', (select count(*) from public.contacts c where c.tenant_id = p_tenant_id),
    'conversations', (select count(*) from public.conversations v where v.tenant_id = p_tenant_id),
    'messages', (select count(*) from public.messages m where m.tenant_id = p_tenant_id),
    'leads', (select count(*) from public.leads l where l.tenant_id = p_tenant_id),
    'bookings', (select count(*) from public.bookings b where b.tenant_id = p_tenant_id),
    'kb_documents', (select count(*) from public.kb_documents d where d.tenant_id = p_tenant_id)
  );
  insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
  values (p_tenant_id, 'system', 'tenant.deleted', 'tenant', p_tenant_id,
          jsonb_build_object('reason', 'unpaid_trial', 'trial_ended_at', t.trial_ends_at, 'counts', v_counts));

  delete from public.tenants tn where tn.id = p_tenant_id;  -- everything that names it, by on delete cascade; trial_phones keeps the number
  return query select 'deleted'::text, v_counts;
end;
$$;

create function public.media_object_names(p_tenant_id uuid, p_conversation_ids uuid[] default null)
returns setof text
language sql
stable
set search_path = ''
as $$
  select o.name
  from storage.objects o
  where o.bucket_id = 'message-media'
    and split_part(o.name, '/', 1) = p_tenant_id::text
    and (p_conversation_ids is null or split_part(o.name, '/', 2) = any (select c::text from unnest(p_conversation_ids) c))
  order by o.name;
$$;

-- delete_contact_data (0043) as it was, and it also returns the ids of the chats it deleted.
drop function public.delete_contact_data(uuid, uuid, text);
create function public.delete_contact_data(p_tenant_id uuid, p_contact_id uuid, p_actor text)
returns table (outcome text, conversations int, messages int, leads int, bookings int, calendar_events jsonb, conversation_ids uuid[])
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
  v_conversation_ids uuid[];
begin
  -- The row lock also holds back a message from the same number until the phone is scrubbed: it then makes a new contact.
  select c.deleted_at into v_deleted_at from public.contacts c where c.tenant_id = p_tenant_id and c.id = p_contact_id for update;
  if not found then
    raise exception 'delete_contact_data: no such contact in this business' using errcode = 'PA404';
  end if;
  if v_deleted_at is not null then
    return query select 'already_deleted'::text, 0, 0, 0, 0, '[]'::jsonb, '{}'::uuid[];
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
  with gone as (
    delete from public.conversations v where v.tenant_id = p_tenant_id and v.contact_id = p_contact_id returning v.id  -- with messages and handoffs
  )
  select count(*)::int, coalesce(array_agg(gone.id order by gone.id), '{}') into v_conversations, v_conversation_ids from gone;
  update public.kb_gaps g set last_contact_id = null where g.tenant_id = p_tenant_id and g.last_contact_id = p_contact_id;

  update public.contacts c
     set phone = 'deleted:' || c.id, name = null, language = null, tags = '{}', deleted_at = now()
   where c.id = p_contact_id;

  insert into public.consent_logs (tenant_id, contact_id, event, source) values (p_tenant_id, p_contact_id, 'deleted', 'dashboard');
  insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
  values (p_tenant_id, p_actor, 'contact.deleted', 'contact', p_contact_id,
          jsonb_build_object('conversations', v_conversations, 'messages', v_messages, 'leads', v_leads, 'bookings', v_bookings));

  return query select 'deleted'::text, v_conversations, v_messages, v_leads, v_bookings, v_events, v_conversation_ids;
end;
$$;

revoke execute on function public.unpaid_trials_for_cleanup(timestamptz) from public, anon, authenticated;
revoke execute on function public.delete_unpaid_trial(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.media_object_names(uuid, uuid[]) from public, anon, authenticated;
revoke execute on function public.delete_contact_data(uuid, uuid, text) from public, anon, authenticated;
