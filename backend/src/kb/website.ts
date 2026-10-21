import { ImportSiteRequest, WEBSITE_IMPORT_LIMITS, type ImportedWebsite, type TenantContext } from "@pakka/types";
import type { ZodError } from "zod";
import { inngest } from "../inngest/client";
import { auditQuietly, writeAudit, type AuditEntry } from "../lib/audit";
import { AppError, zodFieldErrors } from "../lib/errors";
import { requireRole } from "../lib/tenant";
import { TimeoutError, withTimeout } from "../lib/timeout";
import { chunkText } from "./chunk";
import { MAX_DOCUMENTS } from "./documents";
import { KB_UPLOAD_EVENT, kbWebsiteEventId } from "./events";
import { checkPageUrl, fetchPage, PageFetchError } from "./fetch-page";
import { htmlToText, PageTooComplexError } from "./html-text";
import { createKbStore, type KbStore } from "./store";

// POST /api/onboarding/import-site (docs/handover.md; docs/dashboard-screen-contracts.md, "Knowledge base"): one web page into the knowledge base. The page is a document
// like an upload, from another source: it is fetched safely (fetch-page.ts), reduced to its readable text (html-text.ts), stored as a `processing` document of type
// `website`, and the same ingest job as an upload (inngest/kb-ingest.ts) chunks, embeds and publishes it. It is searchable as soon as that job is done, like an upload; the owner
// can delete it from the documents list. Owner or admin only; the business comes from the verified session, never from the body. Importing the same address again puts the new
// text in that page's document (the old chunks are replaced by the job, never added to). It costs no credits: credits are charged for messages sent, and nothing is sent here.

/** A page with less readable text than this is not worth a document (it is probably built by JavaScript, or mostly pictures). */
export const MIN_PAGE_CHARS = 150;
const HOUR_MS = 3_600_000;
const SEND_TIMEOUT_MS = 10_000;

/** What the owner is told, in plain words. Each says what is wrong and what to do; none names the address that was refused or anything the network said. */
export const IMPORT_MESSAGES = {
  invalid: "Enter the full address of the page, for example https://www.example.com/about.",
  scheme: "The address must start with http:// or https://.",
  credentials: "Leave the user name and password out of the address.",
  port: "Use a normal web address, without a port number.",
  blocked: "That address isn't allowed: it points to a private or internal network. Use your website's public address.",
  unreachable: "We couldn't open that page. Check the address and that the site is online, then try again.",
  timeout: "That page took too long to answer. Try again in a moment.",
  not_html: "That address isn't a web page. To add a PDF or document, upload it under Documents.",
  too_large: "That page is too large (over 2 MB) to import.",
  redirects: "That address redirects too many times.",
  tooLittle: "We found very little text on that page. It may need JavaScript to show its content, or be mostly images. Try another page, or add the details as a FAQ.",
  tooLong: "That page has too much text for the knowledge base.",
  complex: "That page is built in a way we can't read. Try another page, or add the details as a FAQ.",
  busy: "This page is still being processed from the last import. Try again in a minute.",
  rate: "You've imported a lot of pages in the last hour. Try again later.",
  limit: `You can keep up to ${MAX_DOCUMENTS} documents. Delete one you no longer need, then import again.`,
  startFailed: "We couldn't start processing this page. Try again in a moment.",
} as const;

export interface WebsiteDeps {
  store: KbStore;
  fetchPage: (url: URL) => Promise<{ finalUrl: URL; html: string }>;
  send: (event: { id: string; name: string; data: { tenantId: string; documentId: string } }) => Promise<unknown>;
  audit: (entry: AuditEntry) => Promise<void>;
  now: () => Date;
}

const defaults = (): WebsiteDeps => ({
  store: createKbStore(),
  fetchPage: (url) => fetchPage(url),
  send: (event) => withTimeout(() => inngest.send(event), SEND_TIMEOUT_MS),
  audit: writeAudit,
  now: () => new Date(),
});

/** A refusal the owner can fix, shown under the address box. */
const addressError = (message: string) => new AppError("validation_failed", message, { url: message });

/** The body's problems, one message per field; a key that is not a setting is named as its own field. */
function bodyErrors(error: ZodError): Record<string, string> {
  const fields = zodFieldErrors(error);
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      delete fields.form;
      for (const key of issue.keys) fields[key] = "That is not something this form takes.";
    }
  }
  if (fields.url !== undefined) fields.url = IMPORT_MESSAGES.invalid;
  return fields;
}

function fetchFailure(error: unknown): AppError {
  if (!(error instanceof PageFetchError)) return new AppError("upstream_failed", IMPORT_MESSAGES.unreachable);
  switch (error.kind) {
    case "blocked":
      return addressError(IMPORT_MESSAGES.blocked);
    case "unreachable":
      return new AppError("upstream_failed", IMPORT_MESSAGES.unreachable);
    case "timeout":
      return new AppError("upstream_failed", IMPORT_MESSAGES.timeout);
    case "not_html":
      return addressError(IMPORT_MESSAGES.not_html);
    case "too_large":
      return addressError(IMPORT_MESSAGES.too_large);
    case "redirects":
      return addressError(IMPORT_MESSAGES.redirects);
    case "status": {
      const status = error.status ?? 0;
      // The site is having trouble (or asks us to slow down): try later. Anything else is about this page or this address.
      if (status >= 500 || status === 429) return new AppError("upstream_failed", `That site answered with an error (${status}). Try again in a moment.`);
      return addressError(`That page answered with an error (${status}). Check the address, or make sure the page is public.`);
    }
  }
}

/** The page's address as the parser writes it, without a #fragment: what is stored and what a second import is matched on. */
function normalised(url: URL): URL {
  const copy = new URL(url.href);
  copy.hash = "";
  return copy;
}

export async function importWebsite(context: TenantContext, body: unknown, given?: WebsiteDeps): Promise<ImportedWebsite> {
  requireRole(context, ["owner", "admin"], "import a web page");
  const deps = given ?? defaults(); // after the role check: a missing setting must not turn "forbidden" into a 500
  const tenantId = context.tenant.id;
  const { store } = deps;

  const parsed = ImportSiteRequest.safeParse(body);
  if (!parsed.success) throw new AppError("validation_failed", "Check the address and try again.", bodyErrors(parsed.error));
  const checked = checkPageUrl(parsed.data.url);
  if (!checked.ok) throw addressError(IMPORT_MESSAGES[checked.problem]);
  const address = normalised(checked.url);

  const now = deps.now();
  const recent = await store.countWebsiteImportsSince(tenantId, new Date(now.getTime() - HOUR_MS).toISOString());
  if (recent >= WEBSITE_IMPORT_LIMITS.importsPerHour) throw new AppError("rate_limited", IMPORT_MESSAGES.rate);

  const existing = await store.findWebsiteDocuments(tenantId, address.href);
  if (existing.some((doc) => doc.status === "processing")) throw new AppError("conflict", IMPORT_MESSAGES.busy);
  if (existing.length === 0 && (await store.countDocuments(tenantId)) >= MAX_DOCUMENTS) throw addressError(IMPORT_MESSAGES.limit);

  let html: string;
  try {
    ({ html } = await deps.fetchPage(address));
  } catch (error) {
    throw fetchFailure(error);
  }
  let reading: ReturnType<typeof htmlToText>;
  try {
    reading = htmlToText(html);
  } catch (error) {
    if (error instanceof PageTooComplexError) throw addressError(IMPORT_MESSAGES.complex);
    throw error;
  }
  const { title: pageTitle, text } = reading;
  if (text.length < MIN_PAGE_CHARS) throw addressError(IMPORT_MESSAGES.tooLittle);
  const title = pageTitle ?? `${address.hostname}${address.pathname === "/" ? "" : address.pathname}`;
  const content = `${title}\n${text}`;
  try {
    chunkText(content); // too long for the knowledge base is refused now, not found out by the job
  } catch {
    throw addressError(IMPORT_MESSAGES.tooLong);
  }

  let id: string;
  let createdAt: string;
  const replaced = existing.length > 0;
  if (replaced) {
    const [keep, ...copies] = existing;
    if (!(await store.replaceWebsite(tenantId, keep.id, { title, body: content }))) throw new AppError("conflict", IMPORT_MESSAGES.busy); // it started processing meanwhile
    id = keep.id;
    createdAt = keep.createdAt;
    // Two imports of one address (they ran at once): the oldest keeps the page, the others go (their chunks with them).
    for (const copy of copies) await store.deleteDocument(tenantId, copy.id).catch(() => console.error("[kb] could not remove a repeated web page import"));
  } else {
    ({ id, createdAt } = await store.insertWebsite(tenantId, { url: address.href, title, body: content }));
  }

  try {
    await deps.send({ id: kbWebsiteEventId(id, now.getTime()), name: KB_UPLOAD_EVENT, data: { tenantId, documentId: id } });
  } catch (error) {
    // The class only: the message can carry the Inngest address or key.
    const ambiguous = error instanceof TimeoutError;
    console.error(`[kb] could not start the ingest job for a web page: ${ambiguous ? "timed out" : error instanceof Error ? error.name : "unknown"}`);
    // No answer in time is not a refusal: the job may be running. The page stands as `processing`, and the sweep fails it if no job ever finishes it.
    if (!ambiguous) {
      await store.setStatus(tenantId, id, "failed", IMPORT_MESSAGES.startFailed, { onlyIf: "processing" }).catch(() => undefined);
      throw new AppError("upstream_failed", IMPORT_MESSAGES.startFailed);
    }
  }

  await auditQuietly({ tenantId, actor: context.user.id, action: "kb.website_imported", entity: "kb_document", entityId: id, diff: { replaced, host: address.hostname } }, deps.audit);
  return { id, title, sourceType: "website", sourceUrl: address.href, status: "processing", createdAt, replaced };
}
