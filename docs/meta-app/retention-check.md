# Spark Agent policy verification

Audit baseline: `origin/main` at `2414c27e5277bc34d40444b0bc04a2f9b88e3fab` (16 October 2026). Draft reviewed: `C:\Users\my-pc\Downloads\policy-drafts.md`. That copy contains 90-day log, 30-day backup, 7-year billing/tax, 30-day chat/account-record, and 90-day backup-expiry figures. These are treated as unverified draft placeholders except where repo evidence independently supports a distinct claim.

## Retention verification

| Claim in draft | What the system/repo does | Status |
|---|---|---|
| Customer chats and messages: draft said 30 days; final policy says retained until deletion is requested or the account closes | No scheduled job deletes ordinary chats after 30 days. `supabase/migrations/0043_contact_deletion.sql` provides `delete_contact_data` for a business-initiated request; it removes that contact's conversations/messages and leads, then scrubs the contact row. `supabase/migrations/0048_unpaid_trial_deletion.sql` and `backend/src/inngest/unpaid-trial-cleanup.ts` delete an eligible unpaid-trial tenant 30 days after trial end. `backend/src/consent/deletion.ts` and `backend/src/billing/unpaid-trials.ts` remove associated message-media objects through Storage. | **FALSE** for a universal guarantee that chats are deleted whenever an account closes: code only proves request-based contact deletion and eligible unpaid-trial tenant deletion 30 days after trial end. The final wording is the requested policy statement, not an exact implementation description. |
| Account and support records: 30 days | No 30-day account/support-record cleanup is defined. The unpaid-trial job deletes eligible tenant-owned rows after 30 days from trial end; the migration explicitly leaves member login accounts and a tenant-deletion audit row. `supabase/migrations/0001_init.sql` defines account and audit tables; `0048_unpaid_trial_deletion.sql` defines the cascade. No support-ticket retention/deletion mechanism appears in the application migrations. | **FALSE** as a general 30-day promise. |
| Security/diagnostic logs: draft said 90 days; final policy says retained for up to 30 days in hosting infrastructure logs | The API emits operational events to stdout/stderr (for example `backend/src/inngest/process-message.ts`); the production checklist says to watch Railway runtime/deploy logs. `backend/src/lib/report.ts` sends redacted API/job/connection-health errors to Sentry when configured. `backend/src/agent/llm/tracing.ts` sends LLM trace metadata to Langfuse when configured. Inngest stores step results (the code limits them to IDs and small facts in `backend/src/agent/pipeline/process-message.ts` and `pipeline/store.ts`). `supabase/migrations/0001_init.sql` defines audit logs. The repo contains no active retention setting for Railway, Sentry, Inngest, or audit rows. | **NOT IN CODE** for a 30-day period. The 30-day wording was supplied for the policy but is not verified in repository code or docs; Dev 2 must confirm it. |
| Backups: draft said 30 days; final policy uses the requested database-provider-plan wording | `docs/production-checklist.md` describes a planned setup: Supabase Pro daily backups kept 7 days and manually created weekly encrypted dumps kept 4 weeks. It also says the checklist is not performed by code and asks operators to check the project's Backups page. No repository configuration proves that these plans are active in the production accounts. It states Storage media is not included in database backups. | **NOT IN CODE** for the active provider plan or current period. The final wording does not state a number and says the current period is confirmed by infrastructure. |
| Billing/tax records: draft said 7 years; final policy says retained as required by Indian accounting and tax laws and deleted when no longer required | `supabase/migrations/0035_payu_billing.sql` defines payment records; `0001_init.sql` defines `credit_ledger`. No `invoices` table or legal-period cleanup rule is present. There is no periodic billing-record deletion job. However, `0048_unpaid_trial_deletion.sql` deletes an eligible tenant, cascading to tenant-owned payment and ledger rows; its audit log is written separately and survives. | **NOT IN CODE** for legal retention periods. The wording is supplied as the policy rule; Raja must confirm it with accounting/legal advisers. Tenant deletion can cascade to billing rows. |
| Langfuse does not store customer message text | `backend/src/agent/llm/tracing.ts`: tracing is off unless both Langfuse keys are configured. A trace sends model, token/cost/latency details, input character count, tenant and conversation identifiers, prompt name/version and error metadata. `LANGFUSE_CAPTURE_TEXT` defaults off; only exactly `true` adds input and output text after phone/email masking and truncation to 2,000 characters. It never sends the system prompt. The repo does not establish the live setting. | **NOT IN CODE** as an unconditional production claim. Accurate wording must describe the default and the opt-in capture behavior; Raja/Dev 2 must confirm the live setting. |

## Providers used and processing locations in the repository

| Provider | Use and data path evidenced in repo | Processing location stated in repo |
|---|---|---|
| Railway | API hosting and runtime/deploy logs (`docs/production-checklist.md`, `railway.json`). | Production checklist says choose the region closest to Mumbai; it does not confirm the active region. |
| Vercel | Frontend hosting (`docs/production-checklist.md`). | Not specified. |
| Supabase | Postgres, Auth, Realtime and Storage (`supabase/config.toml`, migrations, `backend/src/lib/supabase-admin.ts`). | Mumbai (`ap-south-1`) is specified as the staging region and the intended production region in `docs/environments.md` and `docs/production-checklist.md`; active production location is not verified there. |
| Inngest | Job/event queue and execution, including message processing and cleanup (`backend/src/inngest/`). | Not specified. |
| Anthropic | AI extraction and reply generation; customer message text and relevant business-provided prompt/context are sent by `backend/src/agent/llm/anthropic.ts`. | Not specified. |
| MongoDB Atlas / Voyage AI | Embeddings endpoint uses Voyage `voyage-4` through the MongoDB Atlas Model API (`backend/src/kb/embeddings.ts`, `docs/embeddings-evaluation.md`); receives knowledge-base document text and search queries. | Not specified. |
| Langfuse | Optional LLM trace processing (`backend/src/agent/llm/tracing.ts`). | Default URL is Langfuse Cloud's EU endpoint; a base URL can be configured. |
| Sentry | Optional redacted API, terminal job-failure and WhatsApp connection-health events (`backend/src/lib/report.ts`, `docs/environments.md`). | Not specified. |
| Meta / WhatsApp | WhatsApp Business Platform carries inbound/outbound messages and connection/account identifiers (`backend/src/channels/whatsapp/`). | Not specified. |
| PayU | Hosted checkout, payment verification, renewals and payment webhooks (`backend/src/billing/payu.ts`, migrations 0035–0038). The checkout code supplies business name, owner email and phone with transaction/payment details. | India-specific PayU endpoints are in code; a data-processing region is not stated. |
| Google | Optional OAuth and Calendar integration (`backend/src/booking/google-calendar.ts`, `google-sync.ts`); booking event details are synchronized to the business's calendar. | Not specified. |
| Resend | Auth email delivery via custom SMTP is specified in the production checklist. | Not specified. |

The provider list describes integrations implemented or specifically configured by the repository. A business's own connected tools and destinations can add other recipients. Provider account settings and their contractual processing regions must be confirmed outside this repository.

## Needs an answer

- **Dev 2:** confirm the live Railway, Sentry and Inngest log/run retention settings; any Supabase audit-log cleanup; whether Langfuse trace capture is enabled; the live Supabase backup plan and current period; whether the manual weekly dumps are being created and their actual expiry; and the active hosting/database regions. In particular, verify the policy's "up to 30 days" hosting-infrastructure log statement.
- **Raja:** confirm the billing/tax wording with the relevant legal/accounting advisers. The repo cannot establish a legal minimum. Also confirm customer-request response deadlines and the account-closure deletion wording.
- **Raja and Dev 2:** confirm that the listed providers and processing locations match the live accounts and contracts, particularly the optional provider settings and the live Langfuse text-capture setting.

## Raja must decide / confirm

- Whether the draft's 30-day account/support claim is to be replaced (the repo has no such timer); approve an honest, figure-free retention statement.
- Billing/tax record retention period and handling, including the consequence that current unpaid-trial tenant deletion cascades to payment and credit-ledger rows. No period is invented here.
- Whether Langfuse is enabled in production and whether `LANGFUSE_CAPTURE_TEXT` is exactly `true`; the final policy states its code-defined default and conditional behavior.
- The legal/accounting retention periods, response deadlines, and any required qualifications. The drafts' 7-year, 30-business-day and 90-day statements are not code-enforced.
- Confirm contracting entity and venue with counsel (draft note in Terms section 12).
- Review the final scope of the indemnity clause with counsel (draft note in Terms section 11).
- Confirm the privacy grievance contact/address and whether the stated postal address and phone number remain current.
- Confirm provider names, live processing regions and contractual terms before publication, especially where this repository records only a planned configuration.

## Full change list

### Privacy Policy

- Normalized the service name to **Spark Agent** and used plain quotation marks in place of the draft's malformed smart-quote characters.
- Updated the effective and last-updated dates from 15 October 2026 to 16 October 2026.
- Replaced the unfinished provider placeholder `[LIST AND VERIFY BEFORE PUBLICATION]` with the verified provider list and the processing locations the repository actually records; described unknown locations as unspecified.
- Replaced the categorical Langfuse no-text statement with the repository-accurate behavior: trace metadata is sent when enabled, text capture is off by default, and setting `LANGFUSE_CAPTURE_TEXT=true` sends masked, shortened input and output text. Added that the live setting is not established by the repository.
- Replaced the unsupported 30-day customer chat and account/support periods with a statement that no general fixed period is set, records are kept as needed, customer deletion can be requested, and eligible unpaid trial tenant data is deleted 30 days after trial end.
- Removed unsupported 90-day log, 30-day backup and 7-year billing/tax figures. Replaced them with figure-free wording and the conditional backup-setting caveat.
- Replaced the prior figure-free chat and infrastructure wording with the exact user-supplied wording in all three policy pages: customer chats until deletion is requested or account closure; hosting infrastructure logs up to 30 days; backups according to the provider plan with the current period confirmed by infrastructure; billing/tax records as required by Indian accounting and tax laws and deleted when no longer required. The log figure and account-closure behavior are not verified by code; this is called out in the audit and assigned to Dev 2/Raja.
- Corrected `Indi.` to `India` and changed `No. F2, 1B` to `No. F2, Plot 1B` in the postal contact line.
- Removed the duplicated company name in the contact line.
- Added canonical links to the Privacy Policy, Terms and Data Deletion Instructions.

### Terms of Service

- Changed `spark Agent / Spark Agent` to **Spark Agent**.
- Normalized malformed smart-quote characters to plain quotation marks.
- Updated the effective and last-updated dates from 15 October 2026 to 16 October 2026.
- Completed the unfinished end of section 5 by removing the stray `.` and backtick after `taxes` and making the sentence grammatical: refund, cancellation, renewal and tax terms are those presented with the subscription and subject to law.
- Kept the indemnity and governing-law wording, but removed the two author notes from the publishable text and listed both in `Raja must decide / confirm`.
- Added canonical links to the Privacy Policy, Terms and Data Deletion Instructions.

### Data Deletion Instructions

- Normalized malformed smart-quote characters to plain quotation marks.
- Updated the effective and last-updated dates from 15 October 2026 to 16 October 2026.
- Changed the unsupported 90-day backup-expiry promise to the user-supplied provider-plan wording; stated that backup copies are not for ordinary access.
- Removed unsupported 30-business-day acknowledgement and 90-day completion targets. Replaced them with a figure-free statement tied to applicable law and listed the deadlines for Raja to confirm.
- Added canonical links to the Privacy Policy, Terms and Data Deletion Instructions; used vertical bars as plain separators.

### Repository housekeeping

- Added this verification record and a task note under `docs/task-notes/`.
- No code, migrations, configuration or Dev 2/Dev 3 files were changed.
