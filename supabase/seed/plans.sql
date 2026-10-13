-- Plans (docs/handover.md, module 8). Prices in INR per month, GST extra.
-- Seats 999 = unlimited in the UI. Billing is PayU (0034): annual billing is 10x price_inr, computed by the server,
-- not a row here.

insert into public.plans (key, name, price_inr, monthly_credits, seats, whatsapp_numbers, feature_keys) values
('starter', 'Starter', 2499,  1500, 2,   1,
 array['ai_auto_reply','working_hours_mode','lead_qualification','booking','booking_confirmation','reminder_24h',
       'reminder_2h','staff_alerts','handoff_triggers','auto_topup','quote_auto_send','quote_followup','pretrip_info']),
('growth',  'Growth',  5999,  5000, 5,   1,
 array['ai_auto_reply','working_hours_mode','lead_qualification','booking','booking_confirmation','reminder_24h',
       'reminder_2h','staff_alerts','handoff_triggers','auto_topup','quote_auto_send','quote_followup','pretrip_info',
       'handoff_own_number','daily_agenda','followup_nudges','noshow_rebooking','feedback_request','review_request']),
('pro',     'Pro',    12999, 15000, 999, 3,
 array['ai_auto_reply','working_hours_mode','lead_qualification','booking','booking_confirmation','reminder_24h',
       'reminder_2h','staff_alerts','handoff_triggers','auto_topup','quote_auto_send','quote_followup','pretrip_info',
       'handoff_own_number','daily_agenda','followup_nudges','noshow_rebooking','feedback_request','review_request',
       'outbound_webhooks','custom_scoring']),
('trial',   'Trial',      0,   300, 2,   1,
 array['ai_auto_reply','working_hours_mode','lead_qualification','booking','booking_confirmation','reminder_24h',
       'reminder_2h','staff_alerts','handoff_triggers','quote_auto_send','quote_followup','pretrip_info',
       'handoff_own_number','daily_agenda','followup_nudges','noshow_rebooking','feedback_request','review_request'])
on conflict (key) do update set
  name = excluded.name,
  price_inr = excluded.price_inr,
  monthly_credits = excluded.monthly_credits,
  seats = excluded.seats,
  whatsapp_numbers = excluded.whatsapp_numbers,
  feature_keys = excluded.feature_keys;
