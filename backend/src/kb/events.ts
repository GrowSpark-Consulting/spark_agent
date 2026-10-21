import { z } from "zod";

/** Sent when an upload has been stored and its text is waiting to be chunked and embedded. */
export const KB_UPLOAD_EVENT = "kb/document.uploaded";

/** Ids only (docs/contracts.md, section 5): never text, names or numbers. */
export const KbUploadedData = z.object({ tenantId: z.guid(), documentId: z.guid() });
export type KbUploadedData = z.infer<typeof KbUploadedData>;

/**
 * A web page's import: the same event, but its id carries the moment of the import, because importing an address again puts new text in the SAME document and
 * Inngest would drop an event whose id it has already seen (the id of an upload is one per document).
 */
export const kbWebsiteEventId = (documentId: string, importedAtMs: number) => `kb_website_imported:${documentId}:${importedAtMs}`;

/** The fixed event id: Inngest drops a second event with the same id, so one upload starts one job. */
export const kbUploadEventId = (documentId: string) => `kb_document_uploaded:${documentId}`;
