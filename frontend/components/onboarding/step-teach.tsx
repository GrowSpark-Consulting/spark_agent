"use client";

import { StepIntro } from "@/components/onboarding/primitives";

// Importing from a website or Google Business link has no API yet (docs/dashboard-screen-contracts.md lists no import route), so this step
// reads nothing and claims nothing. The business adds its services and FAQs by hand in Knowledge once it is set up.
export function StepTeach() {
  return (
    <>
      <StepIntro title="Teach your assistant">
        Your assistant only answers from what you give it.
      </StepIntro>

      <div data-testid="import-unavailable" role="status" className="flex flex-col gap-1.5 bg-surface p-4 text-sm">
        <strong>Importing from your website isn’t available yet.</strong>
        <span className="text-neutral-700">
          Nothing is read from your website or Google Business page. Add your services, prices and common questions
          yourself in Knowledge once your account is set up; your assistant uses them as soon as they are saved.
        </span>
      </div>
    </>
  );
}
