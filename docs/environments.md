# Environments, deploys and secrets

Owner: Dev 2. Covers GitHub, Supabase, Inngest, Vercel (frontend), Railway (API), DNS and the password
manager.

## Two deployables

```
Browser ──> Vercel: frontend/ (Next.js pages, sign-in, /auth/callback, server-rendered reads as the user)
   │  HTTPS, Authorization: Bearer <Supabase access token>, X-Pakka-Tenant
   v
Railway: backend/ (one Node service): /api/health, /api/templates, /api/messages/test,
         /api/onboarding/trial, /api/webhooks/whatsapp (Meta), /api/inngest (Inngest)
   └──> Supabase (Auth, Postgres + RLS)
```

The frontend holds public values only (`NEXT_PUBLIC_*`, the anon key). The service-role key, the
Meta secrets, `ENCRYPTION_KEY` and the Inngest keys exist only on Railway. The API checks every
browser call three times: CORS origin (`backend/src/server/cors.ts`), the bearer token with Supabase
Auth, and membership of the business named in `X-Pakka-Tenant` (`backend/src/server/auth.ts`).

## The three environments

| | Local | Staging | Production |
|---|---|---|---|
| App (Vercel) | http://localhost:3000 | https://staging.pakkaagent.in | https://app.pakkaagent.in |
| API (Railway) | http://localhost:4000 | https://api-staging.pakkaagent.in (or the Railway domain) | https://api.pakkaagent.in (or the Railway domain) |
| WhatsApp webhook | Meta test number via a tunnel | `<staging API>/api/webhooks/whatsapp` | `<production API>/api/webhooks/whatsapp` |
| Deploys from | your machine | every push to `main` | a tagged release (M6) |
| Supabase | Docker via `pnpm db:start` | project `pakka-agent-staging`, Mumbai, Free | project `pakka-agent-prod`, Mumbai, Pro |
| Inngest | `pnpm inngest:dev` | Inngest environment for staging | Inngest Production |
| PayU | test merchant key + salt | test merchant key + salt | live merchant key + salt (`PAYU_MODE=live`) |
| Secrets | `frontend/.env.local`, `backend/.env.local` (never committed) | Vercel *Preview* (branch `main`) + Railway `staging` | Vercel *Production* + Railway `production` |

Nobody points local code at staging or production data.

### API paths

Every API path starts with `/api/`, on every host: `https://api.pakkaagent.in/api/webhooks/whatsapp`.
There is no short-path rewrite any more; the routes are listed in `backend/src/server/routes.ts`.

## GitHub

Repo: https://github.com/GrowSpark-Consulting/AgentX (package name `pakka-agent`).

`main` protection:

- Pull request required; no approval needed, CI is the gate (team decision, Oct 2026)
- Required status checks `check` and `migrations` (jobs in `.github/workflows/ci.yml`), branch up to date
- Linear history, no force pushes, no deletion; applies to admins too
- Repo merges: squash only, head branches deleted after merge

CI runs on every pull request and every push to `main`:

| Job | Steps |
|---|---|
| `check` | `pnpm install --frozen-lockfile` → lint → typecheck → test → build |
| `migrations` | starts Postgres with the Supabase CLI, applies every migration from scratch, `supabase db lint` |

If you rename a job, update the required checks in branch protection in the same PR.

## Supabase

### Local

`pnpm db:start` runs the full stack in Docker (Postgres 17 + pgvector, Auth, Realtime, Storage,
Studio on :54323, Mailpit on :54324). `pnpm db:reset` rebuilds from `supabase/migrations`.
The CLI version is pinned in `package.json`, so everyone and CI run the same one.

### Staging project (one-time)

1. supabase.com → the team organisation → **New project**
   - Name `pakka-agent-staging`, region **South Asia (Mumbai) `ap-south-1`**, plan Free
   - Generate the database password and save it straight into the password manager (`staging`)
2. Project Settings → API: copy the URL, the anon/publishable key and the service_role/secret key
   into the password manager. The URL and anon key go into Vercel (Preview, branch `main`) and
   Railway (staging); the service_role key goes into Railway only.
3. Authentication → URL Configuration: Site URL `https://staging.pakkaagent.in`; add redirect URLs
   `https://staging.pakkaagent.in/**` and `http://localhost:3000/**`.
4. Link and push migrations from your machine:
   ```bash
   pnpm exec supabase login
   pnpm exec supabase link --project-ref <staging-ref>
   pnpm exec supabase db push
   ```
5. Load the seed (plans, features, demo and isolation-test businesses; safe to re-run):
   `pnpm exec supabase db push --include-seed`. Seed files and their order are in
   `supabase/config.toml` → `[db.seed].sql_paths`. The seed creates no logins; to give a signed-up
   user access to an isolation-test business, use the snippet at the top of
   `supabase/seed/demo_tenants.sql`. Never run `supabase db reset --linked`: it wipes the project.

Free projects pause after a week with no traffic; resume from the dashboard. Production
gets its own project on the Pro plan (daily backups, no pausing) before beta. What must be true before
go-live, and the backup and restore plan, are in [production-checklist.md](production-checklist.md).

### Platform admins

The people who work for us across businesses (`/api/admin/...` routes) are rows in
`platform_admins` (migration 0016). Raja decides who is on it. They sign up like anyone else; then, in
the Supabase SQL editor of each environment:

```sql
insert into public.platform_admins (user_id, note)
select id, 'Raja (founder)' from auth.users where email = '<their sign-in email>';
-- remove: delete from public.platform_admins where user_id = '<user id>';
```

The table is server only: nobody can read or change it from the browser.

## Sentry (errors and alert rules)

The API reports problems to Sentry when `SENTRY_DSN` is set on Railway (the project's DSN, https; unset, nothing is sent).
It posts to Sentry directly (`backend/src/lib/report.ts`), not through Sentry's SDK, so nothing is captured on its own:
only an error's kind, its message after the log redaction (keys and phone numbers masked), code locations, the route
pattern and ids. Never a request body, a header, a user or a customer's words. It never fails a request or a job and gives
up after 3 seconds. `environment` is the Railway environment and `release` the deployed commit.

What is sent, and its tags:

| Event | `kind` tag | Other tags | Grouped by |
|---|---|---|---|
| A route throws an unexpected error, or answers 500 (the WhatsApp webhook answers 500 itself so Meta retries) | `api_error` | `route` (the pattern, e.g. `/api/webhooks/whatsapp`), `method` | Sentry's own |
| A job failed for good, all retries used (the `report-failed-jobs` function, from Inngest's `inngest/function.failed`) | `job_failed` | `function`, `run` | one issue per function |
| A WhatsApp number failed its daily health check | `connection_health` (level warning) | `tenant`, `connection`, `reason` | per reason |

Not sent: a refusal (4xx), `/api/inngest` answering 500 (a failing step; the job's final failure is reported instead).

Alert rules to create in Sentry (Alerts → Create alert → Issues), one each, sending to Raja and Dev 2:

1. **Failed jobs:** when an issue is first seen or regresses, filter `kind:job_failed`. Add one for `function:pakka-agent-media-download` and one for `function:pakka-agent-process-message` with "more than 3 events in 10 minutes" if you want a louder alarm for the media job and the reply pipeline. The limit notice runs as a step of process-message, so its failure shows under that function.
2. **Webhook errors:** `kind:api_error` and `route:/api/webhooks/whatsapp` (and `/api/webhooks/payu`), more than 5 events in 5 minutes.
3. **API errors:** `kind:api_error`, a new issue, or more than 20 events in 10 minutes.
4. **Connection-health failures:** `kind:connection_health`, any event.

To test: `SENTRY_DSN` set, then an event appears after any 500. Alert rules are set in the Sentry dashboard, not in code.

## Inngest

There is exactly one Inngest endpoint: the API's `/api/inngest` on Railway (`inngest/edge` adapter,
`backend/src/inngest/serve.ts`). The frontend serves none, so **do not install the Inngest Vercel
Marketplace integration** (remove it if it is installed): it would try to sync the Vercel deploys.

- Local: `pnpm inngest:dev` serves the UI at http://localhost:8288 and syncs
  `http://localhost:4000/api/inngest`. `INNGEST_DEV=1` in `backend/.env.local` tells the SDK to use it.
- Staging and production, once per environment:
  1. Inngest dashboard → the environment → **Manage → Event keys**: create one; copy it to Railway as
     `INNGEST_EVENT_KEY`. **Manage → Signing key**: copy it to Railway as `INNGEST_SIGNING_KEY`.
  2. Set `INNGEST_SERVE_ORIGIN` on Railway to the API's public origin (e.g. `https://api.pakkaagent.in`),
     so the synced URL never comes from a request's Host header. Never set `INNGEST_DEV` on Railway.
  3. After the API is deployed: **Apps → Sync new app** → `https://<API host>/api/inngest`.
  4. Re-sync after a deploy that adds, removes or renames a function (Apps → the app → Resync, or
     `curl -X PUT https://<API host>/api/inngest`).
- In production mode the endpoint answers 401 to anything Inngest didn't sign, including GET.
- Smoke test after any new environment: send `system/ping` from the Inngest UI; a
  `system-ping` run should show status Completed.

## Google Calendar

Staff members connect their own Google Calendar from the dashboard (one connection per resource;
`docs/contracts.md` section 6). One-time setup, per Google Cloud project (Raja owns the account):

1. console.cloud.google.com → new project → **APIs & Services → Library** → enable **Google Calendar API**.
2. **OAuth consent screen**: External, app name and support email, scopes `openid`, `email`,
   `.../auth/calendar.events`, `.../auth/calendar.freebusy`. Leave it in **Testing** and add the testers'
   Google accounts as test users. In Testing, Google ends access after 7 days; the connection then shows
   "Reconnect". Publishing needs Google's verification (later).
3. **Credentials → Create OAuth client ID** → Web application. Authorized redirect URIs:
   `https://<API host>/api/calendar/google/callback` (staging: the Railway API origin) and
   `http://localhost:4000/api/calendar/google/callback` for local work.
4. Railway (API service): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` set to exactly
   the redirect URI registered above. Until all three are set, connect answers `not_available`.

## Vercel (frontend)

One project, `pakka-agent`, in the team's Vercel account (Pro: Hobby is for non-commercial use).

1. **Add New → Project** → import `GrowSpark-Consulting/AgentX` (install the Vercel GitHub app
   on the org if asked). Framework preset Next.js; **root directory `frontend`** (the Next.js app in the pnpm
   monorepo; keep "Include files outside the root directory" on so `packages/` and the two
   `backend/` read helpers are available). Build, install and output settings default.
2. Settings → Environment Variables: add `ENABLE_EXPERIMENTAL_COREPACK=1` to all environments so
   Vercel uses the pnpm version pinned in `packageManager`.
3. Settings → Git → **Production Branch: `production`**. Pushes to `main` then build as Preview
   deployments, which is our staging. A release fast-forwards `production` to the tagged commit.
4. Settings → Domains: `staging.pakkaagent.in` → **Git branch `main`**; `app.pakkaagent.in` → Production.
   (The `api.*` domains belong to Railway now.)
5. Environment variables, using the names in `frontend/.env.example` (public values only):
   `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and later
   `NEXT_PUBLIC_META_APP_ID`, `NEXT_PUBLIC_META_ES_CONFIG_ID`, and the optional `NEXT_PUBLIC_SETUP_CALL_URL` and
   `NEXT_PUBLIC_DEMO_WHATSAPP_NUMBER` (the shared trial/demo number; unset, the wizard says the test chat is unavailable).
   - **Preview**, scoped to branch `main`: staging values (`NEXT_PUBLIC_API_URL` = the staging API)
   - **Production**: production values
   - Never set server secrets (`SUPABASE_SERVICE_ROLE_KEY`, `META_*`, `INNGEST_*`, `ENCRYPTION_KEY`) or
     `DEV_DASHBOARD_WITHOUT_TENANT` on Vercel. `NEXT_PUBLIC_*` values are compiled in at build time:
     redeploy after changing one.
6. Server rendering runs in `bom1` (Mumbai, set in `frontend/vercel.json`) next to the Supabase database.

Per-PR preview URLs are not on the API's CORS list, so their API calls are refused. Test API changes
on staging, or add one exact preview origin to `CORS_ALLOWED_ORIGINS` for a while.

## Railway (API)

One service (`spark_agent` today) in one Railway project, with an environment each for staging and
production. Build and deploy settings are in `railway.json` at the repo root and override the dashboard.

| Setting | Value |
|---|---|
| Root Directory | repo root (blank): pnpm needs the workspace file and the lockfile |
| Build Command | `pnpm --filter @pakka/backend typecheck` (railway.json) |
| Start Command | `pnpm --filter @pakka/backend start` → `tsx src/server/main.ts` (railway.json) |
| Healthcheck Path | `/api/health` (railway.json) |
| Watch Paths | `backend/**`, `packages/**`, `packs/**`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `railway.json` |
| Branch | staging environment: `main`; production: `production` |
| Region | the one closest to Mumbai (the Supabase region) |
| Networking | Generate a public domain, or add `api-staging.pakkaagent.in` / `api.pakkaagent.in` as a custom domain |

The server listens on Railway's `PORT` on `0.0.0.0`, checks its environment before listening (a
missing or invalid variable fails the deploy and the log names it, never its value), and on SIGTERM
finishes requests in flight before exiting. It also validates `packs/*.json` and stores new pack versions
in `vertical_packs` before listening: an invalid pack or a changed published version fails the deploy the same
way, and so does a database that stays unreachable for about 40 seconds after the process started (a database
that is only briefly unavailable, such as one restarting during the deploy, is waited for: each wait is logged
as `[packs] the pack store is unavailable (try N, <code>)`; the waits fit inside the 60 s healthcheck).
`pnpm packs:sync [--check]` runs the same step by hand. Locally, `pnpm dev` therefore waits and then exits if
there is no database (start it with `pnpm db:start`).

Variables per environment (names in `backend/.env.example`): `NEXT_PUBLIC_APP_URL` (the frontend's
origin for this environment; always allowed by CORS), `CORS_ALLOWED_ORIGINS` (other exact origins,
comma-separated, never `*`), `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `EMBEDDINGS_API_KEY` (required), `ANTHROPIC_API_KEY` (required: the server does not start
without it), `META_WEBHOOK_VERIFY_TOKEN`, `META_APP_SECRET`, `ENCRYPTION_KEY`,
`INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `INNGEST_SERVE_ORIGIN`, and the rest of the file as
modules land. Optional: `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` together (LLM tracing; with neither,
tracing is off), `LANGFUSE_BASE_URL` (default `https://cloud.langfuse.com`, the EU cloud) and `LANGFUSE_CAPTURE_TEXT`
(`true` also sends customers' words and replies to Langfuse, masked; off by default). `RAILPACK_NODE_VERSION=22` builds
on the same Node as CI (`.nvmrc`).

Check a deploy: `https://<API host>/api/health` returns
`{"ok":true,"env":"<railway environment>","commit":"<sha>"}`.

### Failure injection (staging failure tests, Day 7)

For the exit test's failure checks ("with the model call forced to time out, the customer receives exactly one reply"),
staging can break the language model or WhatsApp for named test businesses only (`backend/src/lib/failure-injection.ts`):

1. Pick a test business (never a client's) and copy its id.
2. On Railway set `FAILURE_INJECTION` (any of `llm_timeout`, `llm_bad_json`, `whatsapp_send_error`, `whatsapp_send_timeout`,
   comma-separated) and `FAILURE_INJECTION_TENANTS` (that id; several, comma-separated), then deploy. The log says
   `[failure-injection] ON for 1 test business(es): ...` at the first model call or send.
3. Message the business's number and check the inbox, `messages` and `credit_ledger`: one reply (or none, for a send
   failure), no credit spent for a message that did not go.
4. Remove both variables and deploy again.

Every other business behaves as usual. Both variables go together, an unknown failure or a business that is not an id
fails the deploy, and so does injection alongside `PAYU_MODE=live`: a deployment that takes real money is production.

### Webhook burst test (Day 8)

Meta retries a webhook that answers slowly or with an error, and the 10-second reply target starts when it arrives, so the
route must answer 200 quickly under a burst. `pnpm --filter @pakka/backend webhook:burst -- <API origin> [total=200] [concurrency=20]`
sends signed webhooks for a phone number id no business owns (the server checks the signature and looks the number up,
and stores and sends nothing). It prints status counts and p50, p95 and max in ms, and exits 1 unless every answer was 200 and
p95 is at most 2000 ms. `META_APP_SECRET` must be in the environment: run it through `railway run` so the secret is not copied
to a laptop.

## DNS for pakkaagent.in

Add at the domain's DNS provider. Vercel and Railway show the exact target for each custom domain
when you add it; use those values.

| Name | Type | Value | Serves |
|---|---|---|---|
| `staging` | CNAME | Vercel target | Staging app |
| `api-staging` | CNAME | Railway target (staging environment) | Staging API and webhooks |
| `app` | CNAME | Vercel target | Production app |
| `api` | CNAME | Railway target (production environment) | Production API and webhooks |
| `@`, `www` | A / CNAME | Vercel values | Landing page (Dev 3) |
| Resend records | MX, TXT (SPF, DKIM), `_dmarc` TXT | From the Resend dashboard | System email |

Moving a custom domain changes its origin: update `NEXT_PUBLIC_API_URL` on Vercel (and redeploy),
`NEXT_PUBLIC_APP_URL` / `CORS_ALLOWED_ORIGINS` and `INNGEST_SERVE_ORIGIN` on Railway, the Inngest app
URL, the Meta callback URL, and Supabase Auth's Site URL and redirect URLs.

Railway also needs `API_PUBLIC_URL` (this API's https origin, no path, e.g. the Railway or custom domain) so the
onboarding screen can show clients the callback URL for their own Meta app, and optionally
`META_PARTNER_BUSINESS_ID` (Spark Agent's Business Portfolio ID, digits). Neither is a secret. Without
`API_PUBLIC_URL` the screen says the address isn't available instead of guessing one. A client's own Meta app
uses a per-business verify token shown on that screen, not `META_WEBHOOK_VERIFY_TOKEN`.

Meta's webhook check: the Meta app's callback URL is `https://<API host>/api/webhooks/whatsapp`
(note `/api/`), and its verify token is the Railway environment's `META_WEBHOOK_VERIFY_TOKEN`. Only
the GET verification exists today; don't subscribe the app to `messages` until the POST handler is
merged. Use the staging API for the test app, and move the callback to the production API when
production goes live (or give staging its own Meta test app).

## Password manager

One shared vault, **Pakka Agent**, in a team password manager (Bitwarden Teams or 1Password
Business). Every credential lives there; nothing is pasted into chat.

| Folder | Who | Holds |
|---|---|---|
| `accounts` | Raja + all devs | Logins: Meta Business, Meta developer app, PayU, Google Cloud, Supabase, Vercel, Railway, Inngest, Sentry, Langfuse, Resend, domain registrar, GitHub org |
| `local` | All devs | Shared test-only values: Meta test number, Anthropic dev key, embeddings key, PayU test merchant key and salt |
| `staging` | All devs | Every staging env var, Supabase DB password |
| `production` | Raja + Dev 2 | Every production env var, Supabase DB password, `ENCRYPTION_KEY` |

Name each item after its env var (`ANTHROPIC_API_KEY`) so copying into Railway or Vercel is mechanical. Use a
different `ENCRYPTION_KEY` per environment (`openssl rand -base64 32`). If a production key leaks,
rotating it is a deploy, not a code change.
