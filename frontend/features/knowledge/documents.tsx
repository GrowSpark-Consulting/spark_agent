"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/shared/states";
import { ApiError, formatError, type FormattedError } from "@/lib/errors";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { ConfirmDialog } from "./confirm-dialog";
import { FlashStatus, useFlash } from "./flash";
import {
  deleteDocument,
  describeKbWriteError,
  DOCUMENT_FAILED_FALLBACK,
  DOCUMENT_LIMIT,
  DOCUMENT_STATUS_TEXT,
  documentLimitReached,
  documentMeta,
  explainNotFound,
  hasProcessing,
  KB_UNAVAILABLE_TITLE,
  KbUnavailableError,
  listKbDocuments,
  uploadDocument,
  upsertDocument,
  type DocumentStatus,
  type KbDocument,
} from "./kb-content";
import { UploadDialog } from "./upload-dialog";
import { type ImportResult } from "./website-import";
import { WebsiteImportForm } from "./website-import-form";
import { useDocumentWatch } from "./use-document-watch";

// "Documents", ported from the /dashboard/preview Knowledge base (features/knowledge/pakka-knowledge.tsx):
// title over a 2px ink rule with a ghost Upload, then a grid of file tiles (ink label block, name,
// one line of detail on --color-surface), each with its status: Processing, Ready or Failed.
//
// Reads the business's kb_documents under RLS. Upload (POST /api/kb/documents, multipart) and Delete
// (DELETE /api/kb/documents/:id) go through the API, owners and admins only. An upload is accepted for
// processing, not finished: the tile shows Processing until Realtime or polling sees it ready or
// failed. A failed tile shows kb_documents.error as the server wrote it and offers Upload again and
// Delete (the file isn't kept, so there is no retry). A business keeps at most 100 documents: at the
// limit Upload is off until one is deleted. The prototype's "sent 62 times" counts describe files sent
// to customers, a different feature, and are not shown. Once a write finds the document routes aren't deployed yet, the section
// says so and Upload and Delete are switched off (kb-content.ts, "Not deployed yet").

type ListState = { status: "loading" } | { status: "error"; error: FormattedError } | { status: "ready"; documents: KbDocument[] };
type DialogState = { kind: "none" } | { kind: "upload" } | { kind: "delete"; doc: KbDocument };

const CHIP: Record<DocumentStatus, { border: string; color: string }> = {
  processing: { border: "var(--color-divider)", color: "var(--color-neutral-700)" },
  ready: { border: "var(--color-text)", color: "var(--color-text)" },
  failed: { border: "var(--color-accent)", color: "var(--color-accent-700)" },
};

export function Documents({ tenantId, timeZone, canWrite }: { tenantId: string; timeZone: string; canWrite: boolean }) {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [dialog, setDialog] = useState<DialogState>({ kind: "none" });
  /** Set once a write finds the document routes aren't deployed; the list (an RLS read) still shows. */
  const [writesUnavailable, setWritesUnavailable] = useState(false);
  const [toast, flash] = useFlash();
  // Bumped by every local change, so a read that started before it can't put back what it replaced.
  const changes = useRef(0);

  const load = useCallback(() => {
    const at = changes.current;
    return listKbDocuments(getSupabaseBrowserClient(), tenantId).then(
      (documents) => {
        if (at === changes.current) setList({ status: "ready", documents });
      },
      (err: unknown) => setList({ status: "error", error: formatError(err) }),
    );
  }, [tenantId]);

  /** A background re-read while something processes: a failure keeps the list as it is. */
  const refresh = useCallback(async () => {
    const at = changes.current;
    try {
      const documents = await listKbDocuments(getSupabaseBrowserClient(), tenantId);
      if (at === changes.current) setList((prev) => (prev.status === "ready" ? { status: "ready", documents } : prev));
    } catch {
      // Tried again on the next poll or change.
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const documents = list.status === "ready" ? list.documents : [];
  const watch = useDocumentWatch(tenantId, hasProcessing(documents), refresh);

  function retry() {
    setList({ status: "loading" });
    void load();
  }

  const close = useCallback(() => setDialog({ kind: "none" }), []);

  /** A refused write: a 404 for a document that's still listed means the route isn't deployed. */
  async function writeFailed(err: unknown, id: string | null): Promise<never> {
    const explained = id
      ? await explainNotFound(err, async () => (await listKbDocuments(getSupabaseBrowserClient(), tenantId)).some((d) => d.id === id))
      : err;
    if (explained instanceof KbUnavailableError) setWritesUnavailable(true);
    throw explained;
  }

  async function upload(file: File, title: string) {
    const doc = await uploadDocument(tenantId, file, title).catch((err: unknown) => {
      // upstream_failed: the document was saved, then marked failed when its job couldn't start. Show it.
      if (err instanceof ApiError && err.body.error.code === "upstream_failed") void refresh();
      return writeFailed(err, null);
    });
    changes.current += 1;
    setList((prev) => (prev.status === "ready" ? { ...prev, documents: upsertDocument(prev.documents, doc) } : prev));
    setDialog({ kind: "none" });
    flash(doc.status === "processing" ? `${doc.name} is processing` : `${doc.name}: ${DOCUMENT_STATUS_TEXT[doc.status]}`);
  }

  /** A web page the API accepted: put in the list at once (an earlier import of the same address has the same id, so it is replaced, not doubled). */
  function pageImported({ document, replaced }: ImportResult) {
    changes.current += 1;
    setList((prev) => (prev.status === "ready" ? { ...prev, documents: upsertDocument(prev.documents, document) } : prev));
    flash(`${document.name} is processing${replaced ? " (replaces the earlier import)" : ""}`);
  }

  async function remove(doc: KbDocument) {
    await deleteDocument(tenantId, doc.id).catch((err: unknown) => writeFailed(err, doc.id));
    changes.current += 1;
    setList((prev) => (prev.status === "ready" ? { ...prev, documents: prev.documents.filter((d) => d.id !== doc.id) } : prev));
    setDialog({ kind: "none" });
    flash(`Deleted ${doc.name}`);
  }

  const atLimit = documentLimitReached(documents);
  const uploadOff = !canWrite || writesUnavailable || list.status !== "ready" || atLimit;

  return (
    <section aria-labelledby="documents-heading" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderBottom: "2px solid var(--color-text)", paddingBottom: "8px", gap: "12px" }}>
        <h2 id="documents-heading" style={{ margin: "0", fontSize: "13px", letterSpacing: ".08em", textTransform: "uppercase" }}>
          Documents{list.status === "ready" ? ` · ${documents.length}` : ""}
        </h2>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setDialog({ kind: "upload" })}
          disabled={uploadOff}
          aria-describedby={canWrite && writesUnavailable ? "documents-upload-note documents-unavailable" : "documents-upload-note"}
        >
          Upload
        </button>
      </div>
      <p id="documents-upload-note" className="app-hint" style={{ margin: 0 }}>
        {!canWrite
          ? "Only an owner or admin can upload or delete documents."
          : atLimit
            ? `You have ${DOCUMENT_LIMIT} documents, the most a business can keep. Delete one to upload another.`
            : "PDF, Word (.docx), text or Markdown, up to 5 MB. The AI uses a document once it’s ready."}
      </p>

      <WebsiteImportForm tenantId={tenantId} canWrite={canWrite && !writesUnavailable && list.status === "ready"} documents={documents} onImported={pageImported} />

      {canWrite && writesUnavailable ? (
        <div id="documents-unavailable">
          <EmptyState compact title={KB_UNAVAILABLE_TITLE} description="The knowledge-base service is still being connected, so documents can’t be uploaded or deleted yet." />
        </div>
      ) : null}

      {list.status === "loading" ? <LoadingState compact title="Loading documents" /> : null}
      {list.status === "error" ? (
        <ErrorState compact title="Couldn't load your documents" description={list.error.message} onRetry={retry} />
      ) : null}
      {list.status === "ready" && documents.length === 0 ? (
        <EmptyState compact title="No documents yet" description="Documents added to your knowledge base appear here." />
      ) : null}

      {watch.state === "stalled" ? (
        <div style={{ display: "flex", gap: "8px 12px", flexWrap: "wrap", alignItems: "center", fontSize: "13px", color: "var(--color-neutral-700)" }}>
          <span>Still processing. This can take a few minutes for a long document.</span>
          <button type="button" className="btn btn-secondary" onClick={watch.checkAgain}>
            Check again
          </button>
        </div>
      ) : null}

      {documents.length > 0 ? (
        <ul aria-label="Documents" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(240px,100%),1fr))", gap: "12px" }}>
          {documents.map((d) => (
            <li key={d.id} style={{ display: "flex", gap: "12px", alignItems: "flex-start", padding: "14px", background: "var(--color-surface)", minWidth: 0 }}>
              <span aria-hidden="true" style={{ width: "36px", height: "44px", background: "var(--color-text)", color: "var(--color-bg)", fontSize: "10px", fontWeight: "800", display: "grid", placeItems: "center", flex: "none" }}>
                {d.label}
              </span>
              <span style={{ minWidth: "0", flex: "1", display: "flex", flexDirection: "column", gap: "6px" }}>
                <span>
                  <span title={d.name} style={{ display: "block", fontWeight: "600", fontSize: "14px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {d.name}
                  </span>
                  <span style={{ fontSize: "12px", color: "var(--color-neutral-700)" }}>{documentMeta(d, timeZone)}</span>
                </span>
                <span style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                  <span
                    data-status={d.status}
                    style={{ fontSize: "11px", fontWeight: "600", padding: "3px 8px", border: `1px solid ${CHIP[d.status].border}`, color: CHIP[d.status].color, whiteSpace: "nowrap" }}
                  >
                    {DOCUMENT_STATUS_TEXT[d.status]}
                  </span>
                  {d.status === "failed" ? <span style={{ fontSize: "12px", color: "var(--color-neutral-700)" }}>{d.error ?? DOCUMENT_FAILED_FALLBACK}</span> : null}
                  {canWrite && d.status === "failed" ? (
                    <button type="button" className="btn btn-ghost" style={{ padding: "2px 6px", marginLeft: "auto" }} aria-label={`Upload ${d.name} again`} disabled={uploadOff} onClick={() => setDialog({ kind: "upload" })}>
                      Upload again
                    </button>
                  ) : null}
                  {canWrite ? (
                    <button type="button" className="btn btn-ghost" style={{ padding: "2px 6px", marginLeft: d.status === "failed" ? 0 : "auto" }} aria-label={`Delete ${d.name}`} disabled={writesUnavailable} onClick={() => setDialog({ kind: "delete", doc: d })}>
                      Delete
                    </button>
                  ) : null}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {dialog.kind === "upload" ? <UploadDialog onUpload={upload} onClose={close} /> : null}
      {dialog.kind === "delete" ? (
        <ConfirmDialog
          title={`Delete ${dialog.doc.name}?`}
          text="The AI stops using what’s in it. This can’t be undone."
          confirmLabel="Delete document"
          busyLabel="Deleting…"
          keepLabel="Keep it"
          onConfirm={() => remove(dialog.doc)}
          describeError={(err) => describeKbWriteError(err, "Couldn't delete the document", "document")}
          onClose={close}
        />
      ) : null}
      <FlashStatus toast={toast} />
    </section>
  );
}
