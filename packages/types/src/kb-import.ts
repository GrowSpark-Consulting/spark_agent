import { z } from "zod";

// Importing a web page into the knowledge base (docs/handover.md: POST /api/onboarding/import-site; backend/src/kb/website.ts). Owner or admin.
//   POST /api/onboarding/import-site   ImportSiteRequest → 202 ImportedWebsite
// One page. The page is fetched and read on the server; the answer comes back at once with status "processing", and the document becomes searchable (or
// fails, with a plain reason in its `error`) in the knowledge base's documents list (kb_documents, the same list uploads are in). Importing the same
// address again replaces that page's earlier content. Errors are the usual envelope; the messages are written to be shown.

/** What the importer allows: a page of at most 2 MB, read within 15 seconds, after at most 3 redirects, and 20 imports per business an hour. */
export const WEBSITE_IMPORT_LIMITS = { maxPageBytes: 2 * 1024 * 1024, timeoutSeconds: 15, maxRedirects: 3, importsPerHour: 20 } as const;

/** The body: the address of one page (http or https, no private or internal addresses; the server explains a refusal). */
export const ImportSiteRequest = z.strictObject({ url: z.string().trim().min(1).max(2000) });
export type ImportSiteRequest = z.infer<typeof ImportSiteRequest>;

/** The answer: the document that was created, or the earlier import of the same address that now holds the new page. */
export const ImportedWebsite = z.object({
  id: z.string(),
  /** The page's title, or its address when it has none. */
  title: z.string(),
  sourceType: z.literal("website"),
  /** The address as it was imported (without a #fragment). Importing the same address again replaces the earlier import. */
  sourceUrl: z.string(),
  status: z.literal("processing"),
  createdAt: z.string(),
  /** True when this replaced an earlier import of the same address (that page's old content is gone), false when it is a new document. */
  replaced: z.boolean(),
});
export type ImportedWebsite = z.infer<typeof ImportedWebsite>;
