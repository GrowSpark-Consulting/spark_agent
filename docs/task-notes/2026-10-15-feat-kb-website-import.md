# 15 Oct (Dev 1): single-page website import into the knowledge base (Day 7 carry-over)

For Dev 2 and Dev 3. Dev 1 files, plus a few small changes in shared files, each listed in sections 4 and 5: `backend/src/kb/` (`website.ts`, `fetch-page.ts`, `html-text.ts` new; `store.ts`, `ingest.ts`, `events.ts` changed; tests for each), `backend/src/test-support/fake-kb-store.ts`, two entries in `backend/src/server/routes.ts`, `packages/types/src/kb-import.ts` (new, exported from `index.ts`), `backend/package.json` and `pnpm-lock.yaml` (htmlparser2). No migration.

## 1. What was built and why

`POST /api/onboarding/import-site` is the route `docs/handover.md` (line 939) names for Dev 1: "Crawl a website or Google profile into draft KB entries". The Day 7 list had it as a P1 ("single-page website import into draft KB entries", if time allows); the other two P1s were done (interiors and salon packs, #219 and #220; media download, #213) and this one carried forward. This is the single-page version, for a web page only (not a Google profile, not a crawl).

A web page is a document like an upload, from another source:

1. The page is fetched on the server, safely (`kb/fetch-page.ts`).
2. Its readable text and title are taken out (`kb/html-text.ts`, on htmlparser2).
3. It is stored as a `kb_documents` row of type `website` (with `source_url`), `processing`, with the text.
4. The same ingest job as an upload (`kb-ingest`) chunks, embeds and publishes it. `ingest.ts` now accepts `website` as well as `upload`.

Imported pages are searchable as soon as they are processed, like uploads. The owner can delete a page from the documents list (the existing delete already handles it).

**Fetching, safely.** The business picks the address, so the server must not be turned against itself or its neighbours.
- Only http and https, only the normal ports (80, 443), no user name or password in the address.
- No private, loopback, link-local, cloud-metadata, CGNAT, multicast or IPv6-internal address, in any way of writing it (numeric forms like `2130706433` and `0x7f000001` are normalised first). No `localhost`, `.local`, `.internal`, `.lan` names, and no name without a dot.
- Checked for the address given, for every redirect, and for every address a name resolves to at the moment of connecting (so a name that later points somewhere private, DNS rebinding, is refused too).
- At most 3 redirects, 15 seconds in all, 2 MB, HTML only, a 200 answer only. No compression is asked for (nothing to decompress), no cookies or credentials are sent, no JavaScript is run, a clear user agent is sent (`PakkaAgent-KnowledgeImport/1`).

**Reading the page.** It keeps the page's title and main text and drops scripts, styles, menus, footers, sidebars, forms, hidden parts, dialogs and cookie banners. It uses only `<main>` or `<article>` when that holds enough text. The title is the `<title>`, then the og:title, then the first `<h1>`, then the address.

**A finding worth knowing:** htmlparser2 slows down about with the square of the nesting depth. I measured 50,000 nested levels at 4 to 10 seconds, and 2 MB of unclosed `<div>` would block the API for minutes. So a page nested deeper than 512 levels, or with more than 100,000 elements, is refused as soon as it is seen ("built in a way we can't read"), by stopping the parser from inside its own callbacks. Real pages are nested dozens of levels deep.

## 2. How to test

- `pnpm --filter @pakka/backend exec vitest run src/kb src/server/kb-import-route.test.ts src/server/audit-coverage.test.ts` and `pnpm --filter @pakka/types exec vitest run src/kb-import.test.ts`.
- Then, for every workspace, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:conversations`.
- The tests use a fake HTTP layer and a fake resolver: no real website, model or embedding call is made. The real connection layer (Node's http client with the address guard) is covered with fakes only.
- By hand with a token: `POST {API}/api/onboarding/import-site` with `{"url":"https://<a public page>"}`; then watch the document in the Knowledge documents list go from processing to ready.

## 3. Decisions

- **Route name:** the one the handover and the screen contract already give (`/api/onboarding/import-site`), so both the onboarding wizard and the Knowledge screen can call it.
- **No migration.** `source_type` and `source_url` already exist on `kb_documents`. There is no unique index on the address, so a re-import finds the page by business plus address and updates the oldest; if two exist (two imports at once) the oldest keeps the page and the others are deleted.
- **A re-import replaces, in the same document:** new title and text, `processing` again, error cleared; the job replaces the old chunks. It gets its own event id (`kb_website_imported:<document>:<time>`), because Inngest would drop an event whose id it has already seen. A re-import is refused while that page is still processing (an earlier job could otherwise mark the old text ready and the new text would never be read).
- **While a page is re-processed** (seconds) its answers pause, because search reads only `ready` documents.
- **Imported pages are live once processed.** No review step (that needs a new status, so a migration).
- **Credits: none.** Credits are charged only by `notify.send` for messages sent; nothing is sent here, and the knowledge-base upload route spends none either. There is no feature key for the knowledge base, so no `isEnabled` check.
- **Limits:** 20 imports per business per hour (counted from the audit log's `kb.website_imported` rows), and the 100-document cap counts new pages (a re-import at the cap is fine).
- **htmlparser2 12.0.0** (exact, backend only) rather than a hand-written scanner.
- **The audit row** is `kb.website_imported` with `{ replaced, host }`: the site's name, never the page's address (it can carry a query string).
- **Nothing of the page, its address or the network's words is logged or returned.** Refusals use the fixed messages below.

## 4. Notes for Dev 2 (Shaaz)

- **htmlparser2 12.0.0 was added to the backend; run `pnpm install` after pulling main.**
- **I import `isPublicAddress`, `safeLookup`, `Resolver` and `RefusedAddressError` from your `outbound-webhooks/transport.ts`** for the address guard. I did not copy or edit that file. If you change what `isPublicAddress` blocks, the new tests in `kb/fetch-page.test.ts` (every blocked address type) will tell you what depends on it. Your name pattern (`LOCAL_NAMES`) is not exported, so `fetch-page.ts` has a small copy; exporting yours would remove it.
- **One line added to `backend/src/server/audit-coverage.test.ts` to list the new `POST /api/onboarding/import-site` route (the shared test requires every write route to be listed). No other change to that file.** The audit row is written by `kb/website.ts` through `lib/audit.ts`.
- Credits and `notify.send`: not touched.

## 5. Notes for Dev 3 (Dhatri)

- **htmlparser2 12.0.0 was added to the backend; run `pnpm install` after pulling main.**
- **One line added to `NO_BROWSER_CALLER` in `frontend/lib/api/backend-routes.test.ts` (your OK): `"POST /api/onboarding/import-site": "Website import screen not connected yet (Dev 3)"`. Remove it, and list the call in `FRONTEND_CALLS`, when a screen calls the route.** Nothing else in that file changed.

**Who can call it.** Owner and admin only. Staff get 403 `forbidden`, "Only an owner or admin can import a web page.", before anything is fetched, so hide or disable the control for staff.

**Which screens.** Both are meant to call it: `docs/handover.md` lists "website/Google profile import" as a step of the onboarding wizard (and the exit test says a new business "imports its website"), and `docs/dashboard-screen-contracts.md` lists `POST /api/onboarding/import-site` under the Knowledge screen's "website sync". Neither calls it yet: `features/knowledge/knowledge-screen.tsx` says it has no button, and the onboarding e2e says the step shows nothing "found". Only the Google profile half of the handover line is not built.

**Synchronous or a job.** The route answers **202** at once, after fetching and reading the page (a few seconds at most, up to 15), with `status: "processing"`. The page is then chunked and embedded by the same background job as an upload. The screen learns it became ready or failed from the **documents list it already has** (`kb_documents`: `id, title, source_type, status, created_at`; the contract says the dashboard watches it through Realtime and polls while a row is `processing`). If the screen polls, every 3 seconds is sensible, stopping at `ready` or `failed`; a page is normally ready in seconds, and one that never finishes is failed by a sweep after 30 minutes, so after about 2 minutes you can say "still processing". A `failed` row has a plain reason in its `error` column. Imported pages appear in that list with `source_type = 'website'`.

**The limits** (also in `WEBSITE_IMPORT_LIMITS`):
- One page only; the address is http or https, with no user name or password, on the normal web ports only (no port number in practice).
- No private or internal address: a private network, `localhost`, `.internal`, `.local` and names without a dot are refused, and so is a redirect to one.
- At most 3 redirects, 15 seconds, 2 MB. HTML only (a PDF, image or other file is refused: tell the owner to upload it under Documents).
- Too little text (under 150 characters, usually a page built by JavaScript or mostly pictures) and too much text are refused.
- 20 imports per business per hour; 100 documents per business.
- Nothing about the page is ever shown back except its title.

**What comes back when the page is empty, blocked or unreachable.** Nothing is stored and nothing is started: an error answer (below), never a 202. An empty or very short page is 422 with the "very little text" message. A blocked address is 422 with the "isn't allowed" message. An unreachable site, a timeout, or a 5xx from the site is 502.

**Every error** (the envelope is `{ error: { code, message, fields? } }`; for 422 the same message is in `fields.url`, so show it under the address box):

| HTTP | Code | Message (exact) |
|---|---|---|
| 401 | `unauthenticated` | Your session has ended. Sign in again. |
| 403 | `no_membership` | Your account isn't linked to a business yet. |
| 403 | `forbidden` (staff) | Only an owner or admin can import a web page. |
| 422 | `validation_failed` (body) | Check the address and try again. (`fields.url`: Enter the full address of the page, for example https://www.example.com/about.; any other key in the body, such as `tenantId`, is named in `fields` as "That is not something this form takes.") |
| 422 | `validation_failed` | Enter the full address of the page, for example https://www.example.com/about. |
| 422 | `validation_failed` | The address must start with http:// or https://. |
| 422 | `validation_failed` | Leave the user name and password out of the address. |
| 422 | `validation_failed` | Use a normal web address, without a port number. |
| 422 | `validation_failed` | That address isn't allowed: it points to a private or internal network. Use your website's public address. |
| 422 | `validation_failed` | That page answered with an error (404). Check the address, or make sure the page is public. (any 4xx except 429; the number changes) |
| 422 | `validation_failed` | That address isn't a web page. To add a PDF or document, upload it under Documents. |
| 422 | `validation_failed` | That page is too large (over 2 MB) to import. |
| 422 | `validation_failed` | That address redirects too many times. |
| 422 | `validation_failed` | We found very little text on that page. It may need JavaScript to show its content, or be mostly images. Try another page, or add the details as a FAQ. |
| 422 | `validation_failed` | That page has too much text for the knowledge base. |
| 422 | `validation_failed` | That page is built in a way we can't read. Try another page, or add the details as a FAQ. |
| 422 | `validation_failed` | You can keep up to 100 documents. Delete one you no longer need, then import again. |
| 409 | `conflict` | This page is still being processed from the last import. Try again in a minute. |
| 429 | `rate_limited` | You've imported a lot of pages in the last hour. Try again later. |
| 502 | `upstream_failed` | We couldn't open that page. Check the address and that the site is online, then try again. |
| 502 | `upstream_failed` | That page took too long to answer. Try again in a moment. |
| 502 | `upstream_failed` | That site answered with an error (503). Try again in a moment. (any 5xx or 429 from the site; the number changes) |
| 502 | `upstream_failed` | We couldn't start processing this page. Try again in a moment. |
| 500 | `internal` | Something went wrong on our side. Try again in a moment. |

**Credits: none.** The import costs the business nothing.

**What it does to existing knowledge-base content.** Other documents (uploads, FAQs, other pages) are untouched. Importing the same address again (a `#fragment` or a capital letter in the host does not make it a different address; a different path or query does) replaces that page's old content in its own document and never duplicates it. A re-import is refused with the 409 above while that page is still processing; a page whose last import failed can be imported again. If the new page cannot be read, the old content stays exactly as it was.

**The shared types**, with the exact import:

```ts
import { ImportSiteRequest, ImportedWebsite, WEBSITE_IMPORT_LIMITS } from "@pakka/types";
import type { ImportSiteRequest as ImportSiteBody, ImportedWebsite as ImportedPage } from "@pakka/types"; // the types have the same names as the schemas
```

`ImportSiteRequest` is `{ url: string }` (strict: any other key is refused); `ImportedWebsite` is `{ id, title, sourceType: 'website', sourceUrl, status: 'processing', createdAt, replaced }`. `replaced` is true when this replaced an earlier import of the same address.

## 6. Follow-ups

- **Try one real public page on staging once the demo setup is ready (the real network layer is tested with fakes only).**
- **Review step before pages go live** (needs a migration: a draft status). Today a page is searchable as soon as it is processed.
- **Google business profile import** (the other half of the handover line).
- A failed ingest says "this file" in its `error` (those texts are shared with uploads); a page-specific wording could be added.
- Several pages (a small crawl) are not covered: this is one address at a time.
- A native speaker check is not involved (all the words here are English).
