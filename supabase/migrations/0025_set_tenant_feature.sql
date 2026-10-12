-- 0025_set_tenant_feature: a business changes one of its feature toggles (9-day plan, Day 5: PATCH /api/features/:key
-- "with plan checks and audit log; locked features cannot be switched on by API"; docs/handover.md, module 7).
--
-- One function does the plan check, the write and the audit row in one transaction, so a change is never saved
-- without its audit row, and no server path can switch on a feature the plan does not include:
--   * a feature outside the plan cannot be switched on and its settings cannot change (PA403); switching it off,
--     or sending the value it already has, is allowed;
--   * nothing changes and nothing is audited when the values are the ones already saved;
--   * the audit row is feature.toggled when the switch changed, else feature.settings_changed, with both values.
-- The API validates the settings against what the jobs read (backend/src/features/settings.ts) before calling this.
-- Errors use the SQLSTATEs the API maps: PA404 not_found, PA403 plan_required. Server only (service_role).

create function public.set_tenant_feature(
  p_tenant_id uuid, p_feature_key text, p_enabled boolean, p_settings jsonb, p_actor text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_plan_features text[];
  v_default boolean;
  v_old_enabled boolean;
  v_old_settings jsonb;
  v_new_enabled boolean;
  v_new_settings jsonb;
begin
  if p_settings is not null and jsonb_typeof(p_settings) <> 'object' then
    raise exception 'set_tenant_feature: settings must be an object';
  end if;
  if p_actor is null or p_actor = '' then
    raise exception 'set_tenant_feature: an actor is required';
  end if;

  -- Changes for one business take turns.
  select p.feature_keys into v_plan_features
  from public.tenants t
  join public.plans p on p.key = t.plan_key
  where t.id = p_tenant_id
  for update of t;
  if not found then
    raise exception 'set_tenant_feature: business not found' using errcode = 'PA404';
  end if;

  select f.default_on into v_default from public.features f where f.key = p_feature_key;
  if not found then
    raise exception 'set_tenant_feature: feature not found' using errcode = 'PA404';
  end if;

  select tf.enabled, tf.settings into v_old_enabled, v_old_settings
  from public.tenant_features tf
  where tf.tenant_id = p_tenant_id and tf.feature_key = p_feature_key;
  if not found then
    v_old_enabled := v_default;
    v_old_settings := '{}';
  end if;
  v_new_enabled := coalesce(p_enabled, v_old_enabled);
  v_new_settings := coalesce(p_settings, v_old_settings);

  if v_new_enabled = v_old_enabled and v_new_settings = v_old_settings then
    return jsonb_build_object('changed', false, 'enabled', v_new_enabled, 'settings', v_new_settings);
  end if;
  if not (p_feature_key = any(v_plan_features))
     and ((v_new_enabled and not v_old_enabled) or v_new_settings <> v_old_settings) then
    raise exception 'set_tenant_feature: % is not in this business''s plan', p_feature_key using errcode = 'PA403';
  end if;

  insert into public.tenant_features (tenant_id, feature_key, enabled, settings)
  values (p_tenant_id, p_feature_key, v_new_enabled, v_new_settings)
  on conflict (tenant_id, feature_key) do update set enabled = excluded.enabled, settings = excluded.settings;

  insert into public.audit_logs (tenant_id, actor, action, entity, diff)
  values (
    p_tenant_id, p_actor,
    case when v_new_enabled <> v_old_enabled then 'feature.toggled' else 'feature.settings_changed' end,
    'feature',
    jsonb_build_object(
      'key', p_feature_key,
      'enabled', jsonb_build_object('from', v_old_enabled, 'to', v_new_enabled),
      'settings', jsonb_build_object('from', v_old_settings, 'to', v_new_settings)
    )
  );
  return jsonb_build_object('changed', true, 'enabled', v_new_enabled, 'settings', v_new_settings);
end
$$;

-- Server only. Supabase grants new functions to anon and authenticated by default.
revoke execute on function public.set_tenant_feature(uuid, text, boolean, jsonb, text) from public, anon, authenticated;
grant execute on function public.set_tenant_feature(uuid, text, boolean, jsonb, text) to service_role;
