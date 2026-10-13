"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { QR_CELLS, trialChatUrl } from "@/features/onboarding/data";
import { bizLabel, profileOf, trialCodeOf, type OnboardingState } from "@/features/onboarding/state";
import { StepIntro } from "@/components/onboarding/primitives";

export function StepTry({ s }: { s: OnboardingState }) {
  const profile = profileOf(s);
  const code = trialCodeOf(s);

  return (
    <>
      <StepIntro title="Try your assistant now">
        Message it as if you were a customer. It already knows {bizLabel(s)}.
      </StepIntro>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-6 items-start">
        <div className="flex flex-col gap-3">
          <div className="p-3.5 bg-white border-2 border-foreground w-max">
            <div
              role="img"
              aria-label="QR code for the WhatsApp test chat"
              className="grid grid-cols-[repeat(25,7px)] auto-rows-[7px]"
            >
              {QR_CELLS.map((dark, i) => (
                <span key={i} className={cn(dark ? "bg-[#111]" : "bg-white")} />
              ))}
            </div>
          </div>
          <span className="text-[13px] text-neutral-700">
            Scan with your phone camera
          </span>
        </div>

        <div className="flex flex-col gap-3">
          <div className="text-sm text-neutral-700">Or open the link on this phone</div>
          <Button
            asChild
            variant="primary"
            className="justify-start bg-whatsapp hover:bg-whatsapp active:bg-whatsapp"
          >
            <a href={trialChatUrl(code)} target="_blank" rel="noopener noreferrer">
              Open WhatsApp test chat
            </a>
          </Button>
          <div className="text-[13px] bg-surface px-3 py-2.5">
            Your code is <strong>{code}</strong>. It works on our test
            number until your own number is connected.
          </div>
          <div className="text-[13px] text-neutral-700">Try asking: {profile.tryAsk}</div>
          <div data-testid="one-trial-note" className="text-[13px] text-neutral-700">
            There is one free trial for each WhatsApp number. If the phone you use here has already started a trial, the test chat will tell you so.
          </div>
        </div>
      </div>
    </>
  );
}
