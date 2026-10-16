# Credit and Rollover Rules

Owner: Dev 2. Implemented in `backend/src/billing/credits.ts`, `backend/src/billing/renewals.ts`, and database functions in `supabase/migrations/0005_credit_functions.sql`, `0008_credit_refunds.sql`, `0034_credit_refund_retries.sql`, and `0037_renewals.sql`.

---

## 1. Plan Allowances and Pricing

| Plan Tier | Monthly Price (excl. GST) | Monthly Credits | Rollover Validity | Target Business Size |
|---|---|---|---|---|
| **Free Trial** | ₹0 (14 days) | **300 credits** | 14 days (expires at trial end) | Evaluating product fit |
| **Starter** | ₹2,499 | **1,500 credits** | 1 cycle rollover (60 days from grant) | Solo practitioner / small shop (~100 leads) |
| **Growth** | ₹5,999 | **5,000 credits** | 1 cycle rollover (60 days from grant) | Growing business (~350 leads) |
| **Pro** | ₹12,999 | **15,000 credits** | 1 cycle rollover (60 days from grant) | High-volume agency / multi-branch (~1,000 leads) |

*Annual plans:* Sold at 10× monthly price (2 months free). Full annual amount paid upfront; monthly credits are granted in monthly tranches via `inngest/billing-renewals.ts` (`grantAnnualMonths`).

---

## 2. Top-Up Credits

- **Pack Size:** 1,000 credits for ₹1,199 (₹1.20 per credit).
- **Payment Method:** PayU one-time payment (UPI, Netbanking, Card).
- **Validity:** Top-up credits expire **90 days** from the time of purchase (`expires_at = now() + interval '90 days'`).
- **Resumption:** If a tenant's agent is paused due to zero credits, purchasing a top-up immediately sets `tenants.is_agent_paused = false` and resumes AI answering.

---

## 3. Rollover Mechanics

Unused plan credits roll over for **exactly one billing cycle**:

1. **Cycle Grant:**
   - When a plan renews or activates, `plan_grant` inserts a row into `credit_ledger` with:
     ```sql
     expires_at = now() + interval '60 days'  -- covers current cycle + 1 rollover cycle
     ```
2. **Cycle Reset at Renewal:**
   - Before granting new credits, `inngest/billing-renewals.ts` executes a `cycle_reset` step.
   - Any credits remaining from two cycles ago (`expires_at < now()`) are expired and cannot roll over into a third cycle.
3. **Rollover Cap:**
   - Maximum active plan balance at any time is 2× the monthly plan allowance (e.g. max 10,000 credits for Growth). Top-up credits are independent and tracked separately.

---

## 4. Deduction Order and Atomic Locking (`spend_credits`)

All deductions occur through the database stored procedure `public.spend_credits()`:

```sql
SELECT * FROM public.spend_credits(
  p_tenant_id := '...',
  p_amount := 1,
  p_feature_key := 'ai_reply',
  p_conversation_id := '...'
);
```

### Invariants & Guarantees:
1. **Row Lock (`FOR UPDATE`):** Locks the tenant row and ledger entries to prevent race conditions during concurrent webhook deliveries.
2. **FIFO Expiry Order:** Credits with the **soonest expiration date (`expires_at ASC`) are deducted first**. Plan rollover credits expire before fresh monthly credits, which expire before 90-day top-ups.
3. **No Negative Balance:** If `balance < p_amount`, the transaction rolls back with code `INSUFFICIENT_CREDITS`. The balance never drops below zero.
4. **Audit Trail:** Every deduction inserts a row into `credit_ledger` recording `amount` (negative), `balance_after`, `feature_key`, and `conversation_id`.

---

## 5. Feature Cost Schedule

| Feature | Credit Cost | Rule / Trigger |
|---|---|---|
| **AI Reply** (`ai_reply`) | **1 credit** | Deducted when Claude 3.5 Sonnet generates an outbound message to a customer. |
| **Marketing Template** (`marketing_template`) | **1 credit** | WhatsApp outbound template message (inside or outside 24h customer window). |
| **Utility / Reminder Template** (`utility_template`) | **1 credit** | 24h/2h booking reminders and rebooking nudges. |
| **Daily Agenda** (`daily_agenda`) | **0 credits (Free)** | Morning briefing sent to staff on Growth and Pro plans. |
| **Handoff Alert** (`handoff_alert`) | **0 credits (Free)** | Escalation alert to staff when customer requests human takeover. |
| **Phone Reply Return** | **0 credits (Free)** | Re-enabling the agent after manual takeover. |

---

## 6. Credit Alerts and Low-Balance Handling

1. **Low Credit Warning (`billing.credits_low`):**
   - Triggered when balance drops below **50 credits** or **15% of plan allocation**.
   - Dispatches a WhatsApp notification to the owner with a 1-tap PayU top-up payment link.
   - Rate-limited to at most 1 alert every 24 hours per tenant.
2. **Zero-Credit Fallback:**
   - When balance reaches **0 credits**:
     - `tenants.is_agent_paused` is set to `true`.
     - The agent sends **one final polite holding message**:
       > *"We have received your message. Our team is currently attending to inquiries and will reply shortly."*
     - The conversation is flipped to `mode = 'human'`, and incoming chats appear directly in the staff inbox without AI interruption.
     - No credits are charged, and no customer messages are dropped.
