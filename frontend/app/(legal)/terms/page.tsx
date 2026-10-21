import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";
import { loadLegalDocument } from "@/lib/legal/documents";

export const metadata: Metadata = { title: "Terms of Service — Spark Agent" };

// /terms. Public; the text is content/legal/terms.md.
export default async function TermsPage() {
  return <LegalPage doc={await loadLegalDocument("terms")} />;
}
