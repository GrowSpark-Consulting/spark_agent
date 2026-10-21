"use client";

import { useCallback, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { listKbDocuments, type KbDocument } from "./kb-content";
import { useDocumentWatch } from "./use-document-watch";

/**
 * For a screen that has no documents list of its own (the onboarding Teach step): follows the imported page's row in kb_documents with the same
 * watcher the Knowledge base uses (use-document-watch.ts: one Realtime channel, with its polling as the fallback, both stopped once the page is
 * ready or failed, or after the polling window). Returns the row as last read, or undefined until one is.
 * `run` counts imports: importing the same address again keeps the id, so a row read for the earlier import must not stand for the new one.
 */
export function useImportedPage(tenantId: string | null, id: string | null, run: number): KbDocument | undefined {
  const [read, setRead] = useState<{ id: string; run: number; row: KbDocument } | undefined>(undefined);
  const current = read?.id === id && read.run === run ? read : undefined;
  const refresh = useCallback(async () => {
    if (!tenantId || !id) return;
    const row = (await listKbDocuments(getSupabaseBrowserClient(), tenantId)).find((d) => d.id === id);
    if (row) setRead({ id, run, row });
  }, [tenantId, id, run]);
  // Watching from the moment the import is accepted until its row says ready or failed.
  useDocumentWatch(tenantId ?? "", tenantId !== null && id !== null && (current === undefined || current.row.status === "processing"), refresh);
  return current?.row;
}
