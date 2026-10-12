-- 0028_owner_admin_writes: only owners and admins change the business's setup from the browser (docs/dashboard-screen-
-- inventory.md, "Proposed role access": Agent settings, Settings and the knowledge base's services are owner and admin;
-- staff read them). Dev 3's audit (12 Oct) found that 0002 lets every member, staff included, write them.
--
-- Now owner or admin only (members still read everything as before):
--   * services and resources: insert, update, delete (the services and staff calendars of the business);
--   * catalog_items: insert, update, delete (the projects or products the assistant scores against);
--   * tenants: the update of name, timezone, business_hours and agent_settings (the columns 0002 grants).
-- Unchanged for every member: moving a lead on the board (leads), quotes, consent_logs, and a member's own alert number and
-- takeover preference (memberships). Bookings, features and the team change only through server routes, which check roles.
--
-- is_admin(tenant) is the role check, security definer like is_member (it reads memberships, which a policy may not read
-- through its own policy). Each policy keeps is_member(...) first, so supabase/tests/isolation.test.sql still sees every
-- policy reach only the member's own business.

create function public.is_admin(t uuid) returns boolean
  language sql stable security definer
  set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.tenant_id = t and m.user_id = (select auth.uid()) and m.role in ('owner', 'admin')
  )
$$;

revoke execute on function public.is_admin(uuid) from public, anon;
grant execute on function public.is_admin(uuid) to authenticated, service_role;

-- services and resources ------------------------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['services', 'resources'] loop
    execute format('drop policy tenant_insert on public.%I', t);
    execute format('drop policy tenant_update on public.%I', t);
    execute format('drop policy tenant_delete on public.%I', t);
    execute format(
      'create policy admin_insert on public.%I for insert to authenticated
         with check (public.is_member(tenant_id) and public.is_admin(tenant_id))', t);
    execute format(
      'create policy admin_update on public.%I for update to authenticated
         using (public.is_member(tenant_id) and public.is_admin(tenant_id))
         with check (public.is_member(tenant_id) and public.is_admin(tenant_id))', t);
    execute format(
      'create policy admin_delete on public.%I for delete to authenticated
         using (public.is_member(tenant_id) and public.is_admin(tenant_id))', t);
  end loop;
end
$$;

-- catalog_items: every member reads, owners and admins write ------------------------------------------------------

drop policy tenant_isolation on public.catalog_items;
create policy tenant_read on public.catalog_items
  for select to authenticated using (public.is_member(tenant_id));
create policy admin_insert on public.catalog_items
  for insert to authenticated with check (public.is_member(tenant_id) and public.is_admin(tenant_id));
create policy admin_update on public.catalog_items
  for update to authenticated
  using (public.is_member(tenant_id) and public.is_admin(tenant_id))
  with check (public.is_member(tenant_id) and public.is_admin(tenant_id));
create policy admin_delete on public.catalog_items
  for delete to authenticated using (public.is_member(tenant_id) and public.is_admin(tenant_id));

-- tenants: the business's own settings ---------------------------------------------------------------------------

drop policy tenant_update on public.tenants;
create policy admin_update on public.tenants
  for update to authenticated
  using (public.is_member(id) and public.is_admin(id))
  with check (public.is_member(id) and public.is_admin(id));
