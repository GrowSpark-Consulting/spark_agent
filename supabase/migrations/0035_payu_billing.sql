-- 0035_payu_billing: billing moves from Razorpay to PayU (decided 13 Oct 2026; replaces docs/handover.md, module 8's
-- Razorpay Subscriptions and Orders). A plan renews by auto-debit: the business approves a PayU mandate once (card,
-- UPI Autopay or net-banking e-NACH) and the server charges it each cycle. Top-ups and the setup fee are one-time
-- payments. No Razorpay code or data existed (no plan ids, no subscription rows on staging).
--
--   * plans: razorpay_plan_id goes. PayU has no plan objects: each mandate carries its own amount, from price_inr
--     (annual = 10x monthly), GST extra.
--   * subscriptions: one PayU mandate per row. status: pending (the business is approving it), active, past_due (a
--     renewal failed and is being retried), cancelled (revoked, replaced by a plan change, or given up). At most one
--     active or past_due row per business. amount_paise is what each renewal charges, GST included; mandate_id is
--     PayU's authpayuid (the mihpayid of the approval payment). next_plan_key holds a downgrade until the next cycle.
--     pre_debit_for is the period end a pre-debit notice went out for (RBI: at least 48 hours before the charge).
--   * payments: one row per PayU transaction we start (txnid is ours, max 25 characters for PayU). Members read their
--     business's payments (the Billing screen's history and invoices); only the server writes them. Credits granted
--     for a payment carry its id as credit_ledger.ref_id, so a repeated webhook grants nothing twice (0005).
--   * tenants.setup_call_paid_at: the optional setup fee was paid, so the business gets an assisted onboarding call.

alter table public.plans drop column razorpay_plan_id;

alter table public.subscriptions drop column razorpay_subscription_id;
alter table public.subscriptions
  add column provider text not null default 'payu' check (provider = 'payu'),
  add column billing_cycle text not null default 'monthly' check (billing_cycle in ('monthly', 'yearly')),
  add column amount_paise int check (amount_paise > 0),
  add column mandate_id text unique,
  add column mandate_method text check (mandate_method in ('card', 'upi', 'enach')),
  add column next_plan_key text references public.plans(key),
  add column pre_debit_for timestamptz,
  add column charge_attempts int not null default 0 check (charge_attempts >= 0),
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now(),
  add constraint subscriptions_status_check check (status in ('pending', 'active', 'past_due', 'cancelled'));

create unique index subscriptions_one_live_per_tenant on public.subscriptions (tenant_id) where status in ('active', 'past_due');

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  kind text not null check (kind in ('subscribe', 'renewal', 'plan_change', 'topup', 'setup_fee')),
  provider text not null default 'payu' check (provider = 'payu'),
  txnid text not null unique check (txnid ~ '^[A-Za-z0-9]{1,25}$'),
  base_paise int not null check (base_paise >= 0),          -- before GST
  gst_paise int not null check (gst_paise >= 0),
  amount_paise int not null,                                -- what PayU charges: base + GST
  plan_key text references public.plans(key),               -- subscribe, renewal, plan_change
  billing_cycle text check (billing_cycle in ('monthly', 'yearly')),
  status text not null default 'created' check (status in ('created', 'pending', 'success', 'failed')),
  provider_payment_id text,                                 -- PayU's mihpayid
  method text,                                              -- PayU's mode: CC, DC, UPI, NB, ...
  failure_reason text,
  created_by uuid references auth.users(id) on delete set null,  -- the member who started it; null for the renewal job
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  settled_at timestamptz,
  constraint payments_amount_adds_up check (amount_paise = base_paise + gst_paise)
);

create index payments_tenant_id_idx on public.payments (tenant_id, created_at desc);
create index payments_subscription_id_idx on public.payments (subscription_id);

create trigger payments_set_updated_at
  before update on public.payments
  for each row execute function public.set_updated_at();

alter table public.payments enable row level security;
create policy tenant_read on public.payments
  for select to authenticated using (public.is_member(tenant_id));

alter table public.tenants add column setup_call_paid_at timestamptz;
