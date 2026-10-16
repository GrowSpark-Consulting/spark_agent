# Payment Gateway Test-to-Live Runbook (PayU / Razorpay Switch)

Owner: Dev 2. Audience: Raja (Account Owner) and Operations.

---

## 1. Provider Context: PayU (Decision 20)

While initial Day 1 architectural sketches referenced Razorpay, **Decision 20** (finalized 13 Oct 2026, schema Migration `0035_payu_billing.sql`) selected **PayU** as the production payment gateway for Pakka Agent.

PayU handles:
1. **Recurring Mandates (Auto-Debit):** Monthly and annual subscriptions via UPI Autopay (up to ₹15,000 RBI cap), Cards (e-Mandate), and Netbanking (e-NACH).
2. **One-Time Payments:** Credit top-ups (₹1,199) and the optional assisted setup fee (₹4,999).
3. **Webhooks:** Automated settlement callbacks processed by `backend/src/billing/checkout.ts` and `backend/src/server/routes.ts` (`POST /api/webhooks/payu`).

---

## 2. Pre-Switch Checklist (Owned by Raja)

Before any production traffic is enabled:
- [ ] PayU merchant onboarding & KYC verified and approved.
- [ ] Recurring Payments (Standing Instructions / SI) and UPI Autopay enabled on the merchant account.
- [ ] Settlement bank account connected and verified.
- [ ] Production PayU Merchant Key and Merchant Salt copied directly into the Password Manager (`production` folder). **Never paste keys in chat or git.**

---

## 3. Step-by-Step Production Cutover

### Step 1: Configure Railway Production Environment
In Railway (Project: `pakka-agent`, Environment: `production`, Service: `spark_agent` / Backend API):

Set the following variables:
```ini
PAYU_MODE=live
PAYU_MERCHANT_KEY=<production-merchant-key>
PAYU_MERCHANT_SALT=<production-merchant-salt>
```

> **Safety Guardrail:** The backend automatically rejects boot with `PAYU_MODE=live` if failure injection variables (`FAILURE_INJECTION`) are detected (`backend/src/lib/env.ts`).

### Step 2: Register Webhook in PayU Dashboard
1. Log in to the PayU Merchant Dashboard.
2. Navigate to **Settings → Webhooks / IPN**.
3. Set the Webhook Callback URL to:
   ```
   https://api.pakkaagent.in/api/webhooks/payu
   ```
4. Enable webhook notifications for:
   - `Transaction Status Updates` (Success, Failure, Dropped)
   - `Mandate Registration & Authorization`
   - `Recurring Auto-Debit Debits`

### Step 3: Configure Return URLs in Next.js Frontend
Ensure `NEXT_PUBLIC_API_URL` points to `https://api.pakkaagent.in`. PayU redirects customers back to:
- Success: `https://app.pakkaagent.in/dashboard/billing?status=success`
- Failure: `https://app.pakkaagent.in/dashboard/billing?status=failure`

---

## 4. Live Smoke Test and Verification Drill

Immediately after cutover:
1. **Initiate Test Payment:** Raja initiates a ₹1,199 credit top-up pack from the live dashboard (`https://app.pakkaagent.in/dashboard/billing`).
2. **Verify Database Records:**
   - Confirm row created in `public.payments` with `status = 'captured'` and matching `txnid`.
   - Confirm `1000` credits added to `public.credit_ledger` with `expires_at = now() + 90 days`.
3. **Issue Refund:**
   - From PayU Merchant Dashboard, initiate a full refund for the test transaction.
   - Verify refund reaches the test account within banking SLA.

---

## 5. Rollback Plan

If any critical payment error occurs in live mode:
1. Set `PAYU_MODE=test` on Railway production.
2. Replace credentials with test sandbox key/salt.
3. Redeploy Railway service (`< 60 seconds`).
4. Display maintenance banner on billing screens via Next.js feature toggle.
