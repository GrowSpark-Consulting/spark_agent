import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";
import { loadLegalDocument } from "@/lib/legal/documents";

export const metadata: Metadata = { title: "Privacy Policy — Spark Agent" };

// /privacy. Public; the text is content/legal/privacy.md.
export default async function PrivacyPage() {
  return <LegalPage doc={await loadLegalDocument("privacy")} />;
}
