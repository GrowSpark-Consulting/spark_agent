# Production checklist and backup plan

Owner: Dev 2. For Raja and whoever holds the `production` folder of the password manager. How each service is set up is in
[environments.md](environments.md); this file is what must be true before real businesses use production, how to check
it, and how we get the data back when something goes wrong. Nothing here is done by code: each line is a person doing it.

**Decisions for Raja** are marked ⚑. Until they are made, the box stays open.

## 0. Where we are (15 Oct 2026)

- The Supabase project the staging API uses today already holds real sign-ups. Treat it as production data now: no
  `db reset --linked`, no test writes, read-only checks only, and every migration push approved first.
- ⚑ Either that project becomes production (upgrade it to Pro, rename it) or production is a new Pro project and the
  real businesses move to it. Moving later costs more than deciding now.
- Open in **Database → Backups** on that project. If it lists no backups, nothing but our own dumps (section 9.3)
  protects the data today.

## 1. Accounts and plans

- [ ] Supabase: production project on **Pro** (daily backups, no pausing), region Mumbai (`ap-south-1`).
- [ ] ⚑ Supabase point-in-time recovery (a paid add-on): decides how much data a bad day can lose (section 9.1).
- [ ] Vercel Pro, Railway (a plan with no sleeping service), Inngest (a plan that covers our runs per month).
- [ ] Two people can sign in to every account (Raja + Dev 2), each with two-factor sign-in. Logins in the `accounts` folder.
- [ ] Billing alerts set on Supabase, Railway, Vercel, Inngest, Anthropic and the embeddings provider.

## 2. Railway, production environment (API)

Branch `production`; settings from `railway.json`. A missing or invalid variable fails the deploy and the log names it.

| Variable | Production value |
|---|---|
| `NEXT_PUBLIC_APP_URL` | `https://app.pakkaagent.in` |
| `CORS_ALLOWED_ORIGINS` | empty, or exact extra origins only; never `*`, never a preview URL |
| `API_PUBLIC_URL`, `INNGEST_SERVE_ORIGIN` | `https://api.pakkaagent.in` (origin only, no path) |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | the production project's |
| `ENCRYPTION_KEY` | its own, never staging's (`openssl rand -base64 32`); see 9.4 before you ever change it |
| `ANTHROPIC_API_KEY`, `EMBEDDINGS_API_KEY` | production keys, with spend limits set at the provider |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` | from the Inngest **Production** environment |
| `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `NEXT_PUBLIC_META_APP_ID`, `NEXT_PUBLIC_META_ES_CONFIG_ID`, `META_SYSTEM_USER_TOKEN`, `META_PARTNER_BUSINESS_ID` | the published Meta app's |
| `EMBEDDED_SIGNUP_ENABLED` | `true` only after Meta approves the app |
| `WHATSAPP_DEMO_WABA_ID`, `WHATSAPP_DEMO_PHONE_NUMBER_ID` | the shared trial number |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | redirect `https://api.pakkaagent.in/api/calendar/google/callback` |
| `PAYU_MERCHANT_KEY`, `PAYU_MERCHANT_SALT`, `PAYU_MODE` | ⚑ live key and salt and `PAYU_MODE=live`, set only on Raja's written go (section 6) |
| `RESEND_API_KEY`, `SENTRY_DSN` | production's |
| `PRIVACY_POLICY_URL` | the published policy page (https) |
| `RAILPACK_NODE_VERSION` | `22` |

Never set in production: `INNGEST_DEV`, `FAILURE_INJECTION`, `FAILURE_INJECTION_TENANTS` (refused with `PAYU_MODE=live`
anyway). ⚑ `LANGFUSE_CAPTURE_TEXT=true` sends customers' words to Langfuse: leave it off unless Raja decides otherwise.

- [ ] Every value above is in the password manager's `production` folder, named after its variable.
- [ ] No production value exists in any `.env.local`, chat, ticket or the repo.

## 3. Vercel, Production (frontend)

- [ ] Production branch `production`; domain `app.pakkaagent.in` on Production.
- [ ] `NEXT_PUBLIC_API_URL` = `https://api.pakkaagent.in`; `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
      = production's; Meta app id and config id; `NEXT_PUBLIC_DEMO_WHATSAPP_NUMBER`; `NEXT_PUBLIC_SETUP_CALL_URL`.
- [ ] No server secret on Vercel, and no `DEV_DASHBOARD_WITHOUT_TENANT`.
- [ ] Redeployed after the last `NEXT_PUBLIC_*` change (they are compiled in).

## 4. Supabase, production project

- [ ] Auth → URL configuration: Site URL `https://app.pakkaagent.in`, redirect `https://app.pakkaagent.in/**` only
      (no localhost, no staging).
- [ ] Auth email through Resend (custom SMTP), not Supabase's shared sender.
- [ ] Migrations: `supabase db push --linked --dry-run` lists exactly what is expected, then `--yes`.
      `supabase migration list --linked` shows local and remote the same.
- [ ] Seed plans and features only. Not the demo or isolation-test businesses.
- [ ] `platform_admins`: only the people Raja names.
- [ ] Database → Backups shows a backup from the last 24 hours (and PITR, if bought).
- [ ] The database password is in the `production` folder and nowhere else.

## 5. Inngest, Meta, Google, DNS

- [ ] Inngest Production: app synced to `https://api.pakkaagent.in/api/inngest`; the function count equals the list in
      `backend/src/inngest/functions.ts`; `system/ping` runs to Completed. Re-sync after every deploy that adds a function.
- [ ] Meta: ⚑ app published / Tech Provider route done (Raja). Callback `https://api.pakkaagent.in/api/webhooks/whatsapp`,
      verify token = `META_WEBHOOK_VERIFY_TOKEN`, subscribed to `messages`.
- [ ] Google OAuth client: production redirect URI added. ⚑ Publishing the consent screen needs Google's verification;
      in Testing, access ends after 7 days.
- [ ] DNS: `app` → Vercel, `api` → Railway production, Resend's SPF, DKIM and DMARC records.

## 6. PayU live (only on Raja's written go)

- [ ] Test-mode flows pass on staging with PayU's **test** credentials: subscribe, top-up, setup fee, renewal, a failed
      payment, cancel and resume.
- [ ] Raja confirms the live merchant account (settlement bank, mandate / auto-debit enabled).
- [ ] Live key, salt and `PAYU_MODE=live` set on Railway production only; never on staging, never on a laptop.
- [ ] PayU's webhook URL is `https://api.pakkaagent.in/api/webhooks/payu`.
- [ ] One real payment of the smallest amount by Raja, seen as settled in the app and in PayU's dashboard; refunded.

## 7. Go-live smoke test (after each production release)

- [ ] `GET https://api.pakkaagent.in/api/health` → `"env":"production"` and the released commit.
- [ ] Sign up a new account → trial business → wizard → test chat on the shared number answers.
- [ ] A connected business: a customer message gets one reply; the inbox shows it; staff can take over and reply.
- [ ] A booking is made, shows in the calendar, and its reminder is scheduled in Inngest.
- [ ] `audit_logs` has rows for the steps above, naming the right people.
- [ ] Railway logs over the test: no token, key, phone number or message text (the log rules in `lib/redact.ts`).

## 8. Running it

- Releases: tag on `main`, fast-forward `production`, deploy, smoke test (section 7). Migrations are pushed before the
  deploy that needs them, and every migration is additive or ships with its own data step.
- Watch: Railway's deploy and runtime logs, Inngest's failed runs, Sentry, Supabase's database health page.
- Who to call: Raja (accounts, PayU, Meta), Dev 2 (database, billing, deploys), Dev 1 (WhatsApp, the assistant).

## 9. Backup and restore

### 9.1 What protects what

| What | Where it lives | Protected by | Lost if we lose it |
|---|---|---|---|
| Businesses, customers, chats, bookings, payments, credits, audit log, Auth users | Supabase Postgres | Supabase daily backups (Pro, kept 7 days); PITR if bought; our weekly dump (9.3) | Everything |
| Customers' photos, voice notes, documents | Supabase Storage, bucket `message-media` | **Not** in database backups. Only Storage itself | Those files; the messages stay, without them |
| WhatsApp tokens, Google refresh tokens, webhook tokens | Postgres, encrypted with `ENCRYPTION_KEY` | The backups, but useless without the key | See 9.4 |
| Every secret and env value | Password manager, `production` folder | The password manager's own history | Hours of re-keying |
| Code, migrations, packs | GitHub | GitHub, plus every developer's clone | Nothing |
| Scheduled work (reminders, renewals, trials) | Inngest | Rebuilt from the database: the sweeps find what is due | Nothing lasting |

Targets (⚑ Raja to confirm): **lose at most 24 hours of data** (daily backups; minutes with PITR) and **be back within
4 hours**.

### 9.2 Retention and the right to delete (DPDP)

A customer's deletion (`delete_contact_data`) and an unpaid trial's deletion remove the rows at once; copies in backups
age out with the backups: 7 days for Supabase's, 4 weeks for our dumps (9.3). Tell a customer who asks: "deleted now,
gone from backups within 4 weeks." Nobody restores a backup to read deleted data.

### 9.3 Our own weekly dump

Supabase keeps 7 days. A weekly logical dump covers the case where a problem is noticed late, or the project itself is lost.

1. Monday, by Dev 2 (or Raja): from a trusted machine, with the production database password from the password manager:
   ```bash
   pnpm exec supabase db dump --linked -f prod-schema.sql
   pnpm exec supabase db dump --linked --data-only -f prod-data.sql
   pnpm exec supabase db dump --linked --role-only -f prod-roles.sql
   ```
2. Encrypt them before they leave the machine (a password-manager attachment, or `age`/`gpg` to Raja's and Dev 2's keys).
   Then delete the plain files.
3. Keep the last 4 weeks, in one place only the `production` folder's people can open. Never in the repo, chat, email or
   a shared drive.
4. Write the date and the row counts of `tenants`, `messages` and `payments` next to it, so a restore can be checked.

The dump holds customers' phone numbers and messages: it is production data and follows the same rules.

### 9.4 `ENCRYPTION_KEY`

- The key is in the `production` folder, and a second copy is with Raja (printed or offline), because without it a
  restored database cannot read a single stored token.
- Changing it is not built (encryption-and-env.md, section 7). If it is lost or replaced: every WhatsApp connection and
  Google Calendar must be connected again by its business, and open staff-alert links stop working (they expire in 24 h
  anyway). Plan that as an outage, with a message to every business.
- If it leaks: it stays in use until rotation exists. Revoke and reissue the WhatsApp and Google tokens it protects
  (the businesses reconnect), then replace the key.

### 9.5 Restore (an incident)

1. **Stop the damage.** Pause the Inngest functions (Inngest dashboard → each function → Pause) so jobs stop writing. If the API itself is
   writing bad data, remove the Railway production deployment's domain or roll back to the last good deploy.
2. **Pick the point.** The last backup (or PITR time) before the problem. Write down the time: everything after it is lost
   and needs step 5.
3. **Practise first if there is time:** restore into a new project and check it (9.6). Then restore production:
   Database → Backups → Restore (or PITR to the chosen time). The project is down while it restores.
4. **Schema:** `supabase migration list --linked`. If the backup is older than a migration, `supabase db push --linked`
   (dry-run first).
5. **Put back what happened after the point:**
   - Payments: compare PayU's dashboard for the window against `payments`. A payment PayU settled that the database no
     longer has is recorded by hand (Dev 2), with the business's credits and plan put right, and audited.
   - WhatsApp: messages in the window are not sent again by Meta. Tell the affected businesses; staff reply from WhatsApp.
   - Bookings made in the window are gone; their Google Calendar events may still exist. List them for the businesses.
   - Media files whose messages are gone stay in Storage: delete them through the Storage API (`backend/src/lib/storage.ts`); SQL cannot delete Storage files.
6. **Start again.** Deploy, resync Inngest, resume the functions, run the smoke test (section 7).
7. **Write it up** the same day: the cause, the window, what was put back and what was lost.

### 9.6 Restore drill (quarterly, and before go-live)

1. Restore the latest backup (or last week's dump) into a new, separate Supabase project. Never into staging or production.
2. Check: `supabase migration list` matches; the row counts are close to production's; the newest `messages` and
   `payments` rows are from the backup's day.
3. Do not connect an API to it and do not put the production `ENCRYPTION_KEY` anywhere new.
4. Delete the project. Write the date, how long it took and anything that did not work at the end of this file.

| Date | Restored from | Time taken | Notes |
|---|---|---|---|
| | | | |
