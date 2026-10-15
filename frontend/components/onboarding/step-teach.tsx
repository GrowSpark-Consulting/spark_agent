"use client";

import * as React from "react";
import { StepIntro } from "@/components/onboarding/primitives";
import { canWriteKnowledge, type KbDocument } from "@/features/knowledge/kb-content";
import { useImportedPage } from "@/features/knowledge/use-imported-page";
import { WebsiteImportForm } from "@/features/knowledge/website-import-form";
import type { ImportResult } from "@/features/knowledge/website-import";
import { resolveBrowserTenant, type BrowserTenant } from "@/lib/api/tenant";

// The Teach step: the business can give its assistant one page of its website (POST /api/onboarding/import-site), through the same form the Knowledge
// base uses. The import is accepted at once and then processed in the background, so this step says "processing" until the page's own row says
// Ready or Failed, and it never blocks Continue: a page still being read keeps going after the wizard. Anything else the assistant should know is
// added by hand in Knowledge, as before. Google Business import and a whole-site crawl are not part of this.
export function StepTeach() {
  const [tenant, setTenant] = React.useState<BrowserTenant | null>(null);
  const [accepted, setAccepted] = React.useState<{ doc: KbDocument; run: number } | null>(null);

  React.useEffect(() => {
    let live = true;
    resolveBrowserTenant().then((found) => live && setTenant(found));
    return () => {
      live = false;
    };
  }, []);

  const tenantId = tenant?.status === "ok" ? tenant.tenantId : null;
  const polled = useImportedPage(tenantId, accepted?.doc.id ?? null, accepted?.run ?? 0);
  const documents = accepted ? [polled ?? accepted.doc] : [];
  const onImported = (result: ImportResult) => setAccepted((prev) => ({ doc: result.document, run: (prev?.run ?? 0) + 1 }));

  return (
    <>
      <StepIntro title="Teach your assistant">
        Your assistant only answers from what you give it.
      </StepIntro>

      {tenant === null ? (
        <p role="status" data-testid="import-checking" className="bg-surface p-4 text-sm">
          Checking your account…
        </p>
      ) : tenant.status === "ok" ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            <strong>Import a page of your website.</strong> Your assistant reads its text and can answer from it.
          </p>
          <WebsiteImportForm tenantId={tenant.tenantId} canWrite={canWriteKnowledge(tenant.role)} documents={documents} onImported={onImported} />
        </div>
      ) : (
        <div data-testid="import-no-business" role="status" className="flex flex-col gap-1.5 bg-surface p-4 text-sm">
          <strong>{tenant.status === "choose" ? "Choose a business first." : "We can’t import a page yet."}</strong>
          <span className="text-neutral-700">
            {tenant.status === "choose"
              ? "This account belongs to more than one business. Open Knowledge in the business you want and import a page there."
              : "We couldn’t find your business just now. You can import a page from Knowledge once your account is set up."}
          </span>
        </div>
      )}

      <p className="text-sm text-neutral-700" data-testid="teach-manual">
        You can also add your services, prices and common questions yourself in Knowledge once your account is set up; your assistant uses them as soon as they are saved.
      </p>
    </>
  );
}
