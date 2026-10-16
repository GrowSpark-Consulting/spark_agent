import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";
import { loadLegalDocument } from "@/lib/legal/documents";

export const metadata: Metadata = { title: "Data Deletion Instructions — Spark Agent" };

// /data-deletion. Public; the text is content/legal/data-deletion.md.
export default async function DataDeletionPage() {
  return <LegalPage doc={await loadLegalDocument("data-deletion")} />;
}
