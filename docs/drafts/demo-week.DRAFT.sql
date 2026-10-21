-- ============================================================================================================================
-- DRAFT FOR REVIEW. NEVER RUN. NOT APPROVED. (Day 9, Dev 3, 16 Oct 2026)
--
-- A believable week of conversations and bookings for ONE dedicated demo tenant, so Home, Inbox, Leads and Calendar are not
-- empty on demo day. It is a draft because the things it needs have not been given:
--   1. The owner has not approved writing `messages` rows directly. Inserting them does not go through notify.send(), which the
--      project rules say all outbound messages use. Nothing is sent (no WhatsApp call is made by an insert), but it is an exception
--      to a non-negotiable rule and is the owner's to allow. See docs/task-notes/2026-10-16-day9-dev3-demo-seed-checklist.md.
--   2. It has not been run anywhere: no Docker on the machine that wrote it, so no disposable database, no `pnpm db:test`, no
--      second run to prove it is idempotent. The columns were read from migrations 0001, 0002, 0010, 0015, 0026 and 0043; none
--      of that was checked against a live schema.
--   3. Who runs it on staging, and when, is open.
--
-- It is kept in docs/drafts/, NOT in supabase/seed/ or supabase/migrations/, so `db reset` and `db push` can never pick it up.
-- The first statement below refuses to run. A reviewer who approves it removes that statement in the same change.
--
-- What it does, in one transaction:
--   * Creates (or refreshes) one tenant with a fixed id, e0000000-0000-4000-8000-000000000001, "Spark Agent Demo Dashboard".
--     It gets NO route code, so no live message on the shared demo number can ever land in it. It is not one of the three DEMO-*
--     businesses. Membership for the presenter is NOT created here (the repo is public, and there are no logins in it): add it by
--     hand as demo_tenants.sql's header describes.
--   * Deletes this tenant's previous seed rows (every statement is scoped by that tenant id; nothing is truncated) and inserts
--     them again, dated relative to now(), so "this week" is always this week. Deleting contacts cascades to their conversations,
--     messages, leads, bookings and handoffs (0001 foreign keys).
--   * Credits go through grant_credits() and spend_credits() (0005), never a direct ledger insert. spend_credits stamps now(),
--     so the credit history shows one moment, not a week; that is a limitation, not a bug to fix by editing the ledger.
--
-- Known limits to review:
--   * Home counts enquiries from the 1st of the current month. Run on the 1st to 3rd and the "week" is mostly last month's.
--   * Synthetic data only: fictional +1 555 555 01xx numbers (the reserved range) and generic first names. Nothing real.
--   * Messages carry no provider_msg_id, so they cannot collide with a real WhatsApp message id.
--   * The 0049 audit triggers do not audit service-role writes, and 0050 queues webhook events only for a business with a webhook
--     endpoint (this one has none). Both claims are from reading the migrations and have not been observed.
-- ============================================================================================================================

do $$ begin raise exception 'demo-week.DRAFT.sql is a draft: it has not been approved or run. Remove this statement only in the change that approves it.'; end $$;

begin;

-- A local-time helper: day offset and time of day in the business's zone, as an instant.
create function pg_temp.ist(days_ago int, tod time) returns timestamptz language sql stable as
$ select ((date_trunc('day', now() at time zone 'Asia/Kolkata') - make_interval(days => days_ago)) + tod) at time zone 'Asia/Kolkata' $;

-- 1. The tenant (kept if it exists, so the presenter's membership survives) ---------------------------------------------------
insert into public.tenants (id, name, vertical, status, plan_key, business_hours)
values ('e0000000-0000-4000-8000-000000000001', 'Spark Agent Demo Dashboard', 'real-estate', 'active', 'growth',
        '{"mon":[{"start":"09:30","end":"19:00"}],"tue":[{"start":"09:30","end":"19:00"}],"wed":[{"start":"09:30","end":"19:00"}],
          "thu":[{"start":"09:30","end":"19:00"}],"fri":[{"start":"09:30","end":"19:00"}],"sat":[{"start":"09:30","end":"19:00"}],
          "sun":[{"start":"10:00","end":"14:00"}]}')
on conflict (id) do update set name = excluded.name, status = excluded.status, plan_key = excluded.plan_key, business_hours = excluded.business_hours;

-- 2. Clear this tenant's previous seed (children of contacts cascade) -----------------------------------------------------------
delete from public.contacts where tenant_id = 'e0000000-0000-4000-8000-000000000001';
delete from public.credit_ledger where tenant_id = 'e0000000-0000-4000-8000-000000000001';
delete from public.channels where tenant_id = 'e0000000-0000-4000-8000-000000000001';
delete from public.services where tenant_id = 'e0000000-0000-4000-8000-000000000001';
delete from public.resources where tenant_id = 'e0000000-0000-4000-8000-000000000001';

-- 3. A number, two staff and one service --------------------------------------------------------------------------------------
insert into public.channels (id, tenant_id, type, phone_number_id, display_phone, status)
values ('e1000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'whatsapp', 'demo-week-synthetic', '+1 555 555 0100', 'active');

insert into public.resources (id, tenant_id, type, name, working_hours) values
  ('e2000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'staff', 'Site Executive 1', '{"mon":[{"start":"10:00","end":"18:00"}],"tue":[{"start":"10:00","end":"18:00"}],"wed":[{"start":"10:00","end":"18:00"}],"thu":[{"start":"10:00","end":"18:00"}],"fri":[{"start":"10:00","end":"18:00"}],"sat":[{"start":"10:00","end":"18:00"}]}'),
  ('e2000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000001', 'staff', 'Site Executive 2', '{"tue":[{"start":"10:00","end":"18:00"}],"thu":[{"start":"10:00","end":"18:00"}],"sat":[{"start":"10:00","end":"18:00"}]}');

insert into public.services (id, tenant_id, name, duration_min, resource_type)
values ('e3000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'Site visit', 60, 'staff');

-- 4. Eight customers and their leads. created_at spreads over the week, with three outside the business's hours (after-hours). -
insert into public.contacts (id, tenant_id, phone, name, language, consent_at) values
  ('e4000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', '+15555550101', 'Aarav',  'en', pg_temp.ist(6, '11:05')),
  ('e4000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000001', '+15555550102', 'Diya',   'ta', pg_temp.ist(5, '22:20')),
  ('e4000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000001', '+15555550103', 'Kabir',  'en', pg_temp.ist(4, '14:40')),
  ('e4000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-000000000001', '+15555550104', 'Meera',  'en', pg_temp.ist(3, '07:10')),
  ('e4000000-0000-4000-8000-000000000005', 'e0000000-0000-4000-8000-000000000001', '+15555550105', 'Rohan',  'en', pg_temp.ist(2, '16:30')),
  ('e4000000-0000-4000-8000-000000000006', 'e0000000-0000-4000-8000-000000000001', '+15555550106', 'Sana',   'ta', pg_temp.ist(1, '22:40')),
  ('e4000000-0000-4000-8000-000000000007', 'e0000000-0000-4000-8000-000000000001', '+15555550107', 'Vikram', 'en', pg_temp.ist(1, '10:15')),
  ('e4000000-0000-4000-8000-000000000008', 'e0000000-0000-4000-8000-000000000001', '+15555550108', 'Isha',   'en', pg_temp.ist(0, '09:50'));

-- Field keys are the real-estate pack's (packs/real-estate.json): budget, location, config, timeline, funding, decision_maker.
insert into public.leads (id, tenant_id, contact_id, stage, score, temperature, fields, created_at, updated_at) values
  ('e5000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'visited',   82, 'hot',  '{"budget":"80 lakh","location":"Velachery","config":"3BHK"}', pg_temp.ist(6, '11:05'), pg_temp.ist(2, '12:00')),
  ('e5000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000002', 'booked',    74, 'warm', '{"budget":"55 lakh","location":"OMR","config":"2BHK"}',       pg_temp.ist(5, '22:20'), pg_temp.ist(3, '09:00')),
  ('e5000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000003', 'qualified', 68, 'warm', '{"budget":"70 lakh","location":"Adyar","config":"3BHK"}',   pg_temp.ist(4, '14:40'), pg_temp.ist(4, '15:10')),
  ('e5000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000004', 'engaged',   45, 'cold', '{"budget":"40 lakh","location":"Tambaram"}',                  pg_temp.ist(3, '07:10'), pg_temp.ist(3, '07:25')),
  ('e5000000-0000-4000-8000-000000000005', 'e0000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000005', 'booked',    79, 'hot',  '{"budget":"90 lakh","location":"Velachery","config":"3BHK"}', pg_temp.ist(2, '16:30'), pg_temp.ist(1, '10:00')),
  ('e5000000-0000-4000-8000-000000000006', 'e0000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000006', 'human',     88, 'hot',  '{"budget":"1 crore","location":"OMR","config":"3BHK"}',   pg_temp.ist(1, '22:40'), pg_temp.ist(1, '22:55')),
  ('e5000000-0000-4000-8000-000000000007', 'e0000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000007', 'booked',    71, 'warm', '{"budget":"60 lakh","location":"Adyar","config":"2BHK"}',     pg_temp.ist(1, '10:15'), pg_temp.ist(0, '08:30')),
  ('e5000000-0000-4000-8000-000000000008', 'e0000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000008', 'new',       null, null, '{"location":"Velachery"}',                                    pg_temp.ist(0, '09:50'), pg_temp.ist(0, '09:50'));

-- 5. One chat per customer, mostly the assistant's, one waiting for a person (lead 6, an open hot-lead handoff). ---------------
insert into public.conversations (id, tenant_id, contact_id, channel_id, mode, last_customer_msg_at, created_at) values
  ('e6000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'ai',    pg_temp.ist(2, '11:40'), pg_temp.ist(6, '11:05')),
  ('e6000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000001', 'ai',    pg_temp.ist(3, '09:05'), pg_temp.ist(5, '22:20')),
  ('e6000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000001', 'ai',    pg_temp.ist(4, '15:05'), pg_temp.ist(4, '14:40')),
  ('e6000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000004', 'e1000000-0000-4000-8000-000000000001', 'ai',    pg_temp.ist(3, '07:20'), pg_temp.ist(3, '07:10')),
  ('e6000000-0000-4000-8000-000000000005', 'e0000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000005', 'e1000000-0000-4000-8000-000000000001', 'ai',    pg_temp.ist(1, '09:55'), pg_temp.ist(2, '16:30')),
  ('e6000000-0000-4000-8000-000000000006', 'e0000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000006', 'e1000000-0000-4000-8000-000000000001', 'human', pg_temp.ist(1, '22:52'), pg_temp.ist(1, '22:40')),
  ('e6000000-0000-4000-8000-000000000007', 'e0000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000007', 'e1000000-0000-4000-8000-000000000001', 'ai',    pg_temp.ist(0, '08:20'), pg_temp.ist(1, '10:15')),
  ('e6000000-0000-4000-8000-000000000008', 'e0000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000008', 'e1000000-0000-4000-8000-000000000001', 'ai',    pg_temp.ist(0, '09:50'), pg_temp.ist(0, '09:50'));

-- Messages: a short exchange per chat. Each assistant reply (sender 'ai') carries credits_charged = 1, the cost of an AI reply
-- (docs/credit-and-rollover-rules.md); the matching spend_credits calls are in step 7, so the ledger and the messages agree.
-- The after-hours chats (leads 2, 4, 6) have assistant replies at night, which fills Home's "handled overnight" figure
-- (the assistant's messages between 8 pm yesterday and 8 am today, so keep at least one of those inside that window).
insert into public.messages (id, tenant_id, conversation_id, direction, sender, kind, body, delivery_status, credits_charged, created_at) values
  ('e7000000-0000-4000-8000-000000000101', 'e0000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000001', 'in',  'customer', 'text', 'Hi, looking for a 3BHK in Velachery around 80 lakh.',                      null,   0, pg_temp.ist(6, '11:05')),
  ('e7000000-0000-4000-8000-000000000102', 'e0000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000001', 'out', 'ai', 'text', 'text',       'Happy to help. Skyline Towers has 3 BHK homes from 90 lakh; may I ask your timeline?', 'read', 1, pg_temp.ist(6, '11:05')),
  ('e7000000-0000-4000-8000-000000000103', 'e0000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000001', 'in',  'customer', 'text', 'Within three months. Can I visit this week?',                              null,   0, pg_temp.ist(2, '11:38')),
  ('e7000000-0000-4000-8000-000000000104', 'e0000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000001', 'out', 'ai', 'text', 'text',       'Yes. I have Thursday 11:00 or Friday 16:00 with a site executive.',            'read', 1, pg_temp.ist(2, '11:40')),
  ('e7000000-0000-4000-8000-000000000201', 'e0000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000002', 'in',  'customer', 'text', 'OMR la 2BHK irukka? Budget 55 lakh.',                                      null,   0, pg_temp.ist(5, '22:20')),
  ('e7000000-0000-4000-8000-000000000202', 'e0000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000002', 'out', 'ai', 'text', 'text',       'Aamam, Green Meadows OMR la 2BHK irukku. Site visit book pannalama?',          'read', 1, pg_temp.ist(5, '22:21')),
  ('e7000000-0000-4000-8000-000000000301', 'e0000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000003', 'in',  'customer', 'text', 'Do you have anything in Adyar under 70 lakh?',                             null,   0, pg_temp.ist(4, '14:40')),
  ('e7000000-0000-4000-8000-000000000302', 'e0000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000003', 'out', 'ai', 'text', 'text',       'Lake View Residency starts at 68 lakh. Shall I share the brochure?',           'read', 1, pg_temp.ist(4, '14:41')),
  ('e7000000-0000-4000-8000-000000000401', 'e0000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000004', 'in',  'customer', 'text', 'Any 2BHK near Tambaram?',                                                  null,   0, pg_temp.ist(3, '07:10')),
  ('e7000000-0000-4000-8000-000000000402', 'e0000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000004', 'out', 'ai', 'text', 'text',       'Good morning. What budget are you planning for?',                              'read', 1, pg_temp.ist(3, '07:11')),
  ('e7000000-0000-4000-8000-000000000501', 'e0000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000005', 'in',  'customer', 'text', 'Need a 3BHK, 90 lakh, can visit Saturday.',                                null,   0, pg_temp.ist(2, '16:30')),
  ('e7000000-0000-4000-8000-000000000502', 'e0000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000005', 'out', 'ai', 'text', 'text',       'Booked: Saturday 11:00 with Site Executive 1. You will get a reminder.',       'read', 1, pg_temp.ist(1, '09:55')),
  ('e7000000-0000-4000-8000-000000000601', 'e0000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000006', 'in',  'customer', 'text', 'I want to speak to someone about a 1 crore 3BHK on OMR tonight.',          null,   0, pg_temp.ist(1, '22:40')),
  ('e7000000-0000-4000-8000-000000000602', 'e0000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000006', 'out', 'ai', 'text', 'text',       'I have passed this to our team; someone will message you in the morning.',     'read', 1, pg_temp.ist(1, '22:41')),
  ('e7000000-0000-4000-8000-000000000603', 'e0000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000006', 'in',  'customer', 'text', 'Please call me first thing.',                                              null,   0, pg_temp.ist(1, '22:52')),
  ('e7000000-0000-4000-8000-000000000701', 'e0000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000007', 'in',  'customer', 'text', 'Is Friday 4 pm still open for a visit?',                                   null,   0, pg_temp.ist(0, '08:20')),
  ('e7000000-0000-4000-8000-000000000702', 'e0000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000007', 'out', 'ai', 'text', 'text',       'Yes, Friday 16:00 is free. Confirming it for you now.',                        'read', 1, pg_temp.ist(0, '08:21')),
  ('e7000000-0000-4000-8000-000000000801', 'e0000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000008', 'in',  'customer', 'text', 'Hello, what is available in Velachery?',                                   null,   0, pg_temp.ist(0, '09:50'));

-- An open hot-lead handoff on the chat waiting for a person.
insert into public.handoffs (id, tenant_id, conversation_id, trigger, priority)
values ('e8000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000006', 'hot_lead', 'high');

-- 6. Bookings: distinct slots (the exclusion constraint stops overlapping held or confirmed bookings on one resource). One today.
--    created_at and status_changed_at are set, because Home's "booked" counts bookings created this month with status
--    confirmed, completed or no_show.
insert into public.bookings (id, tenant_id, lead_id, resource_id, service_id, kind, details, start_at, end_at, status, created_at, status_changed_at) values
  ('e9000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'site_visit', '{"place":"Skyline Towers"}',      pg_temp.ist(3, '11:00'), pg_temp.ist(3, '12:00'), 'completed', pg_temp.ist(5, '09:30'), pg_temp.ist(3, '12:30')),
  ('e9000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000002', 'e2000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000001', 'site_visit', '{"place":"Green Meadows"}',       pg_temp.ist(1, '15:00'), pg_temp.ist(1, '16:00'), 'completed', pg_temp.ist(4, '10:00'), pg_temp.ist(1, '16:30')),
  ('e9000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000005', 'e2000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'site_visit', '{"place":"Skyline Towers"}',      pg_temp.ist(0, '16:00'), pg_temp.ist(0, '17:00'), 'confirmed', pg_temp.ist(1, '09:55'), pg_temp.ist(1, '09:55')),
  ('e9000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-000000000007', 'e2000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000001', 'site_visit', '{"place":"Lake View Residency"}', pg_temp.ist(-2, '16:00'), pg_temp.ist(-2, '17:00'), 'confirmed', pg_temp.ist(0, '08:21'), pg_temp.ist(0, '08:21'));

-- 7. Credits, through the functions. A plan's month, then one spend per assistant reply above (ref_id = the message). -----------
select public.grant_credits('e0000000-0000-4000-8000-000000000001', 1500, 'plan_grant');
select public.spend_credits('e0000000-0000-4000-8000-000000000001', 1, 'ai_reply', m.id)
from public.messages m
where m.tenant_id = 'e0000000-0000-4000-8000-000000000001' and m.sender = 'ai'
order by m.created_at;

commit;

-- ============================================================================================================================
-- Review checklist (all of it open):
--   [ ] Owner approves the direct `messages` insert (step 5), or names the approved alternative.
--   [ ] Run on a disposable local database: pnpm db:start, pnpm db:reset, remove the guard, run it, run it again. Row counts must
--       not change between the two runs; the 'bookings' exclusion constraint must not fire.
--   [ ] pnpm db:test still passes (seed.test.sql, isolation.test.sql, demo_routing.test.sql).
--   [ ] Sign in as the demo member: Home's four numbers equal select counts, worked out from the rows above and not yet observed:
--       enquiries 8 (only on or after the 7th of the month), qualified 5 (stages qualified, booked, visited, won: leads 1, 2, 3, 5, 7),
--       booked 4 (bookings created this month), after-hours at least 3 (leads 2, 4, 6; the weekday matters because Sunday's hours are
--       shorter, so leads 3 and 8 can count too). Inbox, Leads and Calendar show the week; a second business sees none of it.
--   [ ] The columns (channels.status text, bookings.kind/details/status_changed_at, contacts.deleted_at) match the live schema.
--   [ ] Only then on staging, once, by a developer, with the date recorded in a task note. Never `db reset --linked`.
-- Cleanup: delete from public.contacts / credit_ledger / channels / services / resources where tenant_id = 'e0000000-0000-4000-8000-000000000001'
-- (steps 2), then decide whether to keep the tenant row.
-- ============================================================================================================================
