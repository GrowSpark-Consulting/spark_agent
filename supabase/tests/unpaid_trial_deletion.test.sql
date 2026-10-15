-- A business's data deleted 30 days after its trial ended unpaid, and the media both deletions remove (0048). Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(18);

insert into public.plans (key, name, price_inr, monthly_credits, seats, whatsapp_numbers, feature_keys) values
  ('trial', 'Trial', 0, 300, 2, 1, array['ai_auto_reply']),
  ('starter', 'Starter', 2499, 1500, 2, 1, array['ai_auto_reply'])
  on conflict (key) do nothing;
insert into auth.users (id, email) values ('0f900000-0000-0000-0000-0000000000a1', 'owner@unpaid.test');
insert into public.tenants (id, name, vertical, status, plan_key, trial_ends_at) values
  ('0f800000-0000-0000-0000-000000000001', 'Ended 31 days ago', 'test-pack', 'paused', 'trial', now() - interval '31 days'),
  ('0f800000-0000-0000-0000-000000000002', 'Ended 25 days ago', 'test-pack', 'paused', 'trial', now() - interval '25 days'),
  ('0f800000-0000-0000-0000-000000000003', 'Ended 10 days ago', 'test-pack', 'paused', 'trial', now() - interval '10 days'),
  ('0f800000-0000-0000-0000-000000000004', 'Paid once', 'test-pack', 'paused', 'trial', now() - interval '40 days'),
  ('0f800000-0000-0000-0000-000000000005', 'On a plan', 'test-pack', 'active', 'starter', null),
  ('0f800000-0000-0000-0000-000000000006', 'Checkout pending', 'test-pack', 'paused', 'trial', now() - interval '40 days');
insert into public.payments (tenant_id, kind, txnid, base_paise, gst_paise, amount_paise, status)
  values ('0f800000-0000-0000-0000-000000000004', 'topup', 'Tpaidonce', 119900, 21582, 141482, 'success');
insert into public.subscriptions (tenant_id, plan_key, status) values ('0f800000-0000-0000-0000-000000000006', 'starter', 'pending');

-- The business that goes: a member, a customer and a chat, a lead, a document, its trial number, and a file.
insert into public.memberships (tenant_id, user_id, role) values ('0f800000-0000-0000-0000-000000000001', '0f900000-0000-0000-0000-0000000000a1', 'owner');
insert into public.contacts (id, tenant_id, phone) values ('0f810000-0000-0000-0000-000000000001', '0f800000-0000-0000-0000-000000000001', '+919800000601');
insert into public.channels (id, tenant_id, type) values ('0f820000-0000-0000-0000-000000000001', '0f800000-0000-0000-0000-000000000001', 'whatsapp');
insert into public.conversations (id, tenant_id, contact_id, channel_id) values
  ('0f830000-0000-0000-0000-000000000001', '0f800000-0000-0000-0000-000000000001', '0f810000-0000-0000-0000-000000000001', '0f820000-0000-0000-0000-000000000001');
insert into public.messages (tenant_id, conversation_id, direction, sender, body) values
  ('0f800000-0000-0000-0000-000000000001', '0f830000-0000-0000-0000-000000000001', 'in', 'customer', 'hello');
insert into public.leads (tenant_id, contact_id) values ('0f800000-0000-0000-0000-000000000001', '0f810000-0000-0000-0000-000000000001');
insert into public.trial_phones (phone_hash, tenant_id) values (repeat('a', 64), '0f800000-0000-0000-0000-000000000001');
insert into storage.objects (bucket_id, name) values
  ('message-media', '0f800000-0000-0000-0000-000000000001/0f830000-0000-0000-0000-000000000001/0f840000-0000-0000-0000-000000000001.jpg'),
  ('message-media', '0f800000-0000-0000-0000-000000000002/0f830000-0000-0000-0000-000000000002/0f840000-0000-0000-0000-000000000002.pdf'),
  ('message-media', '0f800000-0000-0000-0000-000000000002/0f830000-0000-0000-0000-000000000003/0f840000-0000-0000-0000-000000000003.ogg');

-- Who is listed ----------------------------------------------------------------------------------------------------------------
select results_eq($$select tenant_id::text, due from public.unpaid_trials_for_cleanup()$$,
  $$values ('0f800000-0000-0000-0000-000000000001', true), ('0f800000-0000-0000-0000-000000000002', false)$$,
  'listed: a trial ended 30+ days ago (due) and one ended 23+ (warned first); not one ended 10 days ago, one that paid, one on a plan, or one with a checkout pending');
select ok((select deletes_on - trial_ended_at = interval '30 days' from public.unpaid_trials_for_cleanup() where due), 'deletion is 30 days after the trial ended');

-- Refused ------------------------------------------------------------------------------------------------------------------------
select results_eq($$select outcome from public.delete_unpaid_trial('0f800000-0000-0000-0000-000000000002')$$, $$values ('not_eligible'::text)$$, 'not before 30 days');
select results_eq($$select outcome from public.delete_unpaid_trial('0f800000-0000-0000-0000-000000000004')$$, $$values ('not_eligible'::text)$$, 'never a business that paid');
select results_eq($$select outcome from public.delete_unpaid_trial('0f800000-0000-0000-0000-000000000005')$$, $$values ('not_eligible'::text)$$, 'never one on a plan');
select results_eq($$select outcome from public.delete_unpaid_trial('0f800000-0000-0000-0000-000000000006')$$, $$values ('not_eligible'::text)$$, 'nor one with a checkout pending');

-- The deletion ----------------------------------------------------------------------------------------------------------------------
select results_eq($$select outcome, counts->>'members', counts->>'contacts', counts->>'messages', counts->>'leads' from public.delete_unpaid_trial('0f800000-0000-0000-0000-000000000001')$$,
  $$values ('deleted'::text, '1', '1', '1', '1')$$, 'it deletes the business, counting what went');
select is((select count(*)::int from public.tenants where id = '0f800000-0000-0000-0000-000000000001'), 0, 'the business is gone');
select is((select count(*)::int from public.messages where tenant_id = '0f800000-0000-0000-0000-000000000001')
        + (select count(*)::int from public.contacts where tenant_id = '0f800000-0000-0000-0000-000000000001')
        + (select count(*)::int from public.leads where tenant_id = '0f800000-0000-0000-0000-000000000001')
        + (select count(*)::int from public.memberships where tenant_id = '0f800000-0000-0000-0000-000000000001'), 0,
  'with its messages, customers, leads and members');
select results_eq($$select tenant_id from public.trial_phones where phone_hash = repeat('a', 64)$$, $$values (null::uuid)$$,
  'its trial number is kept, so the same number still cannot take a second free trial');
select results_eq($$select actor, diff->>'reason', diff->'counts'->>'messages' from public.audit_logs where action = 'tenant.deleted' and entity_id = '0f800000-0000-0000-0000-000000000001'$$,
  $$values ('system'::text, 'unpaid_trial'::text, '1'::text)$$, 'the audit records it, with counts only');
select results_eq($$select outcome from public.delete_unpaid_trial('0f800000-0000-0000-0000-000000000001')$$, $$values ('gone'::text)$$,
  'a retry after it went changes nothing');
select is((select count(*)::int from public.unpaid_trials_for_cleanup() where tenant_id = '0f800000-0000-0000-0000-000000000001'), 0, 'and it is no longer listed');

-- Media -----------------------------------------------------------------------------------------------------------------------------
select results_eq($$select * from public.media_object_names('0f800000-0000-0000-0000-000000000001')$$,
  $$values ('0f800000-0000-0000-0000-000000000001/0f830000-0000-0000-0000-000000000001/0f840000-0000-0000-0000-000000000001.jpg'::text)$$,
  'a deleted business''s files are still found by their path, for the server to remove');
select results_eq($$select * from public.media_object_names('0f800000-0000-0000-0000-000000000002', array['0f830000-0000-0000-0000-000000000003'::uuid])$$,
  $$values ('0f800000-0000-0000-0000-000000000002/0f830000-0000-0000-0000-000000000003/0f840000-0000-0000-0000-000000000003.ogg'::text)$$,
  'or only those of some chats');

-- A contact's deletion names the chats it removed (their files go next) ----------------------------------------------------------------
insert into public.contacts (id, tenant_id, phone) values ('0f810000-0000-0000-0000-000000000005', '0f800000-0000-0000-0000-000000000005', '+919800000605');
insert into public.channels (id, tenant_id, type) values ('0f820000-0000-0000-0000-000000000005', '0f800000-0000-0000-0000-000000000005', 'whatsapp');
insert into public.conversations (id, tenant_id, contact_id, channel_id) values
  ('0f830000-0000-0000-0000-000000000005', '0f800000-0000-0000-0000-000000000005', '0f810000-0000-0000-0000-000000000005', '0f820000-0000-0000-0000-000000000005');
select results_eq($$select outcome, conversation_ids from public.delete_contact_data('0f800000-0000-0000-0000-000000000005', '0f810000-0000-0000-0000-000000000005', 'u-1')$$,
  $$values ('deleted'::text, array['0f830000-0000-0000-0000-000000000005'::uuid])$$, 'a contact''s deletion returns the chats it removed');

select ok(not has_function_privilege('authenticated', 'public.unpaid_trials_for_cleanup(timestamptz)', 'execute')
          and not has_function_privilege('authenticated', 'public.delete_unpaid_trial(uuid, timestamptz)', 'execute')
          and not has_function_privilege('authenticated', 'public.media_object_names(uuid, uuid[])', 'execute'), 'server only: the new functions');
select ok(not has_function_privilege('authenticated', 'public.delete_contact_data(uuid, uuid, text)', 'execute')
          and not has_function_privilege('anon', 'public.delete_contact_data(uuid, uuid, text)', 'execute'), 'and the replaced one');

select * from finish();
rollback;
