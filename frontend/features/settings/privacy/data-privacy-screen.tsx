"use client";

import type { ContactDeletionPreview, Role } from "@pakka/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/shared/states";
import { ConfirmDialog } from "@/features/knowledge/confirm-dialog";
import { describeDeletionError, describeOutcome, fetchDeletionPreview, requestDeletion, type DeletionOutcome } from "@/lib/privacy/deletion";
import { formatError } from "@/lib/errors";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { CONTACT_LIMIT, fetchContacts, filterContacts, type ContactChoice } from "./contacts-data";

// /dashboard/settings/privacy: Data & privacy. A customer asks for their data to be deleted (DPDP); an owner or admin finds them, sees what would go,
// and confirms. GET /api/contacts/:id/deletion previews, POST (no body) deletes. The server decides who may (owner or admin), whether a booking is
// still coming up (`conflict`) and what happened; this screen says "deleted" only for a server-confirmed deleted or already_deleted, and shows the
// server's count of calendar events it could not take down. Hiding the screen from staff is a courtesy, not the protection: their calls are refused.

export function canRequestDeletion(role: Role): boolean {
  return role === "owner" || role === "admin";
}

type ContactsLoad = { state: "loading" } | { state: "ready"; contacts: ContactChoice[] } | { state: "failed"; title: string; message: string };

export function DataPrivacyScreen({ tenantId, role }: { tenantId: string; role: Role }) {
  const allowed = canRequestDeletion(role);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "28px", maxWidth: "820px", minWidth: 0, color: "var(--color-text)" }}>
      <div>
        <h1 className="app-h1">Data &amp; privacy</h1>
        <p style={{ margin: "4px 0 0", color: "var(--color-neutral-700)" }}>
          When a customer asks you to delete their data, find them here. Their chats and leads are removed and their record is scrubbed; a note of the request stays in your consent log.
        </p>
      </div>
      {allowed ? (
        <DeletionTool tenantId={tenantId} />
      ) : (
        <p className="app-notice" role="status" data-testid="privacy-staff-notice" style={{ margin: 0 }}>
          Only an owner or admin can delete a customer&apos;s data. Ask one of them to do it.
        </p>
      )}
    </div>
  );
}

function DeletionTool({ tenantId }: { tenantId: string }) {
  const [list, setList] = useState<ContactsLoad>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ContactChoice | null>(null);
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    fetchContacts(getSupabaseBrowserClient(), tenantId).then(
      (contacts) => {
        if (!cancelled) setList({ state: "ready", contacts });
      },
      (err) => {
        if (cancelled) return;
        const shown = formatError(err);
        setList({ state: "failed", title: shown.title, message: shown.message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tenantId, attempt]);

  const contacts = list.state === "ready" ? list.contacts : null;
  const shown = useMemo(() => (contacts ? filterContacts(contacts, query) : []), [contacts, query]);

  if (list.state === "loading") return <LoadingState title="Loading your customers" />;
  if (list.state === "failed") {
    return (
      <div data-testid="contacts-error">
        <ErrorState title={`${list.title}`} description={list.message} onRetry={() => (setList({ state: "loading" }), setAttempt((n) => n + 1))} />
      </div>
    );
  }
  if (list.contacts.length === 0) {
    return <EmptyState title="No customers yet" description="Customers appear here once they have messaged your business." />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      <section aria-labelledby="privacy-find" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h2 id="privacy-find" className="app-h2">
          Find the customer
        </h2>
        <label htmlFor="privacy-search" className="app-hint">
          Search by name or by part of their number
        </label>
        <input id="privacy-search" className="input" type="search" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} />
        {list.contacts.length >= CONTACT_LIMIT ? (
          <p className="app-hint" style={{ margin: 0 }}>
            Showing your {CONTACT_LIMIT} newest customers; search narrows these.
          </p>
        ) : null}
        {shown.length === 0 ? (
          <p className="app-hint" role="status" data-testid="no-match" style={{ margin: 0 }}>
            No customer matches that.
          </p>
        ) : (
          <ul data-testid="contact-list" style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {shown.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  aria-pressed={selected?.id === c.id}
                  onClick={() => setSelected(c)}
                  style={{ width: "100%", justifyContent: "flex-start", textAlign: "left" }}
                >
                  <span>{c.label}</span>
                  {c.maskedPhone ? <span className="app-hint"> · {c.maskedPhone}</span> : null}
                  {deleted.has(c.id) ? <span className="app-hint"> · deleted</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {selected ? <DeletionPanel key={selected.id} tenantId={tenantId} contact={selected} onDeleted={(id) => setDeleted((s) => new Set(s).add(id))} /> : null}
    </div>
  );
}

type PreviewLoad =
  | { state: "loading" }
  | { state: "ready"; preview: ContactDeletionPreview }
  | { state: "failed"; title: string; message: string; retryable: boolean; kind: string };

function DeletionPanel({ tenantId, contact, onDeleted }: { tenantId: string; contact: ContactChoice; onDeleted: (contactId: string) => void }) {
  const [preview, setPreview] = useState<PreviewLoad>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<DeletionOutcome | null>(null);
  const lock = useRef(false);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    fetchDeletionPreview(tenantId, contact.id, controller.signal).then(
      (p) => {
        if (!controller.signal.aborted) setPreview({ state: "ready", preview: p });
      },
      (err) => {
        if (controller.signal.aborted) return;
        const shown = describeDeletionError(err);
        setPreview({ state: "failed", title: shown.title, message: shown.message, retryable: shown.retryable, kind: shown.kind });
      },
    );
    return () => controller.abort();
  }, [tenantId, contact.id, attempt]);

  async function confirmDeletion() {
    // One request at a time: a second press while the first is out is ignored, not sent.
    if (lock.current) return;
    lock.current = true;
    try {
      const result = await requestDeletion(tenantId, contact.id);
      setOutcome(describeOutcome(result));
      setConfirming(false);
      onDeleted(contact.id);
    } catch (err) {
      // A booking may have been made since the preview; read it again so the screen shows what the server now says, then let the dialog show the refusal.
      if (describeDeletionError(err).kind === "conflict") reload();
      throw err;
    } finally {
      lock.current = false;
    }
  }

  return (
    <section aria-labelledby="privacy-delete" style={{ display: "flex", flexDirection: "column", gap: 12 }} data-testid="deletion-panel">
      <h2 id="privacy-delete" className="app-h2">
        Delete {contact.label}&apos;s data
      </h2>
      {outcome ? (
        <Outcome outcome={outcome} />
      ) : preview.state === "loading" ? (
        <LoadingState compact title="Checking what would be deleted" />
      ) : preview.state === "failed" ? (
        <div data-testid="preview-error" data-kind={preview.kind}>
          <ErrorState compact title={preview.title} description={preview.message} onRetry={preview.retryable ? reload : undefined} />
        </div>
      ) : (
        <PreviewBody preview={preview.preview} onDelete={() => setConfirming(true)} />
      )}
      {confirming && preview.state === "ready" ? (
        <ConfirmDialog
          title={`Delete ${contact.label}'s data?`}
          text={`This permanently removes ${preview.preview.conversations.toLocaleString("en-IN")} chat(s) with ${preview.preview.messages.toLocaleString("en-IN")} message(s), ${preview.preview.leads.toLocaleString("en-IN")} lead(s) and ${preview.preview.bookings.toLocaleString("en-IN")} booking(s). It cannot be undone. Their record stays, scrubbed, and a note of the request stays in your consent log. If the same number writes again, it is a new customer.`}
          confirmLabel="Delete their data"
          busyLabel="Deleting…"
          keepLabel="Keep their data"
          onConfirm={confirmDeletion}
          describeError={describeDeletionError}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </section>
  );
}

function PreviewBody({ preview, onDelete }: { preview: ContactDeletionPreview; onDelete: () => void }) {
  if (preview.deletedAt) {
    return (
      <p className="app-notice" role="status" data-testid="already-deleted" style={{ margin: 0 }}>
        <strong>This customer&apos;s data was already deleted</strong> on {new Date(preview.deletedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}. There is nothing left to remove.
      </p>
    );
  }
  const blocked = preview.upcomingBookings > 0;
  return (
    <>
      <dl className="app-facts" style={{ margin: 0 }} data-testid="preview-counts">
        <div>
          <dt>Chats</dt>
          <dd>{preview.conversations.toLocaleString("en-IN")}</dd>
        </div>
        <div>
          <dt>Messages</dt>
          <dd>{preview.messages.toLocaleString("en-IN")}</dd>
        </div>
        <div>
          <dt>Leads</dt>
          <dd>{preview.leads.toLocaleString("en-IN")}</dd>
        </div>
        <div>
          <dt>Bookings</dt>
          <dd>{preview.bookings.toLocaleString("en-IN")}</dd>
        </div>
        <div>
          <dt>Upcoming bookings</dt>
          <dd data-testid="upcoming-count">{preview.upcomingBookings.toLocaleString("en-IN")}</dd>
        </div>
      </dl>
      {blocked ? (
        <p className="app-notice" role="alert" data-testid="upcoming-blocker" style={{ margin: 0 }}>
          <strong>This customer has a booking coming up.</strong> Cancel it first (that tells them and takes it off your calendar), then delete their data.
        </p>
      ) : null}
      <div className="app-actions">
        <button type="button" className="btn btn-primary" onClick={onDelete} disabled={blocked}>
          Delete their data
        </button>
      </div>
    </>
  );
}

function Outcome({ outcome }: { outcome: DeletionOutcome }) {
  return (
    <div className="app-notice" role="status" data-testid="deletion-result" data-status={outcome.status} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <strong>{outcome.headline}</strong>
      {outcome.removed ? <span>{outcome.removed}</span> : null}
      <span data-testid="calendar-left">
        Google Calendar events taken down: {outcome.calendar.removed.toLocaleString("en-IN")}. Left for you to remove: {outcome.calendar.left.toLocaleString("en-IN")}.
      </span>
      {outcome.calendarWarning ? (
        <span role="alert" data-testid="calendar-warning">
          {outcome.calendarWarning}
        </span>
      ) : null}
    </div>
  );
}
