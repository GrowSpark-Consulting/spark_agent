import { ImportedWebsite, ImportSiteRequest, WEBSITE_IMPORT_LIMITS } from "@pakka/types";
import { postJson } from "@/lib/api/client";
import { isRouteMissing } from "@/lib/api/route-missing";
import { formatError, type FormattedError } from "@/lib/errors";
import { KB_UNAVAILABLE_TEXT, KB_UNAVAILABLE_TITLE, KbDataError, KbUnavailableError, toKbDocument, type KbDocument } from "./kb-content";

// Importing one web page into the knowledge base: POST /api/onboarding/import-site (backend/src/kb/website.ts; packages/types/src/kb-import.ts;
// docs/task-notes/2026-10-15-feat-kb-website-import.md). Owner or admin. One public page per request, not a crawl.
//   * The body is { url } only; the answer is parsed with the shared ImportedWebsite before it is used.
//   * The API answers 202 once it has fetched and read the page: the page is then processed by the same job as an upload. The document
//     list (kb_documents) is where it turns ready or failed, with its reason in `error`. Nothing here says "imported" before that.
//   * Importing the same address again replaces that page's document (the same id): the list is updated in place, never doubled.
//   * The business is named by X-Pakka-Tenant when the page knows it; the onboarding wizard may pass none, and the API then uses the
//     account's only business.
//   * Every error is the API's own envelope. Its messages are written to be shown, and a 422 repeats its message in fields.url.

export { WEBSITE_IMPORT_LIMITS };

/** About two minutes after the import was accepted a page that is still processing is called slow. */
export const SLOW_AFTER_MS = 120_000;

/** What the address box says is missing, before anything is sent. The server decides everything else (private addresses, ports, size). */
export const EMPTY_ADDRESS = "Enter the full address of the page, for example https://www.example.com/about.";

/** Why an address can't be sent, or null. The API checks again and explains its own refusals under the same box. */
export function validateImportUrl(text: string): string | null {
  return ImportSiteRequest.safeParse({ url: text }).success ? null : EMPTY_ADDRESS;
}

export interface ImportResult {
  /** The document as the list shows it: the page, "processing". */
  document: KbDocument;
  /** This replaced an earlier import of the same address. */
  replaced: boolean;
}

/** POST /api/onboarding/import-site. Throws what the API threw, or KbUnavailableError when the route is not deployed, or KbDataError for an unreadable answer. */
export async function importWebsite(tenantId: string | undefined, url: string): Promise<ImportResult> {
  const body = ImportSiteRequest.safeParse({ url });
  if (!body.success) throw new ImportAddressError();
  let answer: unknown;
  try {
    answer = await postJson<unknown>("/api/onboarding/import-site", body.data, tenantId ? { tenantId } : {});
  } catch (err) {
    // A route this server does not have answers 404 not_found / 501 not_available; nothing was imported.
    throw isRouteMissing(err) ? new KbUnavailableError() : err;
  }
  const parsed = ImportedWebsite.safeParse(answer);
  if (!parsed.success) throw new KbDataError("website import");
  const page = parsed.data;
  return {
    replaced: page.replaced,
    document: toKbDocument({
      id: page.id,
      tenant_id: tenantId ?? "",
      source_type: page.sourceType,
      source_url: page.sourceUrl,
      title: page.title,
      status: page.status,
      error: null,
      created_at: page.createdAt,
    }),
  };
}

/** The address failed the check before anything was sent. */
export class ImportAddressError extends Error {
  constructor() {
    super(EMPTY_ADDRESS);
    this.name = "ImportAddressError";
  }
}

export interface ImportFailure {
  /** Shown under the address box: the API's `fields.url`, or the address check's own words. */
  address: string | null;
  /** Everything else, for a notice beside the button. Null when the address box says it all. */
  notice: FormattedError | null;
}

/** How a refusal reads. 401, 403, 409, 422, 429, 502 and 500 keep the API's own words; nothing raw is shown. */
export function describeImportFailure(err: unknown): ImportFailure {
  if (err instanceof ImportAddressError) return { address: EMPTY_ADDRESS, notice: null };
  const title = "Couldn't import the page";
  if (err instanceof KbUnavailableError) {
    return { address: null, notice: { code: "not_available", title: KB_UNAVAILABLE_TITLE, message: KB_UNAVAILABLE_TEXT, retryable: false } };
  }
  if (err instanceof KbDataError) {
    return {
      address: null,
      notice: { code: "internal", title, message: "We couldn't read the answer. Check the documents list to see whether the page was added.", retryable: false },
    };
  }
  const shown = formatError(err);
  const address = shown.code === "validation_failed" ? (shown.fields?.url ?? null) : null;
  // A 422 about the address is shown under the box only; a 422 about something else (the 100-document limit) is a notice.
  return { address, notice: address ? null : { ...shown, title } };
}

// What the page's document is doing ---------------------------------------------------------------------------------

export type ImportProgress =
  /** Accepted; the list does not show the row yet, or it is processing and not yet slow. */
  | { kind: "processing"; text: string }
  | { kind: "slow"; text: string }
  | { kind: "ready"; text: string }
  | { kind: "failed"; text: string };

export const IMPORT_FAILED_FALLBACK = "The page couldn’t be read. Check the address, or add the details as a FAQ.";

/**
 * What to tell the owner about an import that was accepted. Read from the document's own status in the list (never from the 202 alone):
 * `ready` and `failed` come only from there, and a failed page says why in the server's words. Processing for `slowAfterMs` or longer is "slow".
 */
export function importProgress(doc: Pick<KbDocument, "status" | "error"> | undefined, elapsedMs: number, slowAfterMs: number = SLOW_AFTER_MS): ImportProgress {
  if (doc?.status === "ready") return { kind: "ready", text: "Ready. Your assistant can now answer from this page." };
  if (doc?.status === "failed") return { kind: "failed", text: doc.error ?? IMPORT_FAILED_FALLBACK };
  if (elapsedMs >= slowAfterMs) return { kind: "slow", text: "This is taking longer than usual. It keeps going in the background; check the documents list in a few minutes." };
  return { kind: "processing", text: "Reading the page. Your assistant can use it once it is processed." };
}

/** Said under the form: what an imported page does, and what it does not yet. */
export const IMPORT_NOTE =
  "Imports one public page at a time, not a whole site, and it costs no credits. Once a page is processed your assistant can use it straight away; there is no review step yet. Importing the same address again replaces that page.";
