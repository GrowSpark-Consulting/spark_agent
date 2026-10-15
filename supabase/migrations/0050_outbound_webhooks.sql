-- 0050_outbound_webhooks: a Pro business's CRM or sheet hears about its new leads, qualified leads, bookings and handoffs
-- (handover, API table: "Outbound webhooks (Pro) ... signed with a per-tenant secret"; 9-day plan, Day 7, P1).
--
-- webhook_endpoints: one per business: the https URL, the events it wants, and its signing secret, encrypted with
--   ENCRYPTION_KEY (backend/src/lib/crypto.ts webhookEndpointSecretContext). Written only by the functions below, each
--   with its audit row in the same transaction.
-- webhook_deliveries: an outbox. A trigger on leads, bookings and handoffs queues an event whatever made the change (the
--   assistant, a server route or a member's own dashboard write), in the same transaction as the change, and only for a
--   business whose endpoint is active and wants that event. The row holds no customer data: the job builds the body
--   from the current rows when it sends, so a record deleted in between (a customer's deletion request) is never sent.
--   One row per (business, event, record): a write replayed or repeated queues nothing more.
-- The outbound-webhooks job (backend/src/inngest/outbound-webhooks.ts) claims due rows, sends each signed, and records
-- the result. A failure is retried after 1, 5 and 15 minutes, then 1, 3, 6 and 12 hours: 8 attempts in about a day, then
-- `failed`. Rows that are done are kept 30 days.
-- Server only: row-level security with no policies, nothing granted to the browser roles, every function revoked.

create table public.webhook_endpoints (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  url text not null check (url ~ '^https://' and length(url) <= 500),
  events text[] not null check (
    cardinality(events) > 0
    and events <@ array['lead.created', 'lead.qualified', 'booking.confirmed', 'booking.cancelled', 'handoff.opened']
  ),
  secret_enc text not null,
  secret_hint text not null check (length(secret_hint) = 4),  -- the secret's last 4 characters, to tell two apart
  active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_failure text  -- a short reason (http_500, timeout, refused_address), never the URL or a response
);
alter table public.webhook_endpoints enable row level security;
revoke all on public.webhook_endpoints from anon, authenticated;

create table public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),  -- the event id the receiver sees: the same on every retry
  tenant_id uuid not null references public.webhook_endpoints(tenant_id) on delete cascade,
  event text not null check (event in ('lead.created', 'lead.qualified', 'booking.confirmed', 'booking.cancelled', 'handoff.opened')),
  entity_id uuid not null,
  occurred_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'delivered', 'failed', 'dropped')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  claimed_by text,
  claimed_until timestamptz,
  last_status int,
  last_error text,
  delivered_at timestamptz,
  unique (tenant_id, event, entity_id)
);
alter table public.webhook_deliveries enable row level security;
revoke all on public.webhook_deliveries from anon, authenticated;
create index webhook_deliveries_due on public.webhook_deliveries (next_attempt_at) where status = 'pending';
create index webhook_deliveries_done on public.webhook_deliveries (occurred_at) where status <> 'pending';

-- The outbox trigger -----------------------------------------------------------------------------------------------------
-- Never fails the write that fired it: a lead or a booking matters more than its webhook.
create function public.queue_webhook_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_events text[] := '{}';
begin
  if TG_TABLE_NAME = 'leads' then
    if TG_OP = 'INSERT' then
      v_events := array_append(v_events, 'lead.created');
    end if;
    if NEW.stage = 'qualified' and (TG_OP = 'INSERT' or OLD.stage is distinct from 'qualified') then
      v_events := array_append(v_events, 'lead.qualified');
    end if;
  elsif TG_TABLE_NAME = 'bookings' then
    if NEW.status = 'confirmed' and (TG_OP = 'INSERT' or OLD.status is distinct from 'confirmed') then
      v_events := array_append(v_events, 'booking.confirmed');
    elsif TG_OP = 'UPDATE' and NEW.status = 'cancelled' and OLD.status = 'confirmed' then
      v_events := array_append(v_events, 'booking.cancelled');  -- a hold that lapsed or was dropped was never a booking to the business
    end if;
  elsif TG_TABLE_NAME = 'handoffs' then
    v_events := array_append(v_events, 'handoff.opened');
  end if;

  if cardinality(v_events) > 0 then
    insert into public.webhook_deliveries (tenant_id, event, entity_id)
    select e.tenant_id, ev, NEW.id
      from public.webhook_endpoints e, unnest(v_events) ev
     where e.tenant_id = NEW.tenant_id and e.active and ev = any (e.events)
    on conflict (tenant_id, event, entity_id) do nothing;
  end if;
  return null;
exception when others then
  raise warning 'webhook event for % % was not queued (%)', TG_TABLE_NAME, NEW.id, SQLSTATE;
  return null;
end;
$$;
revoke execute on function public.queue_webhook_events() from public, anon, authenticated;

create trigger queue_webhook_events after insert or update of stage on public.leads
  for each row execute function public.queue_webhook_events();
create trigger queue_webhook_events after insert or update of status on public.bookings
  for each row execute function public.queue_webhook_events();
create trigger queue_webhook_events after insert on public.handoffs
  for each row execute function public.queue_webhook_events();

-- The endpoint (owner or admin, through the API) -----------------------------------------------------------------------

-- Creates the endpoint with the given secret, or changes the URL and events of the one there (its secret stays: a secret
-- passed then is ignored, and `created` false tells the caller not to show it). Turns it back on either way.
create function public.save_webhook_endpoint(
  p_tenant_id uuid, p_url text, p_events text[], p_secret_enc text, p_secret_hint text, p_actor uuid
)
returns table (created boolean)
language plpgsql
set search_path = ''
as $$
declare
  v_created boolean;
  v_old public.webhook_endpoints;
begin
  select * into v_old from public.webhook_endpoints where tenant_id = p_tenant_id for update;
  if found then
    update public.webhook_endpoints
       set url = p_url, events = p_events, active = true, updated_at = now()
     where tenant_id = p_tenant_id;
    v_created := false;
  else
    insert into public.webhook_endpoints (tenant_id, url, events, secret_enc, secret_hint, created_by)
    values (p_tenant_id, p_url, p_events, p_secret_enc, p_secret_hint, p_actor);
    v_created := true;
  end if;

  -- The host only: a URL's path can hold the receiver's own key (a Zapier or Make hook).
  insert into public.audit_logs (tenant_id, actor, action, entity, diff)
  values (p_tenant_id, p_actor::text, case when v_created then 'webhook_endpoint.created' else 'webhook_endpoint.updated' end, 'webhook_endpoint',
          jsonb_build_object('host', substring(p_url from '^https://([^/:?#]+)'), 'events', to_jsonb(p_events))
          || case when v_created or v_old.url = p_url then '{}'::jsonb else jsonb_build_object('url_changed', true) end);
  return query select v_created;
end;
$$;

-- A new secret; the old one stops working at once. false when there is no endpoint.
create function public.rotate_webhook_secret(p_tenant_id uuid, p_secret_enc text, p_secret_hint text, p_actor uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  update public.webhook_endpoints set secret_enc = p_secret_enc, secret_hint = p_secret_hint, updated_at = now()
   where tenant_id = p_tenant_id;
  if not found then
    return false;
  end if;
  insert into public.audit_logs (tenant_id, actor, action, entity) values (p_tenant_id, p_actor::text, 'webhook_endpoint.secret_rotated', 'webhook_endpoint');
  return true;
end;
$$;

-- Removes the endpoint and everything queued for it. false when there was none.
create function public.delete_webhook_endpoint(p_tenant_id uuid, p_actor uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  delete from public.webhook_endpoints where tenant_id = p_tenant_id;
  if not found then
    return false;
  end if;
  insert into public.audit_logs (tenant_id, actor, action, entity) values (p_tenant_id, p_actor::text, 'webhook_endpoint.deleted', 'webhook_endpoint');
  return true;
end;
$$;

-- The job ------------------------------------------------------------------------------------------------------------------

-- Hands up to p_limit due deliveries to one run, for 5 minutes; another run skips them meanwhile (and takes them over if
-- the run died). Rows done for over 30 days are removed first.
create function public.claim_webhook_deliveries(p_run text, p_limit int default 50, p_now timestamptz default now())
returns table (id uuid, tenant_id uuid, event text, entity_id uuid, occurred_at timestamptz, attempts int)
language plpgsql
set search_path = ''
as $$
begin
  if p_run is null or btrim(p_run) = '' then
    raise exception 'claim_webhook_deliveries: a run id is required' using errcode = '22023';
  end if;

  delete from public.webhook_deliveries d
   where d.id in (select x.id from public.webhook_deliveries x
                   where x.status <> 'pending' and x.occurred_at < p_now - interval '30 days' limit 1000);

  return query
  update public.webhook_deliveries d
     set claimed_by = p_run, claimed_until = p_now + interval '5 minutes'
   where d.id in (
     select x.id from public.webhook_deliveries x
      where x.status = 'pending' and x.next_attempt_at <= p_now and (x.claimed_until is null or x.claimed_until < p_now)
      order by x.next_attempt_at
      limit greatest(1, least(p_limit, 200))
      for update skip locked)
  returning d.id, d.tenant_id, d.event, d.entity_id, d.occurred_at, d.attempts;
end;
$$;

-- What happened to one claimed delivery: 'delivered' (2xx), 'failed' (anything else: tried again later, or given up
-- after 8 attempts) or 'dropped' (the record is gone or the business may not send webhooks now). Only the run holding
-- the claim can record, once: a repeat returns null and changes nothing. Returns the delivery's new status.
create function public.record_webhook_attempt(
  p_id uuid, p_run text, p_outcome text, p_status int default null, p_error text default null, p_now timestamptz default now()
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  d public.webhook_deliveries;
  v_backoff interval[] := array['1 minute', '5 minutes', '15 minutes', '1 hour', '3 hours', '6 hours', '12 hours']::interval[];
  v_status text;
begin
  if p_outcome not in ('delivered', 'failed', 'dropped') then
    raise exception 'record_webhook_attempt: unknown outcome %', p_outcome using errcode = '22023';
  end if;
  select * into d from public.webhook_deliveries x where x.id = p_id and x.claimed_by = p_run and x.status = 'pending' for update;
  if not found then
    return null;
  end if;

  v_status := case
    when p_outcome = 'failed' and d.attempts < cardinality(v_backoff) then 'pending'
    else p_outcome
  end;
  update public.webhook_deliveries
     set status = v_status,
         attempts = d.attempts + case when p_outcome = 'dropped' then 0 else 1 end,
         next_attempt_at = case when v_status = 'pending' then p_now + v_backoff[d.attempts + 1] else d.next_attempt_at end,
         claimed_by = null, claimed_until = null,
         last_status = p_status,
         last_error = left(p_error, 100),
         delivered_at = case when p_outcome = 'delivered' then p_now end
   where id = p_id;

  if p_outcome = 'delivered' then
    update public.webhook_endpoints set last_success_at = p_now where tenant_id = d.tenant_id;
  elsif p_outcome = 'failed' then
    update public.webhook_endpoints set last_failure_at = p_now, last_failure = left(p_error, 100) where tenant_id = d.tenant_id;
  end if;
  return v_status;
end;
$$;

revoke execute on function public.save_webhook_endpoint(uuid, text, text[], text, text, uuid) from public, anon, authenticated;
revoke execute on function public.rotate_webhook_secret(uuid, text, text, uuid) from public, anon, authenticated;
revoke execute on function public.delete_webhook_endpoint(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.claim_webhook_deliveries(text, int, timestamptz) from public, anon, authenticated;
revoke execute on function public.record_webhook_attempt(uuid, text, text, int, text, timestamptz) from public, anon, authenticated;
grant execute on function public.save_webhook_endpoint(uuid, text, text[], text, text, uuid) to service_role;
grant execute on function public.rotate_webhook_secret(uuid, text, text, uuid) to service_role;
grant execute on function public.delete_webhook_endpoint(uuid, uuid) to service_role;
grant execute on function public.claim_webhook_deliveries(text, int, timestamptz) to service_role;
grant execute on function public.record_webhook_attempt(uuid, text, text, int, text, timestamptz) to service_role;
