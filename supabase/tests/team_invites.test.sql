-- Team invitations (0052): the table's constraints and row-level security, who may invite whom, seat accounting with live
-- invitations, expiry, resend rotation and its daily limit, and acceptance. Run: pnpm db:test
--
-- A single-transaction test cannot race two sessions, so the concurrent case (many invitations for the last seat at the same
-- moment) is scripts/db/team-invite-concurrency.sh; here the lock order is covered by the sequence of counts.
begin;
create extension if not exists pgtap with schema extensions;
select plan(80);

insert into public.plans (key, name, price_inr, monthly_credits, seats, whatsapp_numbers, feature_keys) values
  ('trial', 'Trial', 0, 300, 2, 1, array['ai_auto_reply']),
  ('growth', 'Growth', 5999, 5000, 5, 1, array['ai_auto_reply'])
  on conflict (key) do nothing;

insert into auth.users (id, email) values
  ('a5000000-0000-0000-0000-000000000001', 'owner1@ti.test'),
  ('a5000000-0000-0000-0000-000000000002', 'invitee1@ti.test'),
  ('a5000000-0000-0000-0000-000000000003', 'wrong@ti.test'),
  ('a5000000-0000-0000-0000-000000000011', 'owner2@ti.test'),
  ('a5000000-0000-0000-0000-000000000012', 'admin2@ti.test'),
  ('a5000000-0000-0000-0000-000000000013', 'staff2@ti.test'),
  ('a5000000-0000-0000-0000-000000000021', 'owner3@ti.test'),
  ('a5000000-0000-0000-0000-000000000031', 'owner4@ti.test'),
  ('a5000000-0000-0000-0000-000000000032', 'member4@ti.test'),
  ('a5000000-0000-0000-0000-000000000033', 'late4@ti.test');
insert into public.tenants (id, name, vertical, plan_key) values
  ('a5100000-0000-0000-0000-000000000001', 'Invites T1 (Trial)', 'test-pack', 'trial'),
  ('a5100000-0000-0000-0000-000000000002', 'Invites T2 (Growth)', 'test-pack', 'growth'),
  ('a5100000-0000-0000-0000-000000000003', 'Invites T3 (Growth)', 'test-pack', 'growth'),
  ('a5100000-0000-0000-0000-000000000004', 'Invites T4 (Growth)', 'test-pack', 'growth');
insert into public.memberships (tenant_id, user_id, role) values
  ('a5100000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000001', 'owner'),
  ('a5100000-0000-0000-0000-000000000002', 'a5000000-0000-0000-0000-000000000011', 'owner'),
  ('a5100000-0000-0000-0000-000000000002', 'a5000000-0000-0000-0000-000000000012', 'admin'),
  ('a5100000-0000-0000-0000-000000000002', 'a5000000-0000-0000-0000-000000000013', 'staff'),
  ('a5100000-0000-0000-0000-000000000003', 'a5000000-0000-0000-0000-000000000021', 'owner'),
  ('a5100000-0000-0000-0000-000000000004', 'a5000000-0000-0000-0000-000000000031', 'owner'),
  ('a5100000-0000-0000-0000-000000000004', 'a5000000-0000-0000-0000-000000000032', 'staff');

-- A token hash for a made-up raw token, as the API makes it (SHA-256 of the UTF-8 bytes, lowercase hex).
create function pg_temp.h(p_raw text) returns text language sql immutable as $$
  select encode(sha256(convert_to(p_raw, 'UTF8')), 'hex')
$$;
-- Live invitations plus members: the seats a business uses.
create function pg_temp.used(p_tenant uuid) returns int language sql as $$
  select (select count(*)::int from public.memberships where tenant_id = p_tenant)
       + (select count(*)::int from public.team_invites
           where tenant_id = p_tenant and accepted_at is null and cancelled_at is null and expires_at > now())
$$;

-- Server only ------------------------------------------------------------------------------------------------------------
select ok(not has_function_privilege('authenticated', 'public.create_team_invite(uuid, text, text, text, uuid, text)', 'execute')
          and not has_function_privilege('anon', 'public.create_team_invite(uuid, text, text, text, uuid, text)', 'execute')
          and not has_function_privilege('authenticated', 'public.resend_team_invite(uuid, uuid, uuid, text)', 'execute')
          and not has_function_privilege('authenticated', 'public.cancel_team_invite(uuid, uuid, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'public.accept_team_invite(text, uuid, text)', 'execute')
          and not has_function_privilege('anon', 'public.accept_team_invite(text, uuid, text)', 'execute'),
  'the browser calls none of the invitation functions');
select ok(has_function_privilege('service_role', 'public.create_team_invite(uuid, text, text, text, uuid, text)', 'execute')
          and has_function_privilege('service_role', 'public.accept_team_invite(text, uuid, text)', 'execute'),
  'the server (service role) can');
select ok(not has_column_privilege('authenticated', 'public.team_invites', 'token_hash', 'select')
          and not has_column_privilege('anon', 'public.team_invites', 'token_hash', 'select'),
  'the token hash cannot be read from the browser');
select ok(has_column_privilege('authenticated', 'public.team_invites', 'email', 'select')
          and not has_table_privilege('authenticated', 'public.team_invites', 'insert')
          and not has_table_privilege('authenticated', 'public.team_invites', 'update')
          and not has_table_privilege('authenticated', 'public.team_invites', 'delete')
          and not has_table_privilege('anon', 'public.team_invites', 'select'),
  'a signed-in user can read the other columns but write nothing; a visitor reads nothing');

-- Constraints ------------------------------------------------------------------------------------------------------------
select throws_ok($$insert into public.team_invites (tenant_id, email, name, role, token_hash, expires_at)
                    values ('a5100000-0000-0000-0000-000000000002', 'raw@ti.test', 'Raw', 'staff', 'a-raw-token-not-a-hash', now() + interval '7 days')$$,
  '23514', null, 'only a 64-character hex hash can be stored as the token hash');
select throws_ok($$insert into public.team_invites (tenant_id, email, name, role, token_hash, expires_at)
                    values ('a5100000-0000-0000-0000-000000000002', 'boss@ti.test', 'Boss', 'owner', repeat('b', 64), now() + interval '7 days')$$,
  '23514', null, 'an invitation can never be for an owner');
select throws_ok($$insert into public.team_invites (tenant_id, email, name, role, token_hash, expires_at)
                    values ('a5100000-0000-0000-0000-000000000002', 'Mixed@Case.test', 'Mixed', 'staff', repeat('c', 64), now() + interval '7 days')$$,
  '23514', null, 'the stored email is already trimmed and lower-case');
select throws_ok($$insert into public.team_invites (tenant_id, email, name, role, token_hash, expires_at)
                    values ('a5100000-0000-0000-0000-000000000002', 'late@ti.test', 'Late', 'staff', repeat('d', 64), now() - interval '1 minute')$$,
  '23514', null, 'an invitation cannot expire before it was made');
select throws_ok($$select * from public.create_team_invite('a5100000-0000-0000-0000-000000000002', 'not-an-email', 'Nobody', 'staff',
                    'a5000000-0000-0000-0000-000000000011', pg_temp.h('bad-email'))$$,
  '23514', null, 'an email that is not an address is refused');
select throws_ok($$select * from public.create_team_invite('a5100000-0000-0000-0000-000000000002', 'noname@ti.test', '   ', 'staff',
                    'a5000000-0000-0000-0000-000000000011', pg_temp.h('no-name'))$$,
  '23514', null, 'and so is an empty name');

-- Who may invite whom (T2: Growth, 5 seats, owner + admin + staff = 3 used) ------------------------------------------------
select is((select invite_role from public.create_team_invite('a5100000-0000-0000-0000-000000000002', '  New.Admin@TI.test ', 'New Admin', 'admin',
                    'a5000000-0000-0000-0000-000000000011', pg_temp.h('A'))), 'admin', 'an owner invites an admin');
select is((select email from public.team_invites where token_hash = pg_temp.h('A')), 'new.admin@ti.test',
  'the email is trimmed and lower-cased');
select ok((select expires_at between now() + interval '6 days 23 hours' and now() + interval '7 days 1 hour' from public.team_invites where token_hash = pg_temp.h('A')),
  'it expires in seven days');
select is((select count(*)::int from public.audit_logs where tenant_id = 'a5100000-0000-0000-0000-000000000002' and action = 'team_invite.created'
            and actor = 'a5000000-0000-0000-0000-000000000011' and diff::text not like '%new.admin%' and diff::text not like '%' || pg_temp.h('A') || '%'), 1,
  'it is audited with the owner and no email or token');
select lives_ok($$select * from public.create_team_invite('a5100000-0000-0000-0000-000000000002', 'staff1@ti.test', 'Staff One', 'staff',
                    'a5000000-0000-0000-0000-000000000012', pg_temp.h('B'))$$, 'an admin invites staff');
select throws_ok($$select * from public.create_team_invite('a5100000-0000-0000-0000-000000000002', 'admin2b@ti.test', 'Admin Two', 'admin',
                    'a5000000-0000-0000-0000-000000000012', pg_temp.h('C'))$$,
  'PA403', null, 'an admin cannot invite an admin');
select throws_ok($$select * from public.create_team_invite('a5100000-0000-0000-0000-000000000002', 'staffer@ti.test', 'Staffer', 'staff',
                    'a5000000-0000-0000-0000-000000000013', pg_temp.h('D'))$$,
  'PA403', null, 'staff cannot invite anyone');
select throws_ok($$select * from public.create_team_invite('a5100000-0000-0000-0000-000000000002', 'ownerish@ti.test', 'Ownerish', 'owner',
                    'a5000000-0000-0000-0000-000000000011', pg_temp.h('E'))$$,
  'PA403', null, 'nobody can invite an owner');
select throws_ok($$select * from public.create_team_invite('a5100000-0000-0000-0000-000000000002', 'cross@ti.test', 'Cross', 'staff',
                    'a5000000-0000-0000-0000-000000000021', pg_temp.h('F'))$$,
  'PA403', null, 'an owner of another business cannot invite into this one');
select throws_ok($$select * from public.create_team_invite('a5100000-0000-0000-0000-0000000000ff', 'ghost@ti.test', 'Ghost', 'staff',
                    'a5000000-0000-0000-0000-000000000011', pg_temp.h('G'))$$,
  'PA404', null, 'an unknown business is refused');

-- Seats: members + live invitations ------------------------------------------------------------------------------------------
select is(pg_temp.used('a5100000-0000-0000-0000-000000000002'), 5, 'two live invitations and three members use all five seats');
select throws_ok($$select * from public.create_team_invite('a5100000-0000-0000-0000-000000000002', 'sixth@ti.test', 'Sixth', 'staff',
                    'a5000000-0000-0000-0000-000000000011', pg_temp.h('H'))$$,
  'PA413', 'seat_limit: the Growth plan includes 5 team members', 'a sixth is refused as seat_limit');
select is((select count(*)::int from public.team_invites where tenant_id = 'a5100000-0000-0000-0000-000000000002'), 2, 'and nothing was added');
select throws_ok($$select * from public.create_team_invite('a5100000-0000-0000-0000-000000000002', 'NEW.admin@ti.test', 'Again', 'staff',
                    'a5000000-0000-0000-0000-000000000011', pg_temp.h('I'))$$,
  'PA409', null, 'a second invitation for the same address (any case) is a conflict, even on a full team');
select throws_ok($$select * from public.create_team_invite('a5100000-0000-0000-0000-000000000002', 'Admin2@ti.test', 'Again', 'staff',
                    'a5000000-0000-0000-0000-000000000011', pg_temp.h('J'))$$,
  'PA409', null, 'an address that is already on the team is a conflict');

-- Expiry releases the seat -----------------------------------------------------------------------------------------------------
update public.team_invites set created_at = now() - interval '8 days', expires_at = now() - interval '1 day' where token_hash = pg_temp.h('A');
select is(pg_temp.used('a5100000-0000-0000-0000-000000000002'), 4, 'an expired invitation no longer holds a seat');
select lives_ok($$select * from public.create_team_invite('a5100000-0000-0000-0000-000000000002', 'New.Admin@ti.test', 'New Admin', 'admin',
                    'a5000000-0000-0000-0000-000000000011', pg_temp.h('K'))$$,
  'the same address can be invited again, replacing the expired invitation');
select is((select count(*)::int from public.team_invites where tenant_id = 'a5100000-0000-0000-0000-000000000002' and email = 'new.admin@ti.test'), 1,
  'and there is one row for it');
select throws_ok($$select * from public.create_team_invite('a5100000-0000-0000-0000-000000000002', 'sixth@ti.test', 'Sixth', 'staff',
                    'a5000000-0000-0000-0000-000000000011', pg_temp.h('L'))$$,
  'PA413', null, 'and the team is full again');

-- Resend: rotation, no new seat, who may, a limit of five a day --------------------------------------------------------------------
select is((select resends_left from public.resend_team_invite('a5100000-0000-0000-0000-000000000002', (select id from public.team_invites where token_hash = pg_temp.h('B')),
                    'a5000000-0000-0000-0000-000000000012', pg_temp.h('B2'))), 4, 'an admin resends a staff invitation: four resends left');
select is((select count(*)::int from public.team_invites where token_hash = pg_temp.h('B')), 0, 'the old token no longer finds the invitation');
select is((select count(*)::int from public.team_invites where token_hash = pg_temp.h('B2')), 1, 'the new one does');
select is(pg_temp.used('a5100000-0000-0000-0000-000000000002'), 5, 'a resend takes no extra seat');
select ok((select expires_at between now() + interval '6 days 23 hours' and now() + interval '7 days 1 hour' from public.team_invites where token_hash = pg_temp.h('B2')),
  'and the expiry is seven days from the resend');
select throws_ok($$select * from public.resend_team_invite('a5100000-0000-0000-0000-000000000002', (select id from public.team_invites where token_hash = pg_temp.h('K')),
                    'a5000000-0000-0000-0000-000000000012', pg_temp.h('K2'))$$,
  'PA403', null, 'an admin cannot resend an invitation for an admin');
select throws_ok($$select * from public.resend_team_invite('a5100000-0000-0000-0000-000000000002', (select id from public.team_invites where token_hash = pg_temp.h('B2')),
                    'a5000000-0000-0000-0000-000000000013', pg_temp.h('B3'))$$,
  'PA403', null, 'staff cannot resend');
select throws_ok($$select * from public.resend_team_invite('a5100000-0000-0000-0000-000000000003', (select id from public.team_invites where token_hash = pg_temp.h('B2')),
                    'a5000000-0000-0000-0000-000000000021', pg_temp.h('B4'))$$,
  'PA404', null, 'another business''s owner cannot resend this business''s invitation');
select lives_ok($$do $b$ begin
    for i in 1..4 loop
      perform * from public.resend_team_invite('a5100000-0000-0000-0000-000000000002', (select id from public.team_invites where email = 'staff1@ti.test'),
        'a5000000-0000-0000-0000-000000000011', pg_temp.h('R' || i));
    end loop;
  end $b$$, 'the owner resends it four more times: five in all');
select throws_ok($$select * from public.resend_team_invite('a5100000-0000-0000-0000-000000000002', (select id from public.team_invites where email = 'staff1@ti.test'),
                    'a5000000-0000-0000-0000-000000000011', pg_temp.h('R5'))$$,
  'PA429', null, 'a sixth within the day is refused');
select is((select resend_count from public.team_invites where email = 'staff1@ti.test'), 5, 'and was not counted');
select is((select count(*)::int from public.team_invites where token_hash = pg_temp.h('R5')), 0, 'nor did it change the token');
update public.team_invites set resend_window_started_at = now() - interval '25 hours' where email = 'staff1@ti.test';
select lives_ok($$select * from public.resend_team_invite('a5100000-0000-0000-0000-000000000002', (select id from public.team_invites where email = 'staff1@ti.test'),
                    'a5000000-0000-0000-0000-000000000011', pg_temp.h('R6'))$$, 'a day later the count starts again');
select is((select count(*)::int from public.audit_logs where tenant_id = 'a5100000-0000-0000-0000-000000000002' and action = 'team_invite.resent'), 6,
  'every resend is audited');

-- Resending an expired invitation needs a free seat ----------------------------------------------------------------------------------
update public.team_invites set created_at = now() - interval '9 days', expires_at = now() - interval '2 days' where email = 'staff1@ti.test';
select is(pg_temp.used('a5100000-0000-0000-0000-000000000002'), 4, 'with staff1''s invitation expired, one seat is free');
select lives_ok($$select * from public.create_team_invite('a5100000-0000-0000-0000-000000000002', 'filler@ti.test', 'Filler', 'staff',
                    'a5000000-0000-0000-0000-000000000011', pg_temp.h('M'))$$, 'and another invitation takes it');
select throws_ok($$select * from public.resend_team_invite('a5100000-0000-0000-0000-000000000002', (select id from public.team_invites where email = 'staff1@ti.test'),
                    'a5000000-0000-0000-0000-000000000011', pg_temp.h('R7'))$$,
  'PA413', null, 'so the expired invitation cannot be revived');
select lives_ok($$select public.cancel_team_invite('a5100000-0000-0000-0000-000000000002', (select id from public.team_invites where token_hash = pg_temp.h('M')),
                    'a5000000-0000-0000-0000-000000000011')$$, 'the owner cancels the filler');
select lives_ok($$select * from public.resend_team_invite('a5100000-0000-0000-0000-000000000002', (select id from public.team_invites where email = 'staff1@ti.test'),
                    'a5000000-0000-0000-0000-000000000011', pg_temp.h('R8'))$$, 'then the expired one can be resent');
select throws_ok($$select * from public.resend_team_invite('a5100000-0000-0000-0000-000000000002', (select id from public.team_invites where token_hash = pg_temp.h('M')),
                    'a5000000-0000-0000-0000-000000000011', pg_temp.h('R9'))$$,
  'PA404', null, 'a cancelled invitation cannot be resent');
select throws_ok($$select public.cancel_team_invite('a5100000-0000-0000-0000-000000000002', (select id from public.team_invites where token_hash = pg_temp.h('K')),
                    'a5000000-0000-0000-0000-000000000012')$$,
  'PA403', null, 'an admin cannot cancel an invitation for an admin');

-- Acceptance (T1: Trial, 2 seats; the owner plus an invitation for invitee1) ------------------------------------------------------------
select lives_ok($$select * from public.create_team_invite('a5100000-0000-0000-0000-000000000001', 'Invitee1@ti.test', 'Ira Invitee', 'staff',
                    'a5000000-0000-0000-0000-000000000001', pg_temp.h('T1'))$$, 'T1 invites invitee1 into its second seat');
select throws_ok($$select * from public.accept_team_invite(pg_temp.h('T1'), 'a5000000-0000-0000-0000-000000000003', 'wrong@ti.test')$$,
  'PA403', null, 'someone signed in with another email cannot accept');
select is((select accepted_at from public.team_invites where token_hash = pg_temp.h('T1')), null, 'and the invitation is still pending');
select throws_ok($$select * from public.accept_team_invite(pg_temp.h('nope'), 'a5000000-0000-0000-0000-000000000002', 'invitee1@ti.test')$$,
  'PA404', null, 'an unknown token is refused');
select throws_ok($$select * from public.accept_team_invite(pg_temp.h('T1'), 'a5000000-0000-0000-0000-000000000002', null)$$,
  'PA403', null, 'a user with no email cannot accept');
select results_eq($$select out_role, out_already_member from public.accept_team_invite(pg_temp.h('T1'), 'a5000000-0000-0000-0000-000000000002', 'INVITEE1@ti.test ')$$,
  $$values ('staff'::text, false)$$, 'the right person accepts, whatever the case of the address, and becomes staff');
select is((select display_name from public.memberships where tenant_id = 'a5100000-0000-0000-0000-000000000001' and user_id = 'a5000000-0000-0000-0000-000000000002'),
  'Ira Invitee', 'with the name from the invitation');
select is((select count(*)::int from public.memberships where user_id = 'a5000000-0000-0000-0000-000000000002'), 1, 'in that business only');
select is(pg_temp.used('a5100000-0000-0000-0000-000000000001'), 2, 'the reservation became the membership: still two seats');
select throws_ok($$select * from public.accept_team_invite(pg_temp.h('T1'), 'a5000000-0000-0000-0000-000000000002', 'invitee1@ti.test')$$,
  'PA404', null, 'the same link cannot be used twice');
select is((select count(*)::int from public.audit_logs where tenant_id = 'a5100000-0000-0000-0000-000000000001' and action = 'team_invite.accepted'
            and actor = 'a5000000-0000-0000-0000-000000000002'), 1, 'the acceptance is audited once');

-- Expired, cancelled and replaced links; an existing member; a plan lowered after the invitation ------------------------------------------------
select lives_ok($$select * from public.create_team_invite('a5100000-0000-0000-0000-000000000003', 'exp@ti.test', 'Exp', 'staff',
                    'a5000000-0000-0000-0000-000000000021', pg_temp.h('X1'))$$, 'T3 invites exp');
update public.team_invites set created_at = now() - interval '8 days', expires_at = now() - interval '1 day' where token_hash = pg_temp.h('X1');
select throws_ok($$select * from public.accept_team_invite(pg_temp.h('X1'), 'a5000000-0000-0000-0000-000000000003', 'exp@ti.test')$$,
  'PA404', null, 'an expired link cannot be accepted');
select lives_ok($$select * from public.create_team_invite('a5100000-0000-0000-0000-000000000003', 'gone@ti.test', 'Gone', 'staff',
                    'a5000000-0000-0000-0000-000000000021', pg_temp.h('X2'))$$, 'T3 invites gone');
select lives_ok($$select public.cancel_team_invite('a5100000-0000-0000-0000-000000000003', (select id from public.team_invites where token_hash = pg_temp.h('X2')),
                    'a5000000-0000-0000-0000-000000000021')$$, 'and cancels it');
select throws_ok($$select * from public.accept_team_invite(pg_temp.h('X2'), 'a5000000-0000-0000-0000-000000000003', 'gone@ti.test')$$,
  'PA404', null, 'a cancelled link cannot be accepted');
select lives_ok($$select * from public.create_team_invite('a5100000-0000-0000-0000-000000000003', 'gone@ti.test', 'Gone', 'staff',
                    'a5000000-0000-0000-0000-000000000021', pg_temp.h('X3'))$$, 'a cancelled address can be invited again');

insert into public.team_invites (tenant_id, email, name, role, token_hash, invited_by, expires_at)
  values ('a5100000-0000-0000-0000-000000000002', 'admin2@ti.test', 'Admin Two', 'staff', pg_temp.h('Y1'), 'a5000000-0000-0000-0000-000000000011', now() + interval '3 days');
select results_eq($$select out_role, out_already_member from public.accept_team_invite(pg_temp.h('Y1'), 'a5000000-0000-0000-0000-000000000012', 'admin2@ti.test')$$,
  $$values ('admin'::text, true)$$, 'a member who accepts an invitation keeps the role they have (never lowered, never raised)');
select isnt((select accepted_at from public.team_invites where token_hash = pg_temp.h('Y1')), null, 'and the invitation is used up');

select lives_ok($$select * from public.create_team_invite('a5100000-0000-0000-0000-000000000004', 'late4@ti.test', 'Late Four', 'staff',
                    'a5000000-0000-0000-0000-000000000031', pg_temp.h('Z1'))$$, 'T4 (Growth) invites late4');
update public.tenants set plan_key = 'trial' where id = 'a5100000-0000-0000-0000-000000000004';
select throws_ok($$select * from public.accept_team_invite(pg_temp.h('Z1'), 'a5000000-0000-0000-0000-000000000033', 'late4@ti.test')$$,
  'PA413', null, 'if the plan was lowered since, the database refuses the member');
select is((select accepted_at from public.team_invites where token_hash = pg_temp.h('Z1')), null, 'and the invitation stays pending');

-- Row-level security ----------------------------------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a5000000-0000-0000-0000-000000000011","role":"authenticated"}', true);
select is((select count(*)::int from public.team_invites where tenant_id = 'a5100000-0000-0000-0000-000000000002'), 4,
  'an owner reads all of their business''s invitations, pending, cancelled and used (without the token hash column)');
select is((select count(*)::int from public.team_invites where tenant_id <> 'a5100000-0000-0000-0000-000000000002'), 0, 'and no other business''s');
select throws_ok($$select token_hash from public.team_invites$$, '42501', null, 'asking for the token hash is refused');
select throws_ok($$select * from public.team_invites$$, '42501', null, 'so is select * (it includes the hash)');
select throws_ok($$update public.team_invites set role = 'admin'$$, '42501', null, 'the browser cannot change an invitation');
select set_config('request.jwt.claims', '{"sub":"a5000000-0000-0000-0000-000000000013","role":"authenticated"}', true);
select is((select count(*)::int from public.team_invites where tenant_id = 'a5100000-0000-0000-0000-000000000002'), 0, 'staff see no invitations');
select set_config('request.jwt.claims', '{"sub":"a5000000-0000-0000-0000-000000000021","role":"authenticated"}', true);
select is((select count(*)::int from public.team_invites where tenant_id = 'a5100000-0000-0000-0000-000000000002'), 0, 'another business''s owner sees none of them');
reset role;
set local role anon;
select throws_ok($$select id from public.team_invites$$, '42501', null, 'a visitor reads nothing');
reset role;

select * from finish();
rollback;
