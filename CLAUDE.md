# Spark Agent

Multi-tenant SaaS. A business connects WhatsApp; an AI assistant answers, qualifies, books,
reminds and hands off to staff. Billing in credits. Full specs: docs/handover.md.

## Stack
Frontend: Next.js 16 (App Router, TS strict) on Vercel · API: one Node service (node:http + tsx,
backend/) on Railway · Supabase (Postgres, Auth, Realtime, pgvector) · Inngest jobs · Anthropic API ·
Meta WhatsApp Cloud API (direct, no BSP) · PayU (billing) · Tailwind + shadcn/ui · Zod · Vitest

## Non-negotiable rules
- Every table has tenant_id and RLS. Every server query filters by tenant_id.
- Code decides, the LLM only extracts (step 4) and writes text (step 7). No business logic in prompts.
- All outbound messages go through notify.send(). All credit changes go through spend_credits().
- Check isEnabled(tenantId, featureKey) before any optional behaviour.
- Validate every external input and every LLM output with Zod.
- Webhooks and Inngest steps must be idempotent.
- WhatsApp tokens and app secrets live only in whatsapp_connections, encrypted; never log, return or send them to the browser.
- Never write industry names in code; branch on pack capabilities.
- Never commit secrets. Mask phone numbers in logs.
- Migrations are append-only in supabase/migrations.
- Channels are adapters (backend/src/channels), industries are packs (packs/*.json), features are rows in `features`.
- Read server env through `serverEnv()` in backend/src/lib/env.ts; add new variables to its schema and to
  backend/.env.example. Browser-safe NEXT_PUBLIC_* values go in frontend/lib/env.ts and frontend/.env.example.

## Where things live
pnpm monorepo, two deployables:
- frontend/ (Vercel): pages, sign-in and /auth/callback, server-rendered reads as the signed-in user
  (anon key + RLS). No app/api routes and no server secrets. The browser calls the API only through
  frontend/lib/api/client.ts (`${NEXT_PUBLIC_API_URL}/api/...`, Bearer token, X-Pakka-Tenant).
- backend/ (Railway): @pakka/backend, the API service. Every endpoint is in backend/src/server/routes.ts
  (auth.ts verifies the token and the tenant, cors.ts the origin); webhooks and /api/inngest live here.
  Service-role and other secret-using code runs only here. The frontend may import only
  @pakka/backend/lib/tenant and channels/whatsapp/connections (ESLint enforces it).
packages/types (shared contracts), packages/config.
backend/src: server  channels/whatsapp(+/connect)  agent  booking  notify  billing  consent  features  kb  inngest  lib
frontend: app/  components/{ui,dashboard,onboarding}  features/<screen>  fixtures/  lib/  styles/  tests/
packs/ · tests/conversations/ · supabase/migrations/ · docs/frontend-architecture-map.md · docs/environments.md

## Commands
pnpm dev (frontend :3000 + API :4000) · pnpm inngest:dev · pnpm test · pnpm typecheck · pnpm lint · pnpm build · pnpm test:e2e
(root scripts run every workspace; one package: pnpm --filter @pakka/frontend <script>)
pnpm db:start · pnpm db:reset · pnpm db:test · pnpm db:status · pnpm db:stop · pnpm packs:sync [-- --check]
Local env files: frontend/.env.local (public values, from frontend/.env.example) and backend/.env.local
(server values, from backend/.env.example). Neither is ever committed.
pnpm test:conversations (scripted chats, mocked models; add -- --live for the real models, never in CI)
Coming later: pnpm packs:migrate (M7)

## Before you finish a task
Run typecheck, lint and tests. Update tests/conversations if agent behaviour changed (see tests/conversations/README.md).

@AGENTS.md
