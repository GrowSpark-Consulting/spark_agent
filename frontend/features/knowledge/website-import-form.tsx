"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ErrorState } from "@/components/shared/states";
import type { FormattedError } from "@/lib/errors";
import type { KbDocument } from "./kb-content";
import { describeImportFailure, IMPORT_NOTE, importProgress, importWebsite, SLOW_AFTER_MS, validateImportUrl, WEBSITE_IMPORT_LIMITS, type ImportResult } from "./website-import";

// "Import a web page": one form, used by the Knowledge base's Documents section and by the onboarding Teach step (the same code, so they cannot
// drift). It sends { url } to POST /api/onboarding/import-site and nothing else. The API answers at once with the page "processing"; this form then
// follows the page's own row in the documents list (`documents`, given by the screen) and says Ready or Failed only when that row does. A page
// that is still processing after about two minutes is called slow. Owners and admins import; for everyone else the form is shown off.

const limitsText = `One public page at a time, up to ${WEBSITE_IMPORT_LIMITS.maxPageBytes / (1024 * 1024)} MB, read within ${WEBSITE_IMPORT_LIMITS.timeoutSeconds} seconds.`;

export function WebsiteImportForm({
  tenantId,
  canWrite,
  documents,
  onImported,
}: {
  /** The business, when the screen knows it; the onboarding wizard may pass none and the API uses the account's only business. */
  tenantId?: string;
  canWrite: boolean;
  /** The documents the screen shows; the imported page's row is found in it by id. The accepted page must be in it as soon as `onImported` is called. */
  documents: readonly KbDocument[];
  /** Called with the accepted page, to be put in the screen's list (replacing an earlier import of the same address). */
  onImported: (result: ImportResult) => void;
}) {
  const field = useId();
  const [url, setUrl] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);
  const [notice, setNotice] = useState<FormattedError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [imported, setImported] = useState<{ id: string; replaced: boolean; run: number } | null>(null);
  const [slow, setSlow] = useState<number | null>(null);
  const inFlight = useRef(false);

  const row = imported ? documents.find((d) => d.id === imported.id) : undefined;
  // The screen puts the accepted page in `documents` at once, so a row that is not there any more was deleted: nothing more is said about it.
  const processing = row?.status === "processing";

  // About two minutes after the import was accepted, a page that is still processing is called slow.
  const run = imported?.run ?? null;
  useEffect(() => {
    if (run === null || !processing) return;
    const timer = setTimeout(() => setSlow(run), SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [run, processing]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    // The button is also off while a request is out, but Enter in the box must not send a second one, and nobody without the role sends one.
    if (inFlight.current || !canWrite) return;
    const invalid = validateImportUrl(url);
    if (invalid) {
      setAddressError(invalid);
      setNotice(null);
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    setAddressError(null);
    setNotice(null);
    try {
      const result = await importWebsite(tenantId, url);
      onImported(result);
      setImported({ id: result.document.id, replaced: result.replaced, run: Date.now() });
      setSlow(null);
    } catch (err) {
      const failure = describeImportFailure(err);
      setAddressError(failure.address);
      setNotice(failure.notice);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  const progress = imported && row ? importProgress(row, slow === imported.run ? SLOW_AFTER_MS : 0) : null;

  return (
    <form onSubmit={(e) => void submit(e)} noValidate data-testid="website-import" className="app-form" style={{ gap: "10px", minWidth: 0 }}>
      <div className="field">
        <label htmlFor={field}>Web page address</label>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "flex-start" }}>
          <input
            id={field}
            className="input"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={url}
            disabled={!canWrite || submitting}
            placeholder="https://www.example.com/about"
            aria-invalid={addressError ? true : undefined}
            aria-describedby={`${field}-hint${addressError ? ` ${field}-error` : ""}`}
            onChange={(e) => {
              setUrl(e.target.value);
              setAddressError(null);
            }}
            style={{ flex: "1 1 260px", minWidth: 0 }}
          />
          <button type="submit" className="btn btn-primary" disabled={!canWrite || submitting} data-testid="import-submit">
            {submitting ? "Importing…" : "Import page"}
          </button>
        </div>
        {addressError ? (
          <p id={`${field}-error`} className="app-field-error" role="alert" data-testid="import-url-error">
            {addressError}
          </p>
        ) : null}
        <p id={`${field}-hint`} className="app-hint" data-testid="import-hint">
          {canWrite ? limitsText : "Only an owner or admin can import a web page."}
        </p>
      </div>

      {notice ? <ErrorState compact title={notice.title} description={notice.message} /> : null}

      {progress ? (
        <p role="status" data-testid="import-progress" data-kind={progress.kind} data-replaced={imported?.replaced ? "true" : "false"} style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>
          {imported?.replaced && progress.kind === "processing" ? "Replacing this page’s earlier import. " : ""}
          {progress.text}
        </p>
      ) : null}

      <p className="app-hint" data-testid="import-note" style={{ margin: 0 }}>
        {IMPORT_NOTE}
      </p>
    </form>
  );
}
