"use client";

import type { Role } from "@pakka/types";
import { useCallback, useEffect, useState } from "react";
import { formatError } from "@/lib/errors";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { ConfirmDialog } from "./confirm-dialog";
import { Documents } from "./documents";
import { FaqFormDialog } from "./faq-form-dialog";
import { FaqList } from "./faq-list";
import { recoverGapAnswer, saveFaqEdit, type KbNotice } from "./faq-recovery";
import { FlashStatus, useFlash } from "./flash";
import { GapsList } from "./gaps-list";
import {
  answerGap,
  canAnswerGaps,
  canWriteKnowledge,
  createFaq,
  deleteFaq,
  describeKbWriteError,
  dismissGap,
  explainNotFound,
  KbUnavailableError,
  listFaqs,
  listGaps,
  updateFaq,
  upsertFaq,
  type FaqInput,
  type FaqItem,
  type GapItem,
  type SectionSource,
} from "./kb-content";
import { ServicesEditor } from "./services-editor";

// The real Knowledge base page: the /dashboard/preview screen's header and sections, in the
// prototype's order (features/knowledge/pakka-knowledge.tsx: 42px title, 36px between sections, 960px
// of content). Services and documents are owned by their sections; FAQs and unanswered questions live
// here because answering a question adds an FAQ. FAQs are an RLS read; questions come from
// GET /api/kb/gaps; every write goes through the API (kb-content.ts) and changes the list only after
// it answers. Owners and admins write; every member, staff too, can answer a question. While the KB
// routes aren't deployed, a section says so (kb-content.ts, "Not deployed yet") instead of failing.
// A FAQ the AI can't use yet (its embedding failed) is retried by saving it again, and an answer that
// was stored but not embedded is found by reading both lists again (faq-recovery.ts).
// Website import (POST /api/onboarding/import-site, Dev 1) is the "Import a web page" form in Documents (website-import-form.tsx), one page at a time.

/** A section's state; Try again is attached when rendering. */
type Loaded<T> = Exclude<SectionSource<T>, { status: "error" }> | { status: "error"; message: string };
type FaqDialog = { kind: "none" } | { kind: "form"; faq: FaqItem | null } | { kind: "delete"; faq: FaqItem } | { kind: "dismiss"; gap: GapItem };

const faqsFailed = (err: unknown): Loaded<FaqItem> => ({ status: "error", message: formatError(err).message });
const gapsFailed = (err: unknown): Loaded<GapItem> =>
  err instanceof KbUnavailableError ? { status: "unavailable" } : { status: "error", message: formatError(err).message };

export function KnowledgeScreen({ tenantId, timeZone, role }: { tenantId: string; timeZone: string; role: Role }) {
  const canWrite = canWriteKnowledge(role);
  const [faqs, setFaqs] = useState<Loaded<FaqItem>>({ status: "loading" });
  /** Set once an FAQ write finds the FAQ routes aren't deployed; the list (an RLS read) still shows. */
  const [faqWritesUnavailable, setFaqWritesUnavailable] = useState(false);
  const [gaps, setGaps] = useState<Loaded<GapItem>>({ status: "loading" });
  const [dialog, setDialog] = useState<FaqDialog>({ kind: "none" });
  /** An answer that was stored but not embedded (or may have been): how to retry it from the FAQs. */
  const [gapNotice, setGapNotice] = useState<KbNotice | null>(null);
  const [toast, flash] = useFlash();

  const loadFaqs = useCallback(
    () =>
      listFaqs(getSupabaseBrowserClient(), tenantId).then(
        (items) => setFaqs({ status: "ready", items }),
        (err: unknown) => setFaqs(faqsFailed(err)),
      ),
    [tenantId],
  );

  const loadGaps = useCallback(
    (signal?: AbortSignal) =>
      listGaps(tenantId, signal).then(
        (items) => setGaps({ status: "ready", items }),
        (err: unknown) => {
          if (signal?.aborted) return;
          setGaps(gapsFailed(err));
        },
      ),
    [tenantId],
  );

  useEffect(() => {
    const abort = new AbortController();
    void loadFaqs();
    void loadGaps(abort.signal);
    return () => abort.abort();
  }, [loadFaqs, loadGaps]);

  const faqItems = faqs.status === "ready" ? faqs.items : [];
  const retryFaqs = () => {
    setFaqs({ status: "loading" });
    void loadFaqs();
  };
  const retryGaps = () => {
    setGaps({ status: "loading" });
    void loadGaps();
  };
  const faqSource: SectionSource<FaqItem> = faqs.status === "error" ? { ...faqs, retry: retryFaqs } : faqs;
  const gapSource: SectionSource<GapItem> = gaps.status === "error" ? { ...gaps, retry: retryGaps } : gaps;
  const close = useCallback(() => setDialog({ kind: "none" }), []);
  const addToFaqs = (faq: FaqItem) => setFaqs((prev) => (prev.status === "ready" ? { ...prev, items: upsertFaq(prev.items, faq) } : prev));
  const dropGap = (id: string) => setGaps((prev) => (prev.status === "ready" ? { ...prev, items: prev.items.filter((g) => g.id !== id) } : prev));

  async function saveFaq(editing: FaqItem | null, input: FaqInput) {
    if (editing) {
      // Compared with the FAQ as listed now: a refused save may have re-read it since the dialog opened.
      const current = faqItems.find((f) => f.id === editing.id) ?? editing;
      const sent = await saveFaqEdit(current, input, {
        update: (changes) => updateFaq(tenantId, current.id, changes).catch((err: unknown) => faqWriteFailed(err, current.id)),
        show: addToFaqs,
        refresh: loadFaqs,
      });
      setDialog({ kind: "none" });
      if (!sent) return;
      setGapNotice(null);
      flash("Saved the FAQ");
    } else {
      addToFaqs(await createFaq(tenantId, input).catch((err: unknown) => faqWriteFailed(err, null)));
      setDialog({ kind: "none" });
      flash("Added to FAQs");
    }
  }

  /**
   * A refused FAQ write, before the dialog shows it. A 404 for an FAQ that's still listed means the
   * route isn't deployed (explainNotFound), and the section then says so. upstream_failed leaves the
   * row stored as failed (contracts.md section 9), so the list is read again to show it.
   */
  async function faqWriteFailed(err: unknown, id: string | null): Promise<never> {
    const explained = id ? await explainNotFound(err, async () => (await listFaqs(getSupabaseBrowserClient(), tenantId)).some((f) => f.id === id)) : err;
    if (explained instanceof KbUnavailableError) setFaqWritesUnavailable(true);
    if (formatError(explained).code === "upstream_failed") void loadFaqs();
    throw explained;
  }

  /** A refused answer or dismissal: a 404 for a question the API still lists means the route is missing. */
  async function gapWriteFailed(err: unknown, id: string): Promise<never> {
    throw await explainNotFound(err, async () => (await listGaps(tenantId)).some((g) => g.id === id));
  }

  async function removeFaq(faq: FaqItem) {
    await deleteFaq(tenantId, faq.id).catch((err: unknown) => faqWriteFailed(err, faq.id));
    setFaqs((prev) => (prev.status === "ready" ? { ...prev, items: prev.items.filter((f) => f.id !== faq.id) } : prev));
    setDialog({ kind: "none" });
    flash("Deleted the FAQ");
  }

  async function answer(gap: GapItem, a: string) {
    setGapNotice(null);
    let faq: FaqItem;
    try {
      faq = await answerGap(tenantId, gap.id, a);
    } catch (err) {
      // upstream_failed: the answer may be stored as a failed FAQ, with the question closed. The lists
      // are read again; if it was stored, a notice says how to retry it and the answer form closes.
      const notice = await recoverGapAnswer(err, gap, {
        canWriteFaqs: canWrite,
        gaps: { read: () => listGaps(tenantId), ready: (items) => setGaps({ status: "ready", items }), failed: (e) => setGaps(gapsFailed(e)) },
        faqs: { read: () => listFaqs(getSupabaseBrowserClient(), tenantId), ready: (items) => setFaqs({ status: "ready", items }), failed: (e) => setFaqs(faqsFailed(e)) },
      });
      if (notice) return setGapNotice(notice);
      return gapWriteFailed(err, gap.id);
    }
    addToFaqs(faq);
    dropGap(gap.id);
    flash("Added to FAQs");
  }

  async function dismiss(gap: GapItem) {
    await dismissGap(tenantId, gap.id).catch((err: unknown) => gapWriteFailed(err, gap.id));
    setGapNotice(null);
    dropGap(gap.id);
    setDialog({ kind: "none" });
    flash("Dismissed the question");
  }

  return (
    // 960px: the prototype's 1040px included its own 40px side padding, which .app-main gives here.
    <div style={{ display: "flex", flexDirection: "column", gap: "36px", maxWidth: "960px", minWidth: 0, color: "var(--color-text)" }}>
      <div>
        <h1 className="app-h1">Knowledge base</h1>
        <p style={{ margin: "4px 0 0", color: "var(--color-neutral-700)" }}>What customers can book, how long it takes and what it costs.</p>
      </div>
      <GapsList source={gapSource} canAnswer={canAnswerGaps(role)} canDismiss={canWrite} notice={gapNotice} onAnswer={answer} onDismiss={(gap) => setDialog({ kind: "dismiss", gap })} />
      <ServicesEditor tenantId={tenantId} />
      <FaqList
        source={faqSource}
        canWrite={canWrite}
        writesUnavailable={faqWritesUnavailable}
        onAdd={() => setDialog({ kind: "form", faq: null })}
        onEdit={(faq) => setDialog({ kind: "form", faq })}
        onDelete={(faq) => setDialog({ kind: "delete", faq })}
      />
      <Documents tenantId={tenantId} timeZone={timeZone} canWrite={canWrite} />

      {dialog.kind === "form" ? <FaqFormDialog faq={dialog.faq} existing={faqItems} onSave={(input) => saveFaq(dialog.faq, input)} onClose={close} /> : null}
      {dialog.kind === "delete" ? (
        <ConfirmDialog
          title="Delete this FAQ?"
          text={`“${dialog.faq.q}” The AI stops using this answer. This can’t be undone.`}
          confirmLabel="Delete FAQ"
          busyLabel="Deleting…"
          keepLabel="Keep it"
          onConfirm={() => removeFaq(dialog.faq)}
          describeError={(err) => describeKbWriteError(err, "Couldn't delete the FAQ", "FAQ")}
          onClose={close}
        />
      ) : null}
      {dialog.kind === "dismiss" ? (
        <ConfirmDialog
          title="Dismiss this question?"
          text={`“${dialog.gap.question}” It leaves this list without an answer being added.`}
          confirmLabel="Dismiss question"
          busyLabel="Dismissing…"
          keepLabel="Keep it"
          onConfirm={() => dismiss(dialog.gap)}
          describeError={(err) => describeKbWriteError(err, "Couldn't dismiss the question", "question")}
          onClose={close}
        />
      ) : null}
      <FlashStatus toast={toast} />
    </div>
  );
}
