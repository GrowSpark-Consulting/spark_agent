# Database Migrations Index (0001 – 0052)

Owner: Dev 2. Covers all Supabase Postgres migrations located in `supabase/migrations/`.

All migrations are additive, written in standard PostgreSQL dialect, and enforce Row-Level Security (RLS) on all tenant-facing tables.

---

## 1. Migration Overview & Subsystems

```
Core Schema (0001-0003) ──> Knowledge Base & Vector (0004, 0011-0012)
           │
           ├──> Booking & Slot Engine (0002, 0015, 0017, 0023, 0026)
           │
           ├──> Messaging & WhatsApp (0003, 0007, 0010, 0013-0014, 0020-0022, 0029, 0031-0033, 0047)
           │
           ├──> Credits & PayU Billing (0005-0006, 0008, 0027, 0034-0039, 0041-0042)
           │
           └──> Operations, Admin & Team (0016, 0018-0019, 0024-0025, 0028, 0040, 0043-0046, 0048-0052)
```

---

## 2. Comprehensive Migration Ledger

| # | Migration File | Subsystem | Description & Major Objects |
|---|---|---|---|
| `0001` | `0001_init.sql` | Core | Foundation schema: `tenants`, `profiles`, `memberships`, `plans`, `subscriptions`, `credit_ledger`, `conversations`, `messages`, `contacts`, `audit_logs`. Enables RLS across all tables. |
| `0002` | `0002_packs_and_bookings.sql` | Booking / Packs | `vertical_packs`, `bookings`, `resources`, `business_hours`, `services`. Enforces exclusionary lock on overlapping resource booking times. |
| `0003` | `0003_whatsapp_connections_and_consent.sql` | WhatsApp | `whatsapp_connections` (WABA credentials encrypted), `consent_records` (DPDP compliance log). |
| `0004` | `0004_kb_vector_index.sql` | Knowledge Base | Creates pgvector HNSW index on `kb_chunks.embedding` with 1536/1024 dimensions. |
| `0005` | `0005_credit_functions.sql` | Billing | Stored procedure `spend_credits(tenant_id, amount, feature, conv_id)` with row lock and FIFO expiration ordering. |
| `0006` | `0006_trial_signup.sql` | Billing / Onboarding | Stored procedure `start_trial(business_name, owner_email, pack_key)` granting 300 trial credits. |
| `0007` | `0007_whatsapp_templates.sql` | WhatsApp | `whatsapp_templates` table storing Meta template statuses, language variants, and interactive button schemas. |
| `0008` | `0008_credit_refunds.sql` | Billing | `refund_credits(tenant_id, amount, reason)` for undelivered WhatsApp template refunds. |
| `0009` | `0009_notify_functions.sql` | Notifications | Helper routines for outbound notification dispatch and template parameter interpolation. |
| `0010` | `0010_inbox_realtime.sql` | Inbox | Enables Supabase Realtime publication on `messages` and `conversations` for live dashboard chat updates. |
| `0011` | `0011_knowledge_base.sql` | Knowledge Base | `kb_documents`, `kb_chunks` with metadata tags and tenant scoping. |
| `0012` | `0012_kb_gap_functions.sql` | Knowledge Base | Vector similarity search functions (`match_kb_chunks`) and gap tracking for unanswered customer queries. |
| `0013` | `0013_inbound_messages.sql` | Messaging | Inbound message deduplication trigger on Meta `wamid` and conversation last-message tracking. |
| `0014` | `0014_connection_method_platform.sql` | WhatsApp | Adds `connection_method` enum (`embedded_signup`, `manual`, `platform`) for shared demo vs own number. |
| `0015` | `0015_booking_engine.sql` | Booking | `find_available_slots()`, `hold_slot()` (10-minute hold reservation), `confirm_booking()`. |
| `0016` | `0016_platform_admins_and_link_tokens.sql` | Operations | `platform_admins` table for superuser access; one-time magic link tokens for onboarding. |
| `0017` | `0017_google_calendar.sql` | Booking | `google_calendar_connections` storing encrypted refresh tokens and sync channel states. |
| `0018` | `0018_agent_merge_functions.sql` | Agent | Dynamic prompt builder merging vertical pack guidelines with tenant-specific custom prompt overrides. |
| `0019` | `0019_notify_staff_target.sql` | Notifications | Routes staff alerts by duty schedule and role permissions (owner vs assigned agent). |
| `0020` | `0020_whatsapp_webhook_tokens.sql` | WhatsApp | Per-tenant webhook verification tokens for businesses bringing their own Meta developer app. |
| `0021` | `0021_consent_functions.sql` | DPDP | `record_consent()`, `revoke_consent()`, and `delete_contact_data()` cascades. |
| `0022` | `0022_consent_model_intent.sql` | DPDP | Logs LLM-inferred consent signals and opt-out phrase matches ("STOP", "Unsubscribe"). |
| `0023` | `0023_booking_resource_lock.sql` | Booking | Stricter row-level locking during high-concurrency slot hold requests. |
| `0024` | `0024_api_roles_no_truncate.sql` | Security | Revokes `TRUNCATE` privileges from `authenticated` and `anon` Postgres roles. |
| `0025` | `0025_set_tenant_feature.sql` | Features | Stored procedure `set_tenant_feature(tenant_id, feature_key, enabled, settings)`. |
| `0026` | `0026_booking_actions.sql` | Booking | `reschedule_booking()`, `cancel_booking()`, `mark_visited()`, `mark_no_show()`. |
| `0027` | `0027_plan_limits.sql` | Billing | Enforces seat limits per tier (Starter: 2, Growth: 5, Pro: 15/999) via trigger on `memberships`. |
| `0028` | `0028_owner_admin_writes.sql` | RLS | Hardens write permissions: ensures only owners/admins can edit business settings and billing. |
| `0029` | `0029_demo_routing.sql` | Demo | Session isolation table routing WhatsApp messages on shared test number to distinct prospect sandboxes. |
| `0031` | `0031_store_inbound_platform_channel.sql` | WhatsApp | Inbound message channel normalizer mapping platform numbers to demo routing tables. |
| `0032` | `0032_platform_number_fallback.sql` | WhatsApp | Fallback routing for unassigned demo leads to Raja's notification queue. |
| `0033` | `0033_trial_phones.sql` | Onboarding | Associates verified owner phone numbers with trial signups to prevent trial fraud. |
| `0034` | `0034_credit_refund_retries.sql` | Billing | Idempotency key tracking on credit refunds to avoid double-crediting failed deliveries. |
| `0035` | `0035_payu_billing.sql` | Billing | **Decision 20 (PayU switch):** Replaces Razorpay fields with PayU mandate and subscription tracking columns (`mandate_id`, `amount_paise`, `billing_cycle`). |
| `0036` | `0036_payment_settlement.sql` | Billing | `payments` ledger tracking base amount, 18% GST paise, settlement status, and PayU transaction IDs (`txnid`). |
| `0037` | `0037_renewals.sql` | Billing | Automated renewal procedures, annual cycle credit distribution, and rollover logic (`cycle_reset`). |
| `0038` | `0038_plan_change.sql` | Billing | Prorated plan upgrades and scheduled next-cycle downgrades. |
| `0039` | `0039_trial_lifecycle.sql` | Billing | Trial expiration timestamps, reminder notification status flags, and grace-period states. |
| `0040` | `0040_staff_alert_platform_fallback.sql` | Notifications | Fallback delivery channel for staff alerts when tenant WhatsApp number is disconnected. |
| `0041` | `0041_admin_billing.sql` | Admin | Superuser billing views: revenue aggregate, active mandate health, MRR calculations. |
| `0042` | `0042_billing_cancel.sql` | Billing | Cancellation routines: marks mandate cancelled at PayU, retains credits through end of current paid cycle. |
| `0043` | `0043_contact_deletion.sql` | DPDP | Cascade deletion procedure wiping customer conversation history upon user request. |
| `0044` | `0044_ai_limits.sql` | Agent | Enforces daily spend limits per tenant to prevent runaway LLM API consumption. |
| `0045` | `0045_notify_attempts.sql` | Notifications | Exponential backoff attempt tracker for failed outbound WhatsApp calls. |
| `0046` | `0046_rls_tightening.sql` | Security | Closes edge-case read leakage on `whatsapp_connections` and `google_calendar_connections`. |
| `0047` | `0047_message_media.sql` | Media | `message_media` table tracking Supabase Storage pointers for voice notes, photos, and PDFs. |
| `0048` | `0048_unpaid_trial_deletion.sql` | DPDP | Sweeper procedure deleting expired trial data past 14-day retention limit. |
| `0049` | `0049_browser_write_audit.sql` | Audit | Audit trigger logging all user actions initiated from the Next.js dashboard. |
| `0050` | `0050_outbound_webhooks.sql` | Integration | Outbound webhook endpoint configurations, HMAC secret keys, and event dispatch queues. |
| `0051` | `0051_admin_metrics.sql` | Admin | Cost-per-credit aggregations, AI token expenditure, and trial-to-paid conversion SQL functions. |
| `0052` | `0052_team_invites.sql` | Team | Email invitation link tokens, seat reservation row locks (`FOR NO KEY UPDATE`), and team invite lifecycle. |

---

## 3. Deployment Instructions

To apply all migrations to a linked Supabase project (staging or production):

```bash
# 1. Verify diff against remote database
pnpm exec supabase db push --linked --dry-run

# 2. Apply migrations
pnpm exec supabase db push --linked --yes

# 3. Verify migration list matches local
pnpm exec supabase migration list --linked
```
