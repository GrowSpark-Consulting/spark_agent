-- 0052_team_invites: an owner or admin invites a person to the team by email, and the person joins with the link
-- (docs/task-notes/2026-10-14-day6-dev3-team-invite-proposal.md; the seven decisions in it were approved by Dev 2).
--
--   * memberships.display_name: the name the team list shows. Set from the invite when the person joins. The browser cannot
--     change it (the update grant of 0002 stays the two columns it was); a later screen can add that.
--   * team_invites: one row per invitation. The raw token (32 random bytes, base64url, like connect_links in 0016) exists only
--     in the link the inviter copies; the row keeps its SHA-256 as lowercase hex (backend/src/lib/connect-link-token.ts, the same
--     helper as connect links). Server only, except that owners and admins may READ their business's invitations,
--     without the token hash (column grant), under row-level security. Nobody writes it from the browser.
--   * Seats: a live invitation (not accepted, not cancelled, not expired) reserves a seat: used = memberships + live invites.
--     An expired invitation stops counting by itself, with no job: every count says `expires_at > now()`.
--   * create_team_invite, resend_team_invite, cancel_team_invite and accept_team_invite do each change in ONE transaction with
--     its audit row (team_invite.created / resent / cancelled / accepted). create, resend (of an expired invitation) and accept
--     take the business's row lock first, FOR NO KEY UPDATE, the same lock the 0027 seat trigger takes, so two invitations, or an
--     invitation and a new member, count one after the other and the last seat goes to exactly one of them.
--   * The role rules are enforced here as well as in the API: an owner invites admins or staff, an admin invites staff only, staff
--     invite no one, and nobody is invited as owner (the table's role check). A person who accepts gets the invited role and no other.
--   * Resend: rotates the token (the old link stops working at once), resets the expiry to seven days and keeps the seat it already
--     holds. At most five resends in any 24 hours per invitation, counted under the invitation's row lock so parallel resends cannot
--     pass the limit.
-- Errors use the SQLSTATEs the API maps: PA404 not_found, PA403 forbidden, PA409 conflict, PA413 seat_limit, PA429 rate_limited.
-- Server only: every function is revoked from the browser roles.

alter table public.memberships
  add column display_name text check (display_name is null or length(btrim(display_name)) between 1 and 80);

create table public.team_invites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  name text not null check (length(btrim(name)) between 1 and 80),
  role text not null check (role in ('admin', 'staff')),  -- never 'owner': an invitation cannot make an owner
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  resend_count int not null default 0 check (resend_count >= 0),
  resends_in_window int not null default 0 check (resends_in_window between 0 and 5),
  resend_window_started_at timestamptz,
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  cancelled_at timestamptz,
  check (expires_at > created_at),
  check (accepted_at is null or cancelled_at is null)
);

comment on column public.team_invites.token_hash is
  'Lowercase hex SHA-256 of the invitation token''s UTF-8 bytes (backend/src/lib/connect-link-token.ts). The raw token is never stored.';
comment on column public.team_invites.email is 'Trimmed and lower-cased; the person must sign in with this address to accept.';

-- One open invitation per email per business. An expired one is removed by create_team_invite before the new one is made.
create unique index team_invites_open_email_idx on public.team_invites (tenant_id, email)
  where accepted_at is null and cancelled_at is null;
create index team_invites_tenant_created_idx on public.team_invites (tenant_id, created_at desc);
create index team_invites_open_email_lookup_idx on public.team_invites (email) where accepted_at is null and cancelled_at is null;
create index team_invites_open_expiry_idx on public.team_invites (tenant_id, expires_at) where accepted_at is null and cancelled_at is null;
create index team_invites_invited_by_idx on public.team_invites (invited_by);

create trigger team_invites_set_updated_at
  before update on public.team_invites
  for each row execute function public.set_updated_at();

alter table public.team_invites enable row level security;
revoke all on public.team_invites from anon, authenticated;
-- Owners and admins read their business's invitations: every column but the token hash.
grant select (id, tenant_id, email, name, role, invited_by, created_at, updated_at, expires_at, resend_count, accepted_at, cancelled_at)
  on public.team_invites to authenticated;
create policy admin_read on public.team_invites
  for select to authenticated using (public.is_member(tenant_id) and public.is_admin(tenant_id));

-- Who may invite whom ------------------------------------------------------------------------------------------------

create function public.team_invite_actor_role(p_tenant_id uuid, p_actor uuid, p_invite_role text) returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_role text;
begin
  select m.role into v_role from public.memberships m where m.tenant_id = p_tenant_id and m.user_id = p_actor;
  if v_role is null or v_role = 'staff' or (v_role = 'admin' and p_invite_role is distinct from 'staff') then
    raise exception 'forbidden: this role cannot manage that invitation' using errcode = 'PA403';
  end if;
  return v_role;
end
$$;

-- Create ---------------------------------------------------------------------------------------------------------------

create function public.create_team_invite(
  p_tenant_id uuid, p_email text, p_name text, p_role text, p_invited_by uuid, p_token_hash text
) returns table (invite_id uuid, invite_email text, invite_name text, invite_role text, invite_created_at timestamptz, invite_expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(p_email));
  v_name text := btrim(p_name);
  v_seats int;
  v_plan text;
  v_used int;
  v_id uuid;
  v_created timestamptz;
  v_expires timestamptz := now() + interval '7 days';
begin
  if p_role is null or p_role not in ('admin', 'staff') then
    raise exception 'forbidden: an invitation is for an admin or for staff' using errcode = 'PA403';
  end if;
  -- The business's row lock first: the seat count below and any other seat change take turns.
  select p.seats, p.name into v_seats, v_plan
  from public.tenants t join public.plans p on p.key = t.plan_key
  where t.id = p_tenant_id
  for no key update of t;
  if not found then
    raise exception 'create_team_invite: unknown business' using errcode = 'PA404';
  end if;
  perform public.team_invite_actor_role(p_tenant_id, p_invited_by, p_role);

  if exists (
    select 1 from public.memberships m join auth.users u on u.id = m.user_id
    where m.tenant_id = p_tenant_id and lower(u.email) = v_email
  ) then
    raise exception 'already_member: that person is already on the team' using errcode = 'PA409';
  end if;

  -- An expired invitation no longer holds anything: make room for a new one to the same address.
  delete from public.team_invites i
  where i.tenant_id = p_tenant_id and i.email = v_email and i.accepted_at is null and i.cancelled_at is null and i.expires_at <= now();
  if exists (
    select 1 from public.team_invites i
    where i.tenant_id = p_tenant_id and i.email = v_email and i.accepted_at is null and i.cancelled_at is null
  ) then
    raise exception 'invite_exists: that address already has a pending invitation' using errcode = 'PA409';
  end if;

  select (select count(*) from public.memberships m where m.tenant_id = p_tenant_id)
       + (select count(*) from public.team_invites i
           where i.tenant_id = p_tenant_id and i.accepted_at is null and i.cancelled_at is null and i.expires_at > now())
    into v_used;
  if v_used >= v_seats then
    raise exception 'seat_limit: the % plan includes % team members', v_plan, v_seats using errcode = 'PA413';
  end if;

  insert into public.team_invites (tenant_id, email, name, role, token_hash, invited_by, expires_at)
  values (p_tenant_id, v_email, v_name, p_role, p_token_hash, p_invited_by, v_expires)
  returning id, created_at into v_id, v_created;

  insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
  values (p_tenant_id, p_invited_by::text, 'team_invite.created', 'team_invite', v_id,
          jsonb_build_object('role', p_role, 'expires_at', v_expires));

  return query select v_id, v_email, v_name, p_role, v_created, v_expires;
end
$$;

-- Resend ---------------------------------------------------------------------------------------------------------------

create function public.resend_team_invite(p_tenant_id uuid, p_invite_id uuid, p_actor uuid, p_token_hash text)
returns table (invite_id uuid, invite_email text, invite_name text, invite_role text, invite_created_at timestamptz, invite_expires_at timestamptz, resends_left int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seats int;
  v_plan text;
  v_used int;
  v_inv public.team_invites;
  v_count int;
  v_started timestamptz;
  v_expires timestamptz := now() + interval '7 days';
begin
  select p.seats, p.name into v_seats, v_plan
  from public.tenants t join public.plans p on p.key = t.plan_key
  where t.id = p_tenant_id
  for no key update of t;
  if not found then
    raise exception 'resend_team_invite: unknown business' using errcode = 'PA404';
  end if;

  select * into v_inv from public.team_invites i where i.id = p_invite_id and i.tenant_id = p_tenant_id for update;
  if not found or v_inv.accepted_at is not null or v_inv.cancelled_at is not null then
    raise exception 'invite_not_found: no such pending invitation' using errcode = 'PA404';
  end if;
  perform public.team_invite_actor_role(p_tenant_id, p_actor, v_inv.role);

  -- An expired invitation holds no seat. Sending it again takes one back, so it needs one free; a live one keeps the seat it has.
  if v_inv.expires_at <= now() then
    select (select count(*) from public.memberships m where m.tenant_id = p_tenant_id)
         + (select count(*) from public.team_invites i
             where i.tenant_id = p_tenant_id and i.accepted_at is null and i.cancelled_at is null and i.expires_at > now())
      into v_used;
    if v_used >= v_seats then
      raise exception 'seat_limit: the % plan includes % team members', v_plan, v_seats using errcode = 'PA413';
    end if;
  end if;

  -- Five resends in any 24 hours, counted under this row's lock.
  if v_inv.resend_window_started_at is null or v_inv.resend_window_started_at <= now() - interval '1 day' then
    v_count := 0;
    v_started := now();
  else
    v_count := v_inv.resends_in_window;
    v_started := v_inv.resend_window_started_at;
  end if;
  if v_count >= 5 then
    raise exception 'resend_limit: this invitation was sent again 5 times in the last day' using errcode = 'PA429';
  end if;

  update public.team_invites i
     set token_hash = p_token_hash, expires_at = v_expires, resend_count = i.resend_count + 1,
         resends_in_window = v_count + 1, resend_window_started_at = v_started
   where i.id = v_inv.id;

  insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
  values (p_tenant_id, p_actor::text, 'team_invite.resent', 'team_invite', v_inv.id,
          jsonb_build_object('role', v_inv.role, 'expires_at', v_expires, 'resends_in_window', v_count + 1));

  return query select v_inv.id, v_inv.email, v_inv.name, v_inv.role, v_inv.created_at, v_expires, 5 - (v_count + 1);
end
$$;

-- Cancel ---------------------------------------------------------------------------------------------------------------

create function public.cancel_team_invite(p_tenant_id uuid, p_invite_id uuid, p_actor uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.team_invites;
begin
  select * into v_inv from public.team_invites i where i.id = p_invite_id and i.tenant_id = p_tenant_id for update;
  if not found or v_inv.accepted_at is not null or v_inv.cancelled_at is not null then
    raise exception 'invite_not_found: no such pending invitation' using errcode = 'PA404';
  end if;
  perform public.team_invite_actor_role(p_tenant_id, p_actor, v_inv.role);
  update public.team_invites i set cancelled_at = now() where i.id = v_inv.id;
  insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
  values (p_tenant_id, p_actor::text, 'team_invite.cancelled', 'team_invite', v_inv.id, jsonb_build_object('role', v_inv.role));
end
$$;

-- Accept ---------------------------------------------------------------------------------------------------------------
-- p_user_id and p_email are the signed-in user's, verified by the API from their access token; never from the request body.

create function public.accept_team_invite(p_token_hash text, p_user_id uuid, p_email text)
returns table (out_tenant_id uuid, out_role text, out_already_member boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_inv public.team_invites;
  v_existing text;
begin
  select i.tenant_id into v_tenant from public.team_invites i where i.token_hash = p_token_hash;
  if not found then
    raise exception 'invite_not_found: this invitation is not valid' using errcode = 'PA404';
  end if;
  -- The business's lock, then the invitation's: the same order as create and resend.
  perform 1 from public.tenants t where t.id = v_tenant for no key update;
  select * into v_inv from public.team_invites i where i.token_hash = p_token_hash for update;
  if not found or v_inv.accepted_at is not null or v_inv.cancelled_at is not null or v_inv.expires_at <= now() then
    raise exception 'invite_not_found: this invitation is not valid' using errcode = 'PA404';
  end if;
  if p_email is null or lower(btrim(p_email)) is distinct from v_inv.email then
    raise exception 'email_mismatch: this invitation was sent to a different address' using errcode = 'PA403';
  end if;

  update public.team_invites i set accepted_at = now(), accepted_by = p_user_id where i.id = v_inv.id;

  select m.role into v_existing from public.memberships m where m.tenant_id = v_inv.tenant_id and m.user_id = p_user_id;
  if found then
    -- Already on the team (invited twice, or joined another way): the seat it held is released and the role they have stays.
    out_tenant_id := v_inv.tenant_id; out_role := v_existing; out_already_member := true;
  else
    -- The 0027 trigger counts this row with the others and refuses it past the plan's seats (a plan lowered since the invitation),
    -- which undoes this whole statement: the invitation stays pending.
    insert into public.memberships (tenant_id, user_id, role, display_name) values (v_inv.tenant_id, p_user_id, v_inv.role, v_inv.name);
    out_tenant_id := v_inv.tenant_id; out_role := v_inv.role; out_already_member := false;
  end if;

  insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
  values (v_inv.tenant_id, p_user_id::text, 'team_invite.accepted', 'team_invite', v_inv.id,
          jsonb_build_object('role', out_role, 'already_member', out_already_member));
  return next;
end
$$;

revoke execute on function public.team_invite_actor_role(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.create_team_invite(uuid, text, text, text, uuid, text) from public, anon, authenticated;
revoke execute on function public.resend_team_invite(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.cancel_team_invite(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.accept_team_invite(text, uuid, text) from public, anon, authenticated;
grant execute on function public.create_team_invite(uuid, text, text, text, uuid, text) to service_role;
grant execute on function public.resend_team_invite(uuid, uuid, uuid, text) to service_role;
grant execute on function public.cancel_team_invite(uuid, uuid, uuid) to service_role;
grant execute on function public.accept_team_invite(text, uuid, text) to service_role;
